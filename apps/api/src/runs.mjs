import { randomUUID } from 'node:crypto'
import { answerQuestion } from './qa.mjs'
import { HttpError } from './http.mjs'
import { evidenceVersion } from './evidence.mjs'

export function createRuns(store, qaOptions = {}) {
  const active = new Map()
  async function start(documentId, question, metadata = {}) {
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    const document = await store.document(documentId)
    // Recheck after disk read so concurrent requests cannot exceed this limit.
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    return startJob({ documentId, documentTitle: document.title, documentVersion: evidenceVersion(document), ...metadata, question }, options => answerQuestion(document, question, { ...qaOptions, ...options }))
  }
  async function startJob(metadata, work) {
    if (active.size >= 3) throw new HttpError(429, '当前任务较多，请稍后重试。')
    const run = { ...metadata, id: randomUUID(), status: 'queued', events: [], createdAt: new Date().toISOString() }
    const controller = new AbortController()
    active.set(run.id, controller)
    try { await store.write('runs', run) }
    catch (error) { active.delete(run.id); throw error }
    const initial = structuredClone(run)
    void execute(run, work, controller).catch(error => console.error('Run persistence failed:', error.message))
    return initial
  }
  async function execute(run, work, controller) {
    const timer = setTimeout(() => controller.abort(new Error('问答超过 90 秒，请缩小问题范围后重试。')), 90_000)
    try {
      run.status = 'running'
      await store.write('runs', run)
      run.result = await work({
        signal: controller.signal,
        onEvent: async event => {
          run.events.push({ ...event, at: new Date().toISOString() })
          await store.write('runs', run)
        },
      })
      controller.signal.throwIfAborted()
      run.status = 'completed'
    } catch (error) {
      delete run.result
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'
      run.error = error.message
    } finally {
      clearTimeout(timer)
      run.finishedAt = new Date().toISOString()
      try { await store.write('runs', run) } finally { active.delete(run.id) }
    }
  }
  return {
    start, startJob,
    cancel(id) {
      const controller = active.get(id)
      if (controller) controller.abort(new Error('用户已取消本次问答。'))
      return Boolean(controller)
    },
    stop() { for (const controller of active.values()) controller.abort(new Error('服务正在关闭。')) },
  }
}
