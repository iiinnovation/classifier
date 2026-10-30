import { HttpError } from './http.mjs'
import { createHash } from 'node:crypto'
import { testModelConnection } from './model-connection-test.mjs'

// Runtime-only configuration. Never persist or return the credential.
export function modelSession(provider, testOptions = {}) {
  let probe = null, tested = null
  const fingerprint = value => createHash('sha256').update(JSON.stringify([value.url, value.model, value.key])).digest('hex')
  const settle = (value, done) => value?.then ? Promise.resolve(value).then(done) : done()
  function cancelTest() { probe?.abort(); tested = null }
  const get = () => {
    const value = provider.read()
    let url = ''
    try {
      const endpoint = new URL(value.text.url)
      if (['https:', 'http:'].includes(endpoint.protocol)) {
        endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''
        url = endpoint.href
      }
    } catch { /* Do not echo malformed externally supplied connection strings. */ }
    const checked = tested?.fingerprint === fingerprint(value.text) && Date.now() - tested.at < 10 * 60 * 1000
    return { url, model: value.text.model, hasKey: Boolean(value.text.key), editable: typeof provider.update === 'function', canRevoke: typeof provider.revoke === 'function', persistence: value.remember ? 'remembered' : 'session', canRemember: Boolean(value.canRemember), credentialProtection: value.credentialProtection || null, settingsWarning: value.settingsWarning || '', connectionTest: checked ? { state: 'passed', checkedAt: tested.checkedAt } : { state: 'untested' } }
  }
  function update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['url', 'model', 'key', 'clear', 'remember'].includes(key))) throw new HttpError(422, '模型设置包含无效字段。')
    if (typeof provider.update !== 'function') throw new HttpError(409, '当前配置由外部管理，无法从页面修改。')
    if (body.clear === true) {
      if (Object.keys(body).length !== 1) throw new HttpError(422, '清除配置不能同时设置连接。')
      cancelTest(); return settle(provider.update({ text: {} }, { clear: true, remember: false }), get)
    }
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new HttpError(422, '请选择是否记住连接。')
    if (body.remember === true && !provider.read().canRemember) throw new HttpError(409, '当前环境无法保护并记住密钥，请使用会话连接。')
    const text = resolve(body)
    probe?.abort()
    return settle(provider.update({ text }, { remember: body.remember ?? Boolean(provider.read().remember) }), get)
  }
  function resolve(body) {
    for (const [key, max] of [['url', 2000], ['model', 200], ['key', 8192]]) if (typeof body[key] !== 'string' || body[key].length > max || /[\r\n\u0000]/.test(body[key])) throw new HttpError(422, '模型地址、名称或密钥格式不正确。')
    let endpoint
    try { endpoint = new URL(body.url.trim()) } catch { throw new HttpError(422, '请输入有效的模型接口地址。') }
    if (endpoint.href.length > 2000) throw new HttpError(422, '模型接口地址过长，请检查所填地址。')
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new HttpError(422, '模型接口使用 HTTPS，本机服务可用 HTTP；地址不能包含凭据、查询参数或片段。')
    const current = provider.read().text, model = body.model.trim(), displayedCurrentUrl = get().url
    const retainEndpoint = !body.key.trim() && endpoint.href === displayedCurrentUrl
    const url = retainEndpoint ? current.url : endpoint.href
    // A blank credential only retains a key for exactly the same endpoint.
    const key = body.key.trim() || (retainEndpoint ? current.key : '')
    if (!model || !key) throw new HttpError(422, '请输入模型名称和 API Key；更换接口地址时需要重新填写密钥。')
    return { url, model, key }
  }
  function revoke(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'scope') || !['all', 'text', 'vision'].includes(body.scope)) throw new HttpError(422, '请选择文字、页图或全部模型授权。')
    if (typeof provider.revoke !== 'function') throw new HttpError(409, '当前配置提供器不支持撤销授权。')
    if (body.scope !== 'vision') cancelTest()
    return settle(provider.revoke(body.scope), () => ({ ...get(), revokedScope: body.scope }))
  }
  async function test(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['url', 'model', 'key'].includes(key))) throw new HttpError(422, '连接测试包含无效字段。')
    if (probe) throw new HttpError(429, '连接测试正在进行，请先停止或等待完成。')
    const text = resolve(body), controller = new AbortController()
    probe = controller; tested = null
    try {
      const result = await testModelConnection(text, { ...testOptions, signal: controller.signal })
      if (controller.signal.aborted) throw new HttpError(409, '连接测试已停止。')
      tested = { ...result, fingerprint: fingerprint(text), at: Date.now() }
      return result
    } finally { if (probe === controller) probe = null }
  }
  return { get, update, revoke, test, cancelTest }
}
