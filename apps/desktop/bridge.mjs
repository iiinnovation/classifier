import { desktopOrigin, instanceHeader } from '../api/src/desktop-security.mjs'

export const applicationUrl = `${desktopOrigin}/`
export function isApplicationUrl(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.hostname === 'classifier' && !url.port && !url.username && !url.password }
  catch { return false }
}
export function createProtocolBridge({ backend, fetchImpl = (url, options) => fetch(url, options), onError = () => {} }) {
  return async request => {
    const failure = (status, error) => {
      onError({ status, message: error, path: new URL(request.url).pathname })
      return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
    if (!isApplicationUrl(request.url)) return failure(403, '不允许的应用地址。')
    const source = request.headers.get('origin')
    if (source && source !== desktopOrigin) return failure(403, '不允许的请求来源。')
    if (request.referrer && request.referrer !== 'about:client' && !isApplicationUrl(request.referrer)) return failure(403, '不允许的请求页面。')
    const url = new URL(request.url), target = backend()
    if (!target) return failure(503, '工作台服务正在启动或已断开。')
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return failure(405, '不支持的请求方法。')
    const headers = { origin: desktopOrigin, [instanceHeader]: target.token }
    for (const key of ['content-type', 'accept', 'range']) { const value = request.headers.get(key); if (value) headers[key] = value }
    try {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer())
      if (body && body.length > 25 * 1024 * 1024) return failure(413, '上传内容超过 25 MiB。')
      const response = await fetchImpl(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, { method: request.method, headers, body, signal: request.signal, redirect: 'manual' }, request)
      if (!response.ok) onError({ status: response.status, message: '本地服务返回错误。', path: url.pathname })
      if (response.status >= 300 && response.status < 400) return failure(502, '本地服务返回了不允许的重定向。')
      const output = new Headers()
      for (const key of ['content-type', 'content-disposition', 'content-security-policy', 'cache-control', 'x-request-id', 'referrer-policy', 'x-content-type-options']) {
        const value = response.headers.get(key); if (value) output.set(key, value)
      }
      return new Response(response.body, { status: response.status, headers: output })
    } catch { return failure(503, '暂时无法连接工作台服务，请稍后重试。') }
  }
}
