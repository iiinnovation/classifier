import { HttpError } from './http.mjs'

// A connection check never reads a library, creates a research task, or includes
// user material. Responses and upstream errors are not copied into diagnostics.
export async function testModelConnection(configuration, { signal, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const controller = new AbortController(), started = Date.now()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    combined.throwIfAborted()
    const response = await fetchImpl(configuration.url, { method: 'POST', redirect: 'error', signal: combined,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.key}` },
      body: JSON.stringify({ model: configuration.model, messages: [{ role: 'user', content: 'This is a synthetic connection test. Reply only with OK.' }], max_tokens: 32, stream: false }),
    })
    combined.throwIfAborted()
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const message = response.status === 401 || response.status === 403 ? '模型服务拒绝认证，请核对 API Key 和访问权限。' : response.status === 402 ? '模型服务额度不足，请检查账户余额或配额。' : response.status === 404 ? '未找到模型接口，请检查完整的接口地址。' : response.status === 429 ? '模型服务当前限流或额度不足，请稍后重试。' : response.status >= 500 ? '模型服务暂时不可用，请稍后重试。' : `模型服务返回 HTTP ${response.status}，请核对接口地址和模型名称。`
      throw new HttpError(422, message)
    }
    const chunks = [], reader = response.body?.getReader()
    let size = 0
    if (!reader) throw new HttpError(422, '模型服务返回空响应，请核对接口地址。')
    try {
      while (true) {
        const part = await reader.read(); combined.throwIfAborted()
        if (part.done) break
        size += part.value.byteLength
        if (size > 64 * 1024) throw new HttpError(422, '测试响应超出预期，请核对是否为对话接口。')
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(422, '接口未返回有效的对话结果，请核对完整地址。') }
    const message = Array.isArray(value.choices) ? value.choices[0]?.message : null
    if (![message?.content, message?.reasoning_content].some(text => typeof text === 'string' && text.trim())) throw new HttpError(422, '接口未返回对话文字，请核对模型和接口类型。')
    return { state: 'passed', checkedAt: new Date().toISOString(), durationMs: Date.now() - started }
  } catch (error) {
    if (timedOut) throw new HttpError(422, '连接测试超时，请检查服务或稍后重试。')
    if (combined.aborted) throw new HttpError(409, '连接测试已停止，配置或授权可能已变化。')
    if (error.status) throw error
    throw new HttpError(422, '无法连接模型服务，请检查地址、网络和服务状态。')
  } finally { clearTimeout(timer) }
}
