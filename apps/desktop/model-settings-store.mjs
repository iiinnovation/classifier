import { lstat, readFile, writeFile, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../api/src/http.mjs'

const empty = () => ({ url: '', model: '', key: '' })
const clone = value => structuredClone(value)
const warning = '记住的连接无法读取，原设置仍保留。可使用会话连接，或清除后重新设置。'

// Only the main process receives the OS encryptor. The protected file belongs
// to the application profile, outside every research library and its backups.
export async function createModelSettingsStore(profile, protection, io = {}) {
  const fs = { lstat, readFile, writeFile, open, rename, unlink, ...io }
  const path = join(profile, 'model-settings.json')
  let configuration = { text: empty(), vision: empty() }, remember = false, issue = '', broken = false
  let queue = Promise.resolve()
  let canRemember = false
  try { canRemember = Boolean(await protection.available()) } catch { /* Session connections remain usable without OS credential access. */ }
  const metadata = () => ({ remember, canRemember, credentialProtection: protection.name, settingsWarning: issue })
  async function readSaved() {
    try {
      const entry = await fs.lstat(path)
      if (!entry.isFile() || entry.size > 64 * 1024) throw new Error('Invalid settings file')
      const value = JSON.parse(await fs.readFile(path, 'utf8'))
      if (value.version !== 1 || !value.text || Object.keys(value).some(key => !['version', 'text'].includes(key)) || Object.keys(value.text).some(key => !['url', 'model', 'encryptedKey'].includes(key)) ||
        typeof value.text.url !== 'string' || value.text.url.length > 2000 || typeof value.text.model !== 'string' || !value.text.model.trim() || value.text.model.length > 200 ||
        typeof value.text.encryptedKey !== 'string' || value.text.encryptedKey.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.text.encryptedKey)) throw new Error('Invalid settings format')
      const endpoint = new URL(value.text.url)
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol) || endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Invalid endpoint')
      if (!canRemember) throw new Error('Protected storage unavailable')
      const credential = JSON.parse(await protection.decrypt(Buffer.from(value.text.encryptedKey, 'base64')))
      if (credential.url !== value.text.url || credential.model !== value.text.model) throw new Error('Credential identity changed')
      const key = credential.key
      if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\u0000]/.test(key)) throw new Error('Invalid credential')
      configuration.text = { url: endpoint.href, model: value.text.model, key }; remember = true
    } catch (error) {
      if (error.code !== 'ENOENT') { broken = true; issue = warning }
    }
  }
  await readSaved()
  function serialized(work) {
    const task = queue.catch(() => {}).then(work)
    queue = task
    return task
  }
  async function syncProfile() {
    if (process.platform === 'win32') return
    const handle = await fs.open(profile, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  async function removeSaved() {
    try { await fs.unlink(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await syncProfile()
  }
  async function saveProtected(text) {
    if (!canRemember) throw new HttpError(409, '系统凭据保护不可用，请使用会话连接。')
    if (broken) throw new HttpError(409, '记住的设置无法安全读取，请先清除，再重新记住连接。')
    let encrypted
    try { encrypted = await protection.encrypt(JSON.stringify({ url: text.url, model: text.model, key: text.key })) }
    catch { throw new HttpError(409, '系统凭据保护失败，未记住连接。可使用会话连接。') }
    const temporary = path + '.' + randomUUID() + '.tmp'
    const bytes = JSON.stringify({ version: 1, text: { url: text.url, model: text.model, encryptedKey: encrypted.toString('base64') } })
    if (Buffer.byteLength(bytes) > 64 * 1024) throw new HttpError(413, '记住的连接设置超过大小上限，未保存。请使用会话连接或检查所填内容。')
    try {
      const entry = await fs.lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (entry && !entry.isFile()) throw new Error('Unsafe settings path')
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      const handle = await fs.open(temporary, 'r')
      try { await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, path); await syncProfile()
    } catch { throw new HttpError(503, '记住连接的写入未确认，当前连接未切换。请重试或清除记住的连接。') }
    finally { await fs.unlink(temporary).catch(() => {}) }
  }
  return {
    snapshot: () => ({ ...clone(configuration), ...metadata() }),
    metadata,
    idle: () => queue.catch(() => {}),
    update(next, options = {}) {
      return serialized(async () => {
        if (options.remember) await saveProtected(next.text)
        else if (!broken) {
          try { await removeSaved() }
          catch { throw new HttpError(503, '清除记住的连接未确认，当前连接未切换。请重试。') }
        }
        configuration = clone(next); remember = Boolean(options.remember)
        if (!broken) issue = ''
        return metadata()
      })
    },
    revoke(scope = 'all') {
      return serialized(async () => {
        if (scope !== 'vision') { configuration.text = empty(); remember = false }
        if (scope !== 'text') configuration.vision = empty()
        if (scope !== 'vision') {
          try { await removeSaved(); issue = ''; broken = false }
          catch { issue = '本次配置已清除，但记住的设置清除未确认，退出重开可能恢复。请重试清除。'; throw new HttpError(503, issue) }
        }
        return metadata()
      })
    },
    clear() { return this.revoke('text') },
  }
}
