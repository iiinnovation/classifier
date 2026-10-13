export function createClientStorage({ persistent, session, desktop } = {}) {
  if (!desktop?.sessionId) return { persistent, session, drafts: session, ownerId: null }
  const prefix = `classifier-desktop-session:v1:${desktop.sessionId}:`
  const keys = () => Object.keys(persistent).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
  const methods = {
    getItem: key => persistent.getItem(prefix + key),
    setItem: (key, value) => persistent.setItem(prefix + key, String(value)),
    removeItem: key => persistent.removeItem(prefix + key),
    key: index => keys()[index] ?? null,
    clear: () => keys().forEach(key => persistent.removeItem(prefix + key)),
  }
  const drafts = new Proxy({}, {
    get: (_target, key) => key === 'length' ? keys().length : methods[key] || (typeof key === 'string' ? methods.getItem(key) : undefined),
    ownKeys: keys,
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })
  return { persistent, session, drafts, ownerId: `desktop:${desktop.sessionId}` }
}
