import katex from '/katex.mjs'
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

async function api(path, options) {
  const response = await fetch(path, options)
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '请求失败')
  return value
}
function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text != null) node.textContent = text
  if (className) node.className = className
  return node
}
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
      for (const claim of result.claims) {
        const p = element('p')
        p.append(element('span', claim.kind === 'source' ? '原文事实' : '归纳判断', 'claim-label'), document.createTextNode(claim.text))
        citations(p, claim.referenceIds, result.references)
        answer.append(p)
      }
      if (result.limitations) answer.append(element('p', `证据边界：${result.limitations}`, 'notice'))
    } else {
      answer.append(element('p', result.answer))
      for (const ref of result.references) {
        const quote = element('div', ref.text, 'excerpt')
        citations(quote, [ref.id], result.references)
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
  $('question').placeholder = modelConfigured ? '例如：这份文档的主要发现是什么？请附原文依据。' : '例如：报价金额、付款条款、样本数量'
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
  const { documents } = await api('/api/documents')
  if (expectedEpoch !== null && expectedEpoch !== epoch) return documents
  $('documents').replaceChildren(...documents.map(doc => {
    const button = element('button', doc.title, `doc-item${doc.id === selected?.id ? ' active' : ''}`)
    button.append(element('small', `${doc.referenceCount} 个片段`))
    button.onclick = () => openDocument(doc.id).catch(error => { $('error').textContent = error.message })
    return button
  }))
  return documents
}
async function openDocument(id) {
  const token = ++epoch
  loadingDocument = true
  pendingQuestion = null
  clearTimeout(timer)
  busy(null)
  try {
    const documentData = await api(`/api/documents/${id}`)
    if (token !== epoch) return
    selected = documentData
    blockIndex = new Map(selected.sections.flatMap(section => section.blocks || []).map(block => [block.id, block]))
    localStorage.setItem('classifier-document', id)
    closeLibrary()
    $('welcome').hidden = true
    $('workspace').hidden = false
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
    await loadLibrary(token)
    if (token !== epoch) return
    const running = selected.questions.find(run => ['running', 'queued'].includes(run.status))
    if (running) { busy(running.id); void poll(running.id, token, id) }
  } finally {
    if (token === epoch) { loadingDocument = false; updateAskState() }
  }
}
async function waitImport(id) {
  let job
  do {
    job = await api(`/api/imports/${id}`)
    $('upload-status').textContent = `${job.fileName}：${job.progress?.message || '等待开始解析…'}`
    if (['running', 'queued'].includes(job.status)) await new Promise(resolve => setTimeout(resolve, 700))
  } while (['running', 'queued'].includes(job.status))
  if (job.status !== 'completed') throw new Error(job.error || '文档导入未完成')
  return job.documentId
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
  $('file').disabled = true; $('choose-file').disabled = true; $('parse-mode').disabled = true
  let latest, completed = 0
  const errors = []
  try {
    for (const file of files) {
      $('upload-status').textContent = `正在上传 ${file.name}…`
      const form = new FormData(); form.append('file', file); form.append('mode', mode)
      try {
        const job = await api('/api/imports', { method: 'POST', body: form })
        importing = job.id
        localStorage.setItem('classifier-import', job.id)
        $('cancel-import').hidden = false
        latest = await waitImport(job.id); completed++
      } catch (error) { errors.push(`${file.name}：${error.message}`) }
      finally { importing = null; localStorage.removeItem('classifier-import'); $('cancel-import').hidden = true }
    }
    if (latest) await openDocument(latest)
    $('upload-status').textContent = [`已导入 ${completed} 份文档。`, ...errors].join('\n')
    if (completed && !errors.length) closeImport()
  } catch (error) { $('upload-status').textContent = error.message }
  finally { $('file').disabled = false; $('choose-file').disabled = false; $('parse-mode').disabled = false; $('file').value = '' }
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
try {
  const capabilities = await api('/api/parser-capabilities')
  $('parser-status').textContent = capabilities.ocr.available ? `本地 OCR：${capabilities.ocr.languages.join(' + ')}。扫描数字与公式请核对页图。` : '本地 OCR 尚不可用，请安装 Tesseract 和中英文语言包。'
  const visionOption = $('parse-mode').querySelector('[value="vision"]')
  visionOption.disabled = !capabilities.vision
  if (capabilities.vision) visionOption.textContent = '视觉增强（页图发送至已配置服务）'
  const health = await api('/health')
  modelConfigured = health.modelConfigured
  configureQuestionMode()
  const documents = await loadLibrary()
  const last = localStorage.getItem('classifier-document')
  const target = documents.find(doc => doc.id === last) || documents[0]
  if (target) await openDocument(target.id)
  const previous = localStorage.getItem('classifier-import')
  if (previous) {
    openImport()
    importing = previous; $('cancel-import').hidden = false; $('file').disabled = true; $('choose-file').disabled = true
    try { await openDocument(await waitImport(previous)); $('upload-status').textContent = '文档已导入。'; closeImport() }
    finally { importing = null; $('cancel-import').hidden = true; $('file').disabled = false; $('choose-file').disabled = false; localStorage.removeItem('classifier-import') }
  }
} catch (error) { $('upload-status').textContent = error.message }
