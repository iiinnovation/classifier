export function createApi({ fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  return async function api(path, options = {}) {
    const { timeoutMs: timeout = timeoutMs, ...request } = options
    const writing = !['GET', 'HEAD'].includes((request.method || 'GET').toUpperCase())
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    const error = (code, message, status = 0, requestId = null, uncertain = false) => Object.assign(new Error(uncertain ? `${message} 提交结果尚未确认，请核对已保存内容后再操作。` : message), { code, status, requestId, uncertain, retryable: !writing && ['UNAVAILABLE', 'TIMEOUT', 'BUSY'].includes(code) })
    try {
      let response
      try { response = await fetchImpl(path, { ...request, signal }) }
      catch {
        if (request.signal?.aborted) throw error('CANCELLED', '请求已取消。', 0, null, writing)
        if (timedOut) throw error('TIMEOUT', '请求超时，请稍后重试。', 0, null, writing)
        throw error('UNAVAILABLE', '暂时无法连接工作台服务。', 0, null, writing)
      }
      const requestId = response.headers.get('x-request-id')
      if (response.status === 204 && response.ok) return null
      let body
      try { body = await response.text() }
      catch {
        throw error(timedOut ? 'TIMEOUT' : request.signal?.aborted ? 'CANCELLED' : 'UNAVAILABLE', '读取服务响应失败。', response.status, requestId, writing)
      }
      let value
      const json = /(?:application\/json|\+json)(?:;|$)/i.test(response.headers.get('content-type') || '')
      if (json && body.trim()) { try { value = JSON.parse(body) } catch { /* Invalid responses are classified below. */ } }
      if (!response.ok) {
        const code = ['RECORD_CORRUPT', 'RECORD_UNAVAILABLE'].includes(value?.code) ? value.code : response.status === 409 ? 'CONFLICT' : response.status === 429 ? 'BUSY' : response.status >= 500 ? 'UNAVAILABLE' : response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION'
        const message = typeof value?.error === 'string' ? value.error : `工作台请求失败（HTTP ${response.status}），请稍后重试。`
        throw error(code, message, response.status, requestId, writing && response.status >= 500 && !['RECORD_CORRUPT', 'RECORD_UNAVAILABLE'].includes(code))
      }
      if (!json || value === undefined) throw error('INVALID_RESPONSE', '服务返回了无法识别的响应，请重新打开当前页面。', response.status, requestId, writing)
      return value
    } finally { clearTimeout(timer) }
  }
}
