import { modelConfig } from './qa.mjs'

const config = value => Object.freeze({ url: value?.url || '', key: value?.key || '', model: value?.model || '' })
const snapshot = (value, revision, authorization = value.authorization) => Object.freeze({ revision, text: config(value.text), vision: config(value.vision), authorization })

function createAuthorization() {
  const controllers = { text: new AbortController(), vision: new AbortController() }
  return {
    read: () => Object.freeze({ text: controllers.text.signal, vision: controllers.vision.signal }),
    grant(value) {
      for (const kind of ['text', 'vision']) if (value[kind]?.url && value[kind]?.key && controllers[kind].signal.aborted) controllers[kind] = new AbortController()
    },
    revoke(scope) {
      for (const kind of scope === 'all' ? ['text', 'vision'] : [scope]) {
        controllers[kind].abort(new Error('模型数据授权已撤销，本次任务已停止。'))
      }
    },
  }
}

// Revocation reaches snapshots captured before an awaited record read or queued
// write. Ordinary settings updates preserve the existing authorization epoch.
export function bindTaskAuthorization(controller, signal) {
  if (!signal) return () => {}
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return () => signal.removeEventListener('abort', abort)
}

// Desktop uses an injected provider. The environment adapter is explicit in the
// development server; no configuration or credentials are stored in task JSON.
export function createSettingsProvider(initial = {}) {
  const authorization = createAuthorization()
  let current = snapshot(initial, 1, authorization.read())
  return {
    read: () => current,
    update(value) { authorization.grant(value); current = snapshot({ ...current, ...value }, current.revision + 1, authorization.read()); return current },
    revoke(scope = 'all') {
      if (!['text', 'vision', 'all'].includes(scope)) throw new Error('无效的模型授权范围。')
      authorization.revoke(scope)
      current = snapshot({ ...current, ...(scope !== 'vision' ? { text: {} } : {}), ...(scope !== 'text' ? { vision: {} } : {}) }, current.revision + 1, authorization.read())
      return current
    },
  }
}
export function environmentSettings(env = process.env) {
  const authorization = createAuthorization()
  let override = null, revision = 0
  const read = () => snapshot(override || { text: modelConfig(env), vision: { url: env.CLASSIFIER_VISION_API_URL, key: env.CLASSIFIER_VISION_API_KEY, model: env.CLASSIFIER_VISION_MODEL } }, revision, authorization.read())
  return {
    read, update(value) { authorization.grant(value); override = { ...read(), ...value }; revision++ },
    revoke(scope = 'all') {
      if (!['text', 'vision', 'all'].includes(scope)) throw new Error('无效的模型授权范围。')
      authorization.revoke(scope)
      override = { ...read(), ...(scope !== 'vision' ? { text: {} } : {}), ...(scope !== 'text' ? { vision: {} } : {}) }
      revision++
      return read()
    },
  }
}
export function taskSettings(provider, qaOptions = {}) {
  const value = provider.read()
  return snapshot({ ...value, text: value.authorization?.text.aborted ? {} : qaOptions.config || value.text }, value.revision)
}
