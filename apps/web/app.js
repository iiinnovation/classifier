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
  document.querySelectorAll('.highlight').forEach(node => node.classList.remove('highlight'))
  const node = document.getElementById(`reference-${id}`)
  node?.classList.add('highlight')
  node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const ref = selected?.references.find(ref => ref.id === id)
  if (ref?.page && selected.mediaType === 'application/pdf') void showPage(ref.page, ref.bbox)
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
  const block = selected.sections.flatMap(section => section.blocks || []).find(block => block.id === ref.blockId)
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
    button.onclick = () => showPage(ref.page, ref.bbox)
    node.append(button)
  }
  return node
}
async function showPage(number, bbox = null) {
  if (!selected || selected.mediaType !== 'application/pdf') return
  const token = ++reviewEpoch
  reviewPage = Math.max(1, Math.min(number, selected.sections.length))
  $('page-review').hidden = false
  $('page-label').textContent = `第 ${reviewPage} / ${selected.sections.length} 页`
  $('prev-page').disabled = reviewPage === 1
  $('next-page').disabled = reviewPage === selected.sections.length
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
    }
  }
  image.onerror = () => { if (token === reviewEpoch) $('page-error').textContent = '页图暂时无法读取，请稍后重试。' }
  image.src = `/api/documents/${selected.id}/pages/${reviewPage}`
}
$('prev-page').onclick = () => showPage(reviewPage - 1)
$('next-page').onclick = () => showPage(reviewPage + 1)
$('review-document').onclick = () => showPage(1)
$('close-page').onclick = () => { reviewEpoch++; $('page-review').hidden = true }

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
async function loadLibrary() {
  const { documents } = await api('/api/documents')
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
    localStorage.setItem('classifier-document', id)
    $('welcome').hidden = true
    $('workspace').hidden = false
    $('title').textContent = selected.title
    $('meta').textContent = `${selected.fileName} · ${selected.references.length} 个原文片段`
    $('warnings').textContent = selected.warnings.join(' ')
    $('download').hidden = false
    $('download').href = `/api/documents/${id}/original`
    $('reference-count').textContent = `${selected.references.length} 个片段`
    $('references').replaceChildren(...selected.references.map(structuredReference))
    reviewEpoch++; $('page-review').hidden = true
    $('review-document').hidden = selected.mediaType !== 'application/pdf'
    $('history').replaceChildren(...[...selected.questions].reverse().map(renderRun))
    if (!selected.questions.length) $('history').append(element('p', '可以从研究方法、主要发现或局限开始提问。', 'hint'))
    $('error').textContent = ''
    await loadLibrary()
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
$('file').onchange = async event => {
  const files = [...event.target.files]
  const mode = $('parse-mode').value
  $('file').disabled = true; $('parse-mode').disabled = true
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
  } catch (error) { $('upload-status').textContent = error.message }
  finally { $('file').disabled = false; $('parse-mode').disabled = false; $('file').value = '' }
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
  $('model-status').textContent = health.modelConfigured ? '科研问答模型已配置' : '当前模式：原文检索'
  const documents = await loadLibrary()
  const last = localStorage.getItem('classifier-document')
  const target = documents.find(doc => doc.id === last) || documents[0]
  if (target) await openDocument(target.id)
  const previous = localStorage.getItem('classifier-import')
  if (previous) {
    importing = previous; $('cancel-import').hidden = false; $('file').disabled = true
    try { await openDocument(await waitImport(previous)); $('upload-status').textContent = '文档已导入。' }
    finally { importing = null; $('cancel-import').hidden = true; $('file').disabled = false; localStorage.removeItem('classifier-import') }
  }
} catch (error) { $('upload-status').textContent = error.message }
