import { randomUUID } from 'node:crypto'
import { answerQuestion } from './qa.mjs'
import { HttpError } from './http.mjs'
import { evidenceVersion } from './evidence.mjs'
import { environmentSettings, taskSettings } from './settings.mjs'

export function createRuns(store, qaOptions = {}, settingsProvider = environmentSettings()) {
  const active = new Map()
  const activePurposes = new Map()
  const tasks = new Set()
  let stopping = false
  async function start(documentId, question, metadata = {}, configuration = taskSettings(settingsProvider, qaOptions)) {
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    const document = await store.document(documentId)
    // Recheck after disk read so concurrent requests cannot exceed this limit.
    if (active.size >= 3) throw new HttpError(429, '当前问答任务较多，请稍后重试。')
    return startJob({ documentId, documentTitle: document.title, documentVersion: evidenceVersion(document), ...metadata, question, configurationRevision: configuration.revision }, options => answerQuestion(document, question, { ...qaOptions, config: configuration.text, ...options }))
  }
  async function startJob(metadata, work, { timeoutMs = 90_000, purposeLimit } = {}) {
    if (stopping) throw new HttpError(503, '服务正在关闭。')
    if (purposeLimit && [...activePurposes.values()].filter(purpose => purpose === metadata.purpose).length >= purposeLimit) throw new HttpError(429, '同类研究任务较多，请稍后重试。')
    if (active.size >= 3) throw new HttpError(429, '当前任务较多，请稍后重试。')
    const run = { ...metadata, id: randomUUID(), status: 'queued', events: [], createdAt: new Date().toISOString() }
    const controller = new AbortController()
    active.set(run.id, controller)
    activePurposes.set(run.id, metadata.purpose)
    const finished = Promise.withResolvers()
    tasks.add(finished.promise)
    const release = () => { tasks.delete(finished.promise); finished.resolve() }
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
      try { await store.write('runs', run) } finally { active.delete(run.id); activePurposes.delete(run.id) }
    }
  }
  return {
    start, startJob,
    cancel(id) {
      const controller = active.get(id)
      if (controller) controller.abort(new Error('用户已取消本次问答。'))
      return Boolean(controller)
    },
    async stop() { stopping = true; for (const controller of active.values()) controller.abort(new Error('服务正在关闭。')); await Promise.allSettled([...tasks]) },
  }
}
