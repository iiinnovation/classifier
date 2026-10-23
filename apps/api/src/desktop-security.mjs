import { timingSafeEqual } from 'node:crypto'
import { HttpError } from './http.mjs'

export const desktopOrigin = 'app://classifier'
export const instanceHeader = 'x-classifier-instance'
export function desktopRequestGuard(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Desktop instance token must be 32 random bytes encoded as hex.')
  const secret = Buffer.from(token)
  return (request, address) => {
    const received = request.headers[instanceHeader]
    const candidate = Buffer.from(typeof received === 'string' ? received : '')
    if (candidate.length !== secret.length || !timingSafeEqual(candidate, secret)) throw new HttpError(401, '工作台实例认证失败，请从应用打开。')
    if (!address || request.headers.host !== `127.0.0.1:${address.port}`) throw new HttpError(403, '工作台请求地址无效。')
    if (request.headers.origin !== desktopOrigin) throw new HttpError(403, '请从当前桌面工作台发起请求。')
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new HttpError(403, '仅接受本机工作台连接。')
  }
}
