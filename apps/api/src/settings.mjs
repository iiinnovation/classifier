import { modelConfig } from './qa.mjs'

const config = value => Object.freeze({ url: value?.url || '', key: value?.key || '', model: value?.model || '' })
const snapshot = (value, revision) => Object.freeze({ revision, text: config(value.text), vision: config(value.vision) })

// Desktop uses an injected provider. The environment adapter is explicit in the
// development server; no configuration or credentials are stored in task JSON.
export function createSettingsProvider(initial = {}) {
  let current = snapshot(initial, 1)
  return {
    read: () => current,
    update(value) { current = snapshot({ ...current, ...value }, current.revision + 1); return current },
  }
}
export function environmentSettings(env = process.env) {
  return { read: () => snapshot({ text: modelConfig(env), vision: { url: env.CLASSIFIER_VISION_API_URL, key: env.CLASSIFIER_VISION_API_KEY, model: env.CLASSIFIER_VISION_MODEL } }, 0) }
}
export function taskSettings(provider, qaOptions = {}) {
  const value = provider.read()
  return snapshot({ ...value, text: qaOptions.config || value.text }, value.revision)
}
