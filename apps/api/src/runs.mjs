import { randomUUID } from 'node:crypto'
import { answerQuestion, modelConfigured } from './qa.mjs'
import { HttpError } from './http.mjs'
import { evidenceVersion } from './evidence.mjs'
import { environmentSettings, taskSettings, bindTaskAuthorization } from './settings.mjs'
import { encodeRecord } from './record-integrity.mjs'

export function createRuns(store, qaOptions = {}, settingsProvider = environmentSettings()) {
  const active = new Map()
  const activePurposes = new Map()
  const tasks = new Set()
  const jobTasks = new Map()
  let stopping = false
  async function start(documentId, question, metadata = {}, configuration = taskSettings(settingsProvider, qaOptions)) {
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    const document = await store.document(documentId)
    // Recheck after disk read so concurrent requests cannot exceed this limit.
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    return startJob({ documentId, documentTitle: document.title, documentVersion: evidenceVersion(document), ...metadata, question, configurationRevision: configuration.revision }, options => answerQuestion(document, question, { ...qaOptions, config: configuration.text, ...options }), { authorizationSignal: modelConfigured(configuration.text) ? configuration.authorization?.text : undefined })
  }
  async function startJob(metadata, work, { timeoutMs = 90_000, purposeLimit, authorizationSignal } = {}) {
    if (stopping) throw new HttpError(503, '服务正在关闭。')
    if (purposeLimit && [...activePurposes.values()].filter(purpose => purpose === metadata.purpose).length >= purposeLimit) throw new HttpError(429, '同类研究任务较多，请稍后重试。')
    if (active.size >= 3) throw new HttpError(429, '当前任务较多，请稍后重试。')
    const run = { ...metadata, id: randomUUID(), status: 'queued', events: [], createdAt: new Date().toISOString() }
    const controller = new AbortController()
    const unbind = bindTaskAuthorization(controller, authorizationSignal)
    active.set(run.id, controller)
    activePurposes.set(run.id, metadata.purpose)
    const finished = Promise.withResolvers()
    tasks.add(finished.promise)
    jobTasks.set(run.id, finished.promise)
    const release = () => { unbind(); tasks.delete(finished.promise); jobTasks.delete(run.id); finished.resolve() }
    try { await store.write('runs', run) }
    catch (error) { active.delete(run.id); activePurposes.delete(run.id); release(); throw error }
    const initial = structuredClone(run)
    const task = execute(run, work, controller, timeoutMs)
    void task.finally(release).catch(error => console.error('Run persistence failed:', error.message))
    return initial
  }
  async function execute(run, work, controller, timeoutMs) {
    const timer = setTimeout(() => controller.abort(new Error('任务超时，请缩小范围后重试。')), timeoutMs)
    try {
      run.status = 'running'
      await store.write('runs', run)
      controller.signal.throwIfAborted()
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
      try {
        try { await store.write('runs', run) }
        catch (error) {
          if (error.status !== 413) throw error
          // Keep the last persisted trace and a readable terminal state when a
          // generated result or event would exceed the saved-record limit.
          const saved = await store.read('runs', run.id)
          delete run.result
          run.events = [...(saved?.events || [])]
          run.status = controller.signal.aborted ? 'cancelled' : 'failed'
          run.error = controller.signal.aborted ? controller.signal.reason?.message || error.message : error.message
          // A previously saved trace can be close to the cap. Leave room for
          // the failure message and finish timestamp, trimming only its tail.
          while (run.events.length) {
            try { encodeRecord(run, true); break }
            catch (size) { if (size.status !== 413) throw size; run.events.pop() }
          }
          await store.write('runs', run)
        }
      } finally { active.delete(run.id); activePurposes.delete(run.id) }
    }
  }
  return {
    start, startJob,
    cancel(id) {
      const controller = active.get(id)
      if (controller) controller.abort(new Error('用户已取消本次问答。'))
      return Boolean(controller)
    },
    async cancelAndWait(ids) {
      const pending = ids.map(id => jobTasks.get(id)).filter(Boolean)
      for (const id of ids) active.get(id)?.abort(new Error('删除相关资料，已停止本次任务。'))
      await Promise.all(pending)
    },
    async stop() { stopping = true; for (const controller of active.values()) controller.abort(new Error('服务正在关闭。')); await Promise.allSettled([...tasks]) },
  }
}
