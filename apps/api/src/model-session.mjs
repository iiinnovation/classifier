import { HttpError } from './http.mjs'

// Runtime-only configuration. Never persist or return the credential.
export function modelSession(provider) {
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
    return { url, model: value.text.model, hasKey: Boolean(value.text.key), editable: typeof provider.update === 'function', canRevoke: typeof provider.revoke === 'function', persistence: 'session' }
  }
  function update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['url', 'model', 'key', 'clear'].includes(key))) throw new HttpError(422, '模型设置包含无效字段。')
    if (typeof provider.update !== 'function') throw new HttpError(409, '当前配置由外部管理，无法从页面修改。')
    if (body.clear === true) {
      if (Object.keys(body).length !== 1) throw new HttpError(422, '清除配置不能同时设置连接。')
      provider.update({ text: {} }); return get()
    }
    for (const [key, max] of [['url', 2000], ['model', 200], ['key', 8192]]) if (typeof body[key] !== 'string' || body[key].length > max || /[\r\n\u0000]/.test(body[key])) throw new HttpError(422, '模型地址、名称或密钥格式不正确。')
    let endpoint
    try { endpoint = new URL(body.url.trim()) } catch { throw new HttpError(422, '请输入有效的模型接口地址。') }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new HttpError(422, '模型接口使用 HTTPS，本机服务可用 HTTP；地址不能包含凭据、查询参数或片段。')
    const current = provider.read().text, model = body.model.trim(), displayedCurrentUrl = get().url
    const retainEndpoint = !body.key.trim() && endpoint.href === displayedCurrentUrl
    const url = retainEndpoint ? current.url : endpoint.href
    // A blank credential only retains a key for exactly the same endpoint.
    const key = body.key.trim() || (retainEndpoint ? current.key : '')
    if (!model || !key) throw new HttpError(422, '请输入模型名称和 API Key；更换接口地址时需要重新填写密钥。')
    provider.update({ text: { url, model, key } })
    return get()
  }
  function revoke(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'scope') || !['all', 'text', 'vision'].includes(body.scope)) throw new HttpError(422, '请选择文字、页图或全部模型授权。')
    if (typeof provider.revoke !== 'function') throw new HttpError(409, '当前配置提供器不支持撤销授权。')
    provider.revoke(body.scope)
    return { ...get(), revokedScope: body.scope }
  }
  return { get, update, revoke }
}
