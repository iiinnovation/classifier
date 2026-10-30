import { createSettingsProvider } from '../api/src/settings.mjs'
import { HttpError } from '../api/src/http.mjs'

// Mutations are persisted over the private parent channel. Revocation is applied
// immediately to existing task signals, including a save waiting on the OS vault.
export function createPersistentSettingsProvider(initial, request) {
  const runtime = createSettingsProvider(initial)
  let meta = { remember: Boolean(initial.remember), canRemember: Boolean(initial.canRemember), credentialProtection: initial.credentialProtection, settingsWarning: initial.settingsWarning || '' }
  let queue = Promise.resolve(), authorizationEpoch = 0
  const serialize = work => {
    const task = queue.catch(() => {}).then(work); queue = task; return task
  }
  return {
    read: () => ({ ...runtime.read(), ...meta }),
    update(value, options = {}) {
      if (options.clear) {
        authorizationEpoch++
        runtime.update({ text: {} })
        meta = { ...meta, remember: false }
      }
      const epoch = authorizationEpoch
      return serialize(async () => {
        if (epoch !== authorizationEpoch) throw new HttpError(409, '授权已撤销，请重新填写并启用连接。')
        const next = { text: value.text || runtime.read().text, vision: value.vision || runtime.read().vision }
        let result
        try { result = await request(options.clear ? 'clear' : 'update', { configuration: next, remember: options.remember ?? meta.remember }) }
        catch (error) { if (options.clear) meta = { ...meta, settingsWarning: error.message }; throw error }
        if (epoch !== authorizationEpoch) throw new HttpError(409, '保存期间授权已撤销，旧连接未重新启用。')
        if (!options.clear) runtime.update(value)
        meta = result
        return this.read()
      })
    },
    revoke(scope = 'all') {
      if (scope !== 'vision') authorizationEpoch++
      runtime.revoke(scope)
      if (scope !== 'vision') meta = { ...meta, remember: false }
      return serialize(async () => {
        try { meta = await request('revoke', { scope }); return this.read() }
        catch (error) { meta = { ...meta, settingsWarning: error.message }; throw error }
      })
    },
  }
}
