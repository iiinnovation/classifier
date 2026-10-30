import katex from '/katex.mjs'
import { createResearchWorkspace } from '/research.js'
import { createDeletionPreview } from '/deletion-preview.js'
import { createStorageUsage } from '/storage-usage.js'
import { createNotebook } from '/notes.js'
import { createComparisonWorkspace } from '/comparisons.js'
import { createReportWorkspace } from '/reports.js'
import { createApi } from '/api.js'
import { createClientStorage } from '/storage.js'
const $ = id => document.getElementById(id)
let selected = null
let epoch = 0
let activeRun = null
let loadingDocument = false
let pendingQuestion = null
let timer
let importing = null
let reviewPage = 1
let reviewEpoch = 0
let modelConfigured = false
let blockIndex = new Map()
let warningsLabel = '识别提醒'
let research
let notebook
let comparisonWorkspace
let reportWorkspace

const requestApi = createApi()
async function api(path, options) {
  try { return await requestApi(path, options) }
  catch (error) { if (['RECORD_CORRUPT', 'RECORD_UNAVAILABLE'].includes(error.code)) void refreshLibraryHealth(); throw error }
}
async function refreshLibraryHealth() {
  try {
    const health = await requestApi('/api/library-health')
    $('library-health').hidden = !health.issueCount
    $('library-health-summary').textContent = `有 ${health.issueCount} 项资料需要检查，其他资料可继续使用。`
    $('library-health-items').replaceChildren(...health.issues.map(item => element('li', `${item.path} · ${item.message || (item.reason === 'INTERRUPTED_WRITE' ? '中断写入副本保留，等待核对' : item.preserved ? '保全副本已保存' : '原件保留，请核对')}${item.preservationError ? ' · ' + item.preservationError : ''}`)))
  } catch { /* A health check must not block access to otherwise usable records. */ }
}
$('library-health-refresh').onclick = refreshLibraryHealth
const clientStorage = createClientStorage({ persistent: localStorage, session: typeof sessionStorage === 'undefined' ? undefined : sessionStorage, desktop: globalThis.classifierDesktop })
function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text != null) node.textContent = text
  if (className) node.className = className
  return node
}
createDeletionPreview({ api, element, async onDeleted(result) {
  const topic = research.currentTopic()
  if (result.target.bucket === 'topics' && result.target.id === topic?.id) await research.showHome()
  else if (topic) await research.showTopic(topic.id)
  else await research.refresh()
  await loadLibrary()
  research.notice(result.filePending ? '研究记录已删除；原文件清理尚未完成，重启后会重试。请从资料库菜单检查待办。' : '已完成普通删除，其他研究中的引用摘录、备份和导出副本仍保留。')
} })
createStorageUsage({ api, element, button: $('storage-usage-open') })
function jump(id) {
  const ref = selected?.references.find(ref => ref.id === id)
  if (!ref) return
  closeReferenceSearch()
  if (ref.page && selected.mediaType === 'application/pdf') {
    void showPage(ref.page, ref.bbox, ref)
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 950px)').matches) $('source-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } else {
    document.querySelectorAll('.reference.highlight').forEach(node => node.classList.remove('highlight'))
    const node = document.getElementById(`reference-${id}`)
    node?.classList.add('highlight')
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
function citations(parent, ids, references) {
  for (const id of ids) {
    const ref = references.find(ref => ref.id === id)
    const button = element('button', ref?.title || id, 'citation')
    button.type = 'button'
    button.onclick = () => jump(id)
    parent.append(button)
  }
}
function formulaNode(latex) {
  const node = element('div', null, 'math')
  try { katex.render(latex, node, { throwOnError: true, trust: false, strict: 'warn', displayMode: true, output: 'html', maxExpand: 500, maxSize: 20 }) }
  catch { node.textContent = latex; node.classList.add('notice') }
  return node
}
function structuredReference(ref) {
  const node = element('article', null, 'reference')
  node.id = `reference-${ref.id}`
  node.append(element('h3', ref.title))
  if (ref.needsReview) node.append(element('span', '识别结果 · 待核对', 'review-badge'))
  const block = blockIndex.get(ref.blockId)
  if (ref.type === 'table' && block?.rows && ref.offset === 0) {
    const wrapper = element('div', null, 'table-scroll'), table = element('table')
    const covered = new Set()
    const count = Math.max(0, ...block.rows.flat().map(cell => cell.column + cell.colSpan))
    block.rows.forEach((row, r) => {
      const tr = element('tr')
      for (let c = 0; c < count; c++) {
        if (covered.has(`${r}:${c}`)) continue
        const cell = row.find(cell => cell.column === c)
        const td = element('td', cell?.text || '')
        if (cell) {
          td.colSpan = cell.colSpan; td.rowSpan = cell.rowSpan
          for (let y = r; y < r + cell.rowSpan; y++) for (let x = c; x < c + cell.colSpan; x++) covered.add(`${y}:${x}`)
        }
        tr.append(td)
      }
      table.append(tr)
    })
    wrapper.append(table); node.append(wrapper)
  } else if (ref.type === 'formula' && ref.latex) node.append(formulaNode(ref.latex))
  else node.append(element('p', ref.text))
  if (ref.type === 'formula') {
    const details = element('details'), summary = element('summary', ref.latex ? '查看 LaTeX' : '查看识别字符')
    details.append(summary, element('pre', ref.latex || ref.text)); node.append(details)
  }
  if (ref.page && selected.mediaType === 'application/pdf') {
    const button = element('button', `核对第 ${ref.page} 页`, 'citation')
    button.onclick = () => jump(ref.id)
    node.append(button)
  }
  const save = element('button', '记入笔记', 'save-reference-note')
  save.type = 'button'; save.onclick = () => notebook.fromReference(ref)
  node.append(save)
  return node
}
async function showPage(number, bbox = null, ref = null) {
  if (!selected || selected.mediaType !== 'application/pdf') return
  const token = ++reviewEpoch
  reviewPage = Math.max(1, Math.min(number, selected.sections.length))
  $('page-review').hidden = false
  $('selected-excerpt').hidden = !ref
  if (ref) {
    const close = element('button', '×', 'excerpt-close')
    close.type = 'button'; close.setAttribute('aria-label', '收起当前引用')
    close.onclick = () => { $('selected-excerpt').hidden = true }
    $('selected-excerpt').replaceChildren(element('strong', ref.title), close, element('p', ref.text.slice(0, 360)))
    if (ref.needsReview) $('selected-excerpt').append(element('span', '识别结果 · 待核对', 'review-badge'))
    const save = element('button', '记入笔记', 'save-reference-note')
    save.type = 'button'; save.onclick = () => notebook.fromReference(ref)
    $('selected-excerpt').append(save)
  } else $('selected-excerpt').replaceChildren()
  $('page-label').textContent = `第 ${reviewPage} / ${selected.sections.length} 页`
  $('prev-page').disabled = reviewPage === 1
  $('next-page').disabled = reviewPage === selected.sections.length
  const notices = selected.warnings.filter(warning => warning.includes(`第 ${reviewPage} 页`))
  $('page-notice').hidden = !notices.length
  $('page-notice').textContent = notices.join(' ')
  $('page-error').textContent = '正在生成页图…'
  $('page-image').hidden = true
  const image = $('page-image')
  $('page-highlight').hidden = true
  image.onload = () => {
    if (token !== reviewEpoch) return
    image.hidden = false; $('page-error').textContent = ''
    if (bbox) {
      const box = $('page-highlight')
      box.style.left = `${bbox[0] * 100}%`; box.style.top = `${bbox[1] * 100}%`
      box.style.width = `${bbox[2] * 100}%`; box.style.height = `${bbox[3] * 100}%`
      box.hidden = false
      box.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
  image.onerror = () => { if (token === reviewEpoch) $('page-error').textContent = '页图暂时无法读取，请稍后重试。' }
  image.src = `/api/documents/${selected.id}/pages/${reviewPage}`
}
$('prev-page').onclick = () => showPage(reviewPage - 1)
$('next-page').onclick = () => showPage(reviewPage + 1)

function closeReferenceSearch() {
  $('reference-search').hidden = true
  $('reference-search-toggle').setAttribute('aria-expanded', 'false')
}
function renderReferenceSearch() {
  const query = $('reference-query').value.trim().toLocaleLowerCase()
  if (!selected || !query) {
    $('reference-count').textContent = '输入关键词后查找当前文档中的片段。'
    $('reference-results').replaceChildren()
    return
  }
  const matches = selected.references.filter(ref => `${ref.title} ${ref.text}`.toLocaleLowerCase().includes(query))
  $('reference-count').textContent = `找到 ${matches.length} 个片段${matches.length > 30 ? '，显示前 30 个' : ''}`
  $('reference-results').replaceChildren(...matches.slice(0, 30).map(ref => {
    const button = element('button', null, 'reference-result')
    button.type = 'button'
    button.append(element('strong', ref.title), element('span', ref.text.slice(0, 150)))
    if (ref.needsReview) button.append(element('small', '待核对'))
    button.onclick = () => jump(ref.id)
    return button
  }))
}
$('reference-search-toggle').onclick = () => {
  const opening = $('reference-search').hidden
  $('reference-search').hidden = !opening
  $('reference-search-toggle').setAttribute('aria-expanded', String(opening))
  if (opening) { renderReferenceSearch(); $('reference-query').focus() }
}
$('reference-query').oninput = renderReferenceSearch

function renderRun(run) {
  const box = element('article')
  box.id = `run-${run.id}`
  box.append(element('p', run.question, 'question-text'))
  const answer = element('div', null, 'answer')
  if (run.result) {
    const result = run.result
    if (result.mode === 'model') {
      for (const [claimIndex, claim] of result.claims.entries()) {
        const p = element('p')
        p.append(element('span', claim.kind === 'source' ? '原文事实' : '归纳判断', 'claim-label'), document.createTextNode(claim.text))
        citations(p, claim.referenceIds, result.references)
        const save = element('button', '记入笔记', 'save-reference-note')
        save.type = 'button'; save.onclick = () => notebook.fromAnswer(run, { claimIndex })
        p.append(save)
        answer.append(p)
      }
      if (result.limitations) answer.append(element('p', `证据边界：${result.limitations}`, 'notice'))
    } else {
      answer.append(element('p', result.answer))
      for (const ref of result.references) {
        const quote = element('div', ref.text, 'excerpt')
        citations(quote, [ref.id], result.references)
        const save = element('button', '记入笔记', 'save-reference-note')
        save.type = 'button'; save.onclick = () => notebook.fromAnswer(run, { referenceId: ref.id })
        quote.append(save)
        answer.append(quote)
      }
      if (result.warning) answer.append(element('p', result.warning, 'notice'))
    }
  } else answer.append(element('p', run.error || (run.status === 'queued' ? '等待开始…' : '正在查阅文献…'), 'notice'))
  if (run.events.length) {
    const details = element('details', null, 'trace')
    details.open = ['running', 'queued'].includes(run.status)
    details.append(element('summary', `查阅记录 · ${run.events.length} 步`))
    for (const event of run.events) details.append(element('div', event.message))
    answer.append(details)
  }
  box.append(answer)
  return box
}
function busy(runId) {
  activeRun = runId
  updateAskState()
  $('cancel').hidden = !runId
}
function updateAskState() {
  $('ask').disabled = Boolean(activeRun || loadingDocument || pendingQuestion)
}
function configureQuestionMode() {
  $('conversation-title').textContent = modelConfigured ? '围绕文档提问' : '搜索原文'
  $('conversation-mode').textContent = modelConfigured ? '回答附原文引用' : '当前为原文检索模式'
  $('question-label').textContent = modelConfigured ? '问题' : '关键词或问题'
  $('question').placeholder = modelConfigured ? '例如：这篇文献的主要发现是什么？请附原文依据。' : '输入关键词，例如：研究方法、样本数量、测量指标'
  $('question-hint').textContent = modelConfigured ? '仅根据当前文档回答' : '显示匹配的原文片段'
  $('ask').textContent = modelConfigured ? '提问 ↗' : '搜索 ↗'
}
function emptyState() {
  return element('p', modelConfigured ? '可以询问这份文档的要点、数据或局限，回答会附原文引用。' : '输入文中的术语或关键词，查找相关原文片段。', 'empty-state')
}
function closeLibrary() {
  $('library').hidden = true
  $('drawer-backdrop').hidden = true
  $('library-toggle').setAttribute('aria-expanded', 'false')
}
function openLibrary() {
  $('library').hidden = false
  $('drawer-backdrop').hidden = false
  $('library-toggle').setAttribute('aria-expanded', 'true')
}
$('library-toggle').onclick = () => $('library').hidden ? openLibrary() : closeLibrary()
$('close-library').onclick = closeLibrary
$('drawer-backdrop').onclick = closeLibrary
function openImport() {
  closeLibrary()
  research?.prepareImport()
  if (!$('import-dialog').open) $('import-dialog').showModal()
}
function closeImport() {
  if ($('import-dialog').open) $('import-dialog').close()
}
$('import-open').onclick = openImport
$('drawer-import').onclick = openImport
$('welcome-import').onclick = openImport
$('close-import').onclick = closeImport
function setWarningsOpen(open) {
  const expanded = open && !$('warnings-toggle').hidden
  $('warnings').hidden = !expanded
  $('warnings-toggle').setAttribute('aria-expanded', String(expanded))
  $('warnings-toggle').textContent = expanded ? '收起提醒' : warningsLabel
}
$('warnings-toggle').onclick = () => setWarningsOpen($('warnings').hidden)
$('warnings-close').onclick = () => setWarningsOpen(false)
async function poll(id, token, documentId) {
  try {
    const run = await api(`/api/runs/${id}`)
    if (token !== epoch || loadingDocument || selected?.id !== documentId || run.documentId !== documentId) return
    document.getElementById(`run-${id}`)?.replaceWith(renderRun(run))
    if (['running', 'queued'].includes(run.status)) timer = setTimeout(() => poll(id, token, documentId), 900)
    else busy(null)
  } catch (error) {
    if (token !== epoch || loadingDocument || selected?.id !== documentId) return
    $('error').textContent = error.message
    busy(null)
  }
}
async function loadLibrary(expectedEpoch = null) {
  const request = research.beginDocumentsRequest()
  const { documents } = await api('/api/documents')
  if (expectedEpoch !== null && expectedEpoch !== epoch) return documents
  research.setDocuments(documents, request)
  return documents
}
function renderLibrary(documents) {
  $('documents').replaceChildren(...documents.map(doc => {
    const button = element('button', doc.title, `doc-item${doc.id === selected?.id ? ' active' : ''}`)
    button.append(element('small', `${doc.referenceCount} 个片段`))
    button.onclick = () => openDocument(doc.id).catch(error => research.report(error))
    return button
  }))
}
function resetReader() {
  notebook?.reset()
  epoch++; reviewEpoch++
  clearTimeout(timer)
  selected = null; loadingDocument = false; pendingQuestion = null
  busy(null)
  $('workspace').hidden = true; $('download').hidden = true
  $('page-image').onload = null; $('page-image').onerror = null
  closeLibrary()
}
async function openDocument(id, options = {}) {
  research?.readerOpening()
  const token = ++epoch
  loadingDocument = true
  pendingQuestion = null
  clearTimeout(timer)
  busy(null)
  try {
    const documentData = await api(`/api/documents/${id}`)
    if (token !== epoch) return
    selected = { ...documentData, warnings: documentData.warnings ?? [] }
    blockIndex = new Map(selected.sections.flatMap(section => section.blocks || []).map(block => [block.id, block]))
    clientStorage.persistent.setItem('classifier-document', id)
    closeLibrary()
    $('welcome').hidden = true
    $('workspace').hidden = false
    research?.readerOpened(id, options)
    $('title').textContent = selected.title
    const pdf = selected.mediaType === 'application/pdf'
    $('meta').textContent = `${selected.fileName} · ${pdf ? `${selected.sections.length} 页` : `${selected.references.length} 段原文`}`
    $('warning-text').textContent = selected.warnings.join(' ')
    const actionableWarnings = selected.warnings.filter(warning => /^第\s*\d+\s*页|^段\s*\d+|^表\s*\d+|已使用本地 OCR|缺少 OCR/.test(warning))
    $('warnings-toggle').hidden = !selected.warnings.length
    warningsLabel = actionableWarnings.length ? `待核对 ${actionableWarnings.length}` : '解析说明'
    setWarningsOpen(false)
    $('download').hidden = false
    $('download').href = `/api/documents/${id}/original`
    $('reference-query').value = ''
    closeReferenceSearch()
    $('reference-results').replaceChildren()
    $('reference-count').textContent = ''
    $('references').hidden = pdf
    $('references').replaceChildren(...(pdf ? [] : selected.references.map(structuredReference)))
    $('selected-excerpt').hidden = true
    $('selected-excerpt').replaceChildren()
    reviewEpoch++
    $('page-review').hidden = !pdf
    if (pdf) void showPage(1)
    $('history').replaceChildren(...[...selected.questions].reverse().map(renderRun))
    if (!selected.questions.length) $('history').append(emptyState())
    $('error').textContent = ''
    void notebook?.load(selected, research.currentTopic(), { ...options, modelConfigured })
    if (options.evidence) {
      if (options.evidence.documentId === selected.id && options.evidence.documentVersion === selected.evidenceVersion) jump(options.evidence.reference.id)
      else research.notice('原文版本已变化，请返回核对保存的证据快照。', true)
    }
    await loadLibrary(token)
    if (token !== epoch) return
    const running = selected.questions.find(run => ['running', 'queued'].includes(run.status))
    if (running) { busy(running.id); void poll(running.id, token, id) }
  } finally {
    if (token === epoch) { loadingDocument = false; updateAskState() }
  }
}
async function waitImport(id) {
  while (true) {
    let job
    try { job = await api(`/api/imports/${id}`) }
    catch (error) {
      if (error.status && error.status !== 429 && error.status < 500) throw error
      $('upload-status').textContent = '暂时无法获取导入进度，正在重试。后台任务仍会继续，可关闭此窗口。'
      await new Promise(resolve => setTimeout(resolve, 1500))
      continue
    }
    $('import-topic').value = job.topicId || ''
    $('upload-status').textContent = `${job.fileName}：${job.progress?.message || '等待开始解析…'}`
    if (['running', 'queued'].includes(job.status)) {
      await new Promise(resolve => setTimeout(resolve, 700))
      continue
    }
    if (job.status !== 'completed') throw new Error((job.error || '文档导入未完成') + (job.documentId ? ' 文献已保存，可从全部文献重新关联。' : ''))
    return job
  }
}
$('cancel-import').onclick = async () => {
  if (!importing) return
  try { await api(`/api/imports/${importing}/cancel`, { method: 'POST' }) }
  catch (error) { $('upload-status').textContent = error.message }
}
$('choose-file').onclick = () => $('file').click()
$('file').onchange = async event => {
  const files = [...event.target.files]
  if (!files.length) return
  const mode = $('parse-mode').value
  const topicId = $('import-topic').value
  const navigation = research.navigationKey()
  $('file').disabled = true; $('choose-file').disabled = true; $('parse-mode').disabled = true; $('import-topic').disabled = true
  let latest, completed = 0
  const errors = []
  try {
    for (const file of files) {
      $('upload-status').textContent = `正在上传 ${file.name}…`
      const form = new FormData(); form.append('file', file); form.append('mode', mode)
      if (topicId) form.append('topicId', topicId)
      try {
        const job = await api('/api/imports', { method: 'POST', body: form })
        importing = job.id
        clientStorage.persistent.setItem('classifier-import', job.id)
        $('cancel-import').hidden = false
        latest = (await waitImport(job.id)).documentId; completed++
      } catch (error) { errors.push(`${file.name}：${error.message}`) }
      finally { importing = null; clientStorage.persistent.removeItem('classifier-import'); $('cancel-import').hidden = true }
    }
    await research.refresh()
    await loadLibrary()
    if (latest && navigation === research.navigationKey()) {
      if (topicId) await research.showTopic(topicId)
      else await openDocument(latest)
    }
    $('upload-status').textContent = [`已导入 ${completed} 份文档。`, ...errors].join('\n')
    research.notice($('upload-status').textContent, Boolean(errors.length))
    if (completed && !errors.length) closeImport()
  } catch (error) { $('upload-status').textContent = error.message }
  finally { $('file').disabled = false; $('choose-file').disabled = false; $('parse-mode').disabled = false; $('import-topic').disabled = false; $('file').value = '' }
}
$('question-form').onsubmit = async event => {
  event.preventDefault()
  if (!selected || loadingDocument || activeRun || pendingQuestion) return
  const question = $('question').value.trim()
  if (!question) return
  const submission = { token: epoch, documentId: selected.id }
  pendingQuestion = submission
  updateAskState()
  $('error').textContent = ''
  try {
    const run = await api(`/api/documents/${submission.documentId}/questions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) })
    if (submission.token !== epoch || loadingDocument || selected?.id !== submission.documentId || run.documentId !== submission.documentId) return
    $('question').value = ''
    $('history').querySelector('.empty-state')?.remove()
    $('history').append(renderRun(run))
    $('history').scrollTop = $('history').scrollHeight
    busy(run.id)
    void poll(run.id, submission.token, submission.documentId)
  } catch (error) {
    if (submission.token === epoch && selected?.id === submission.documentId) $('error').textContent = error.message
  } finally {
    if (pendingQuestion === submission) { pendingQuestion = null; updateAskState() }
  }
}
$('cancel').onclick = async () => {
  if (!activeRun) return
  try { await api(`/api/runs/${activeRun}/cancel`, { method: 'POST' }) }
  catch (error) { $('error').textContent = error.message }
}
notebook = createNotebook({ api, element, jump, storage: clientStorage, useReaderTopic: (topicId, documentId) => research.useReaderTopic(topicId, documentId), updateTopicContent: (...args) => research.updateTopicContent(...args), notice: (message, error) => research.notice(message, error), async openNote(note) {
  if (await research.showTopic(note.topicId)) await openDocument(note.documentId, { retainTopic: true, noteId: note.id })
} })
comparisonWorkspace = createComparisonWorkspace({ api, element, storage: clientStorage, updateTopicContent: (...args) => research.updateTopicContent(...args), openDocument, currentTopic: () => research.currentTopic(), enter: id => research.enterComparison(id), navigationKey: () => research.navigationKey(), showTopic: id => research.showTopic(id), openReport: table => reportWorkspace.fromComparison(table), modelConfigured: () => modelConfigured, notice: (message, error) => research.notice(message, error), openSource: (evidence, comparisonId) => openDocument(evidence.documentId, { retainTopic: true, evidence, comparisonId }) })
reportWorkspace = createReportWorkspace({ api, element, storage: clientStorage, updateTopicContent: (...args) => research.updateTopicContent(...args), currentTopic: () => research.currentTopic(), enter: id => research.enterReport(id), navigationKey: () => research.navigationKey(), showTopic: id => research.showTopic(id), modelConfigured: () => modelConfigured, notice: (message, error) => research.notice(message, error), openSource: (evidence, reportId) => openDocument(evidence.documentId, { retainTopic: true, evidence, reportId }) })
research = createResearchWorkspace({ api, element, storage: clientStorage, openDocument, resetReader, openImport, libraryChanged: renderLibrary, onNavigate: () => { comparisonWorkspace.reset(); reportWorkspace.reset() }, openComparison: id => comparisonWorkspace.open(id), openReport: id => reportWorkspace.open(id), topicChanged: topic => { void notebook.showTopic(topic); void comparisonWorkspace.showTopic(topic); void reportWorkspace.showTopic(topic) }, metadataChanged(updated) {
  if (selected?.id === updated.id) { selected.title = updated.title; selected.bibliography = updated.bibliography; $('title').textContent = updated.title }
} })
const initialNavigation = research.navigationKey()
for (const button of document.querySelectorAll('[data-dialog-close]')) {
  button.onclick = () => $(button.dataset.dialogClose).click()
}
document.addEventListener('click', event => {
  const button = event.target.closest?.('button')
  const more = button?.closest('.more-actions')
  if (more) more.open = false
})
let settingsSaving = false, settingsRevoking = false, settingsTesting = false, settingsProbe = null, settingsVersion = 0
let settingsValue = { editable: true, canRevoke: true, canRemember: false, persistence: 'session', connectionTest: { state: 'untested' } }
const settingsBody = () => ({ url: $('model-settings-url').value, model: $('model-settings-model').value, key: $('model-settings-key').value })
function connectionLabel(value) {
  return !value.hasKey ? '未连接' : value.connectionTest?.state === 'passed' ? '已测试' : value.persistence === 'remembered' ? '已记住 · 尚未测试' : '已配置 · 尚未测试'
}
function updateConnectionHeader(value) {
  $('model-settings-open').textContent = value.hasKey ? `模型连接 · ${connectionLabel(value)}` : '模型连接'
}
function renderSettingsControls() {
  const busy = settingsSaving || settingsTesting
  for (const name of ['url', 'model', 'key']) $(`model-settings-${name}`).disabled = busy || !settingsValue.editable
  $('model-settings-remember').disabled = busy || !settingsValue.canRemember || !settingsValue.editable
  $('model-settings-save').disabled = busy || !settingsValue.editable
  $('model-settings-clear').disabled = settingsSaving || !settingsValue.editable
  $('model-settings-revoke').disabled = settingsRevoking || !settingsValue.canRevoke
  $('model-settings-test').disabled = busy
  $('model-settings-test-stop').hidden = !settingsTesting
  $('model-settings-close').disabled = settingsSaving
  $('model-settings-save').textContent = $('model-settings-remember').checked ? '启用并记住连接' : '启用本次连接'
}
function showSettingsValue(value) {
  settingsValue = value
  $('model-settings-status').textContent = `${connectionLabel(value)}${value.settingsWarning ? ' · ' + value.settingsWarning : ''}`
  $('model-settings-remember-field').hidden = !value.canRemember
  $('model-settings-remember').checked = value.persistence === 'remembered'
  $('model-settings-retention').textContent = value.canRemember ? '默认只在本次运行使用。选择记住后，密钥使用 macOS 钥匙串支持的加密保护，密文保存在独立应用设置中。' : '当前环境只提供会话连接，退出服务后需重新连接。'
  updateConnectionHeader(value); renderSettingsControls()
}
function closeModelSettings() {
  if (settingsSaving) return
  settingsVersion++
  if (settingsTesting) {
    settingsProbe?.abort(); settingsProbe = null; settingsTesting = false
    void api('/api/settings/text-model/test/cancel', { method: 'POST' }).catch(() => {})
  }
  $('model-settings-key').value = ''; $('model-settings-dialog').close()
}
$('model-settings-close').onclick = closeModelSettings
$('model-settings-dialog').oncancel = event => { if (settingsSaving) event.preventDefault(); else closeModelSettings() }
$('model-settings-open').onclick = async () => {
  const version = ++settingsVersion
  try {
    const value = await api('/api/settings/text-model')
    if (version !== settingsVersion) return
    $('model-settings-url').value = value.url; $('model-settings-model').value = value.model; $('model-settings-key').value = ''
    $('model-settings-key').placeholder = value.hasKey ? '不换地址时可留空，保留本次密钥' : '只用于请求所填模型服务'
    $('model-settings-error').textContent = value.editable ? '' : '当前配置由外部管理。'
    showSettingsValue(value)
    $('model-connection-management').hidden = !value.hasKey && !value.canRevoke
    $('model-connection-management').open = false
    $('model-settings-dialog').showModal()
  } catch (error) { research.notice(error.message, true) }
}
$('model-settings-form').oninput = () => {
  settingsVersion++
  $('model-settings-status').textContent = '设置尚未保存；测试连接不会启用这些设置。'
  $('model-settings-error').textContent = ''; renderSettingsControls()
}
$('model-settings-test').onclick = async () => {
  if (settingsSaving || settingsTesting || !$('model-settings-form').reportValidity()) return
  const version = settingsVersion, body = settingsBody(), controller = new AbortController()
  settingsTesting = true; settingsProbe = controller; renderSettingsControls()
  $('model-settings-error').textContent = ''; $('model-settings-status').textContent = '正在向所填服务发送固定测试文字…'
  try {
    await api('/api/settings/text-model/test', { method: 'POST', signal: controller.signal, timeoutMs: 25000, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (settingsVersion !== version || settingsProbe !== controller) return
    $('model-settings-status').textContent = '测试通过，服务已响应。尚未启用的设置需点击启用。'
    const current = await api('/api/settings/text-model')
    if (settingsVersion === version && settingsProbe === controller) updateConnectionHeader(current)
  } catch (error) {
    if (settingsVersion === version && settingsProbe === controller && !controller.signal.aborted) {
      $('model-settings-status').textContent = '测试未通过，当前连接不变。'
      $('model-settings-error').textContent = error.message
    }
  } finally { if (settingsProbe === controller) { settingsProbe = null; settingsTesting = false; renderSettingsControls() } }
}
$('model-settings-test-stop').onclick = async () => {
  const controller = settingsProbe
  if (!controller) return
  try {
    await api('/api/settings/text-model/test/cancel', { method: 'POST' })
    if (settingsProbe !== controller) return
    controller.abort(); settingsProbe = null; settingsTesting = false
    $('model-settings-status').textContent = '测试已停止。'; renderSettingsControls()
  } catch (error) { $('model-settings-error').textContent = error.message }
}
async function saveModelSettings(body, { revoke = false } = {}) {
  if (settingsRevoking || settingsSaving && !revoke) return
  const version = ++settingsVersion
  settingsProbe?.abort(); settingsProbe = null; settingsTesting = false
  settingsSaving = true; settingsRevoking = revoke; renderSettingsControls()
  $('model-settings-error').textContent = ''
  $('model-settings-status').textContent = revoke ? '正在撤销授权并清除记住的连接…' : '正在启用连接…'
  try {
    const value = await api(revoke ? '/api/settings/model-authorization/revoke' : '/api/settings/text-model', { method: revoke ? 'POST' : 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (version !== settingsVersion) return
    settingsValue = value; updateConnectionHeader(value)
    $('model-settings-key').value = ''
    const health = await api('/health')
    if (version !== settingsVersion) return
    modelConfigured = health.modelConfigured
    if (revoke) {
      const capabilities = await api('/api/parser-capabilities')
      if (version !== settingsVersion) return
      $('parse-mode').querySelector('[value="vision"]').disabled = !capabilities.vision
      if (!capabilities.vision && $('parse-mode').value === 'vision') $('parse-mode').value = 'auto'
    }
    configureQuestionMode(); comparisonWorkspace.updateModel(); reportWorkspace.updateModel()
    if (selected) await notebook.load(selected, research.currentTopic(), { modelConfigured })
    if (version !== settingsVersion) return
    $('model-settings-dialog').close()
    research.notice(revoke ? '已撤销模型授权并清除记住的连接；相关任务正在停止。' : modelConfigured ? `${value.persistence === 'remembered' ? '连接已启用并记住' : '本次连接已启用'} · ${connectionLabel(value)}。` : '已清除连接；在途任务继续使用原配置。')
  } catch (error) {
    if (version !== settingsVersion) return
    $('model-settings-error').textContent = error.message
    if (revoke || body.clear) {
      try {
        const health = await api('/health'), current = await api('/api/settings/text-model')
        if (version !== settingsVersion) return
        modelConfigured = health.modelConfigured; settingsValue = current; updateConnectionHeader(current)
        configureQuestionMode(); comparisonWorkspace.updateModel(); reportWorkspace.updateModel()
      } catch {}
    }
  }
  finally { if (version === settingsVersion) { settingsSaving = false; settingsRevoking = false; renderSettingsControls() } }
}
$('model-settings-form').onsubmit = event => { event.preventDefault(); if (!settingsTesting) void saveModelSettings({ ...settingsBody(), remember: $('model-settings-remember').checked }) }
$('model-settings-clear').onclick = () => saveModelSettings({ clear: true })
$('model-settings-revoke').onclick = () => saveModelSettings({ scope: 'all' }, { revoke: true })
try {
  const capabilities = await api('/api/parser-capabilities')
  $('parser-status').textContent = capabilities.ocr.available ? `本地 OCR：${capabilities.ocr.languages.join(' + ')}。扫描数字与公式请核对页图。` : '本地 OCR 尚不可用，请安装 Tesseract 和中英文语言包。'
  const visionOption = $('parse-mode').querySelector('[value="vision"]')
  visionOption.disabled = !capabilities.vision
  if (capabilities.vision) visionOption.textContent = '视觉增强（页图发送至已配置服务）'
  const health = await api('/health')
  modelConfigured = health.modelConfigured
  try { updateConnectionHeader(await api('/api/settings/text-model')) } catch { /* Connection status must not block opening research. */ }
  configureQuestionMode()
  await loadLibrary()
  await refreshLibraryHealth()
  await research.restore(initialNavigation)
  const previous = clientStorage.persistent.getItem('classifier-import')
  if (previous) {
    openImport()
    importing = previous; $('cancel-import').hidden = false; $('file').disabled = true; $('choose-file').disabled = true; $('import-topic').disabled = true; $('parse-mode').disabled = true
    try {
      await waitImport(previous)
      await research.refresh(); await loadLibrary()
      research.notice('文献已导入。'); closeImport()
    } finally { importing = null; $('cancel-import').hidden = true; $('file').disabled = false; $('choose-file').disabled = false; $('import-topic').disabled = false; $('parse-mode').disabled = false; clientStorage.persistent.removeItem('classifier-import') }
  }
} catch (error) { $('upload-status').textContent = error.message; research.report(error) }
