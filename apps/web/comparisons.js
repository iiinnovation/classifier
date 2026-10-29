export function createComparisonWorkspace({ api, element, currentTopic, enter, navigationKey, showTopic, openSource, openReport, modelConfigured, notice, storage, updateTopicContent = () => {}, openDocument = () => {} }) {
  const sourceText = (state, noun = '原文') => ({ deleted: `${noun}已删除`, missing: `${noun}缺失`, corrupt: `${noun}记录损坏`, unavailable: `${noun}暂时无法读取` })[state] || ''
  const issueText = issues => [...new Set((issues || []).map(item => sourceText(item.state, '来源')))].filter(Boolean).join('、')
  const sessionStorage = storage?.drafts || globalThis.sessionStorage
  const $ = id => document.getElementById(id)
  const statuses = { unfilled: '未填写', recorded: '已记录', not_reported: '未报告', not_found: '未找到', not_applicable: '不适用' }
  const kinds = { user: '用户判断', source: '原文报告', inference: '模型归纳' }
  const comparabilities = { unchecked: '待判断', comparable: '可比较', conditional: '有条件可比', not_comparable: '不可直接比较' }
  const relations = { agreement: '共同点', difference: '差异', conflict: '相互冲突', insufficient: '材料不足' }
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let table = null, tableId = null, epoch = 0, readVersion = 0, topicVersion = 0, editorEpoch = 0, editor = null, saving = false, timer
  let taskTopic = null, taskBusy = false, goalTable = null
  let savedVisible = false, visibleRunId = null
  const draftKey = value => `classifier-comparison-draft:${value.topicId}:${value.tableId}:${value.kind}:${value.documentId || ''}:${value.columnId || ''}`
  function button(label, action, className = 'quiet-button') {
    const node = element('button', label, className); node.type = 'button'
    node.onclick = () => Promise.resolve().then(action).catch(error => notice(error.message, true))
    return node
  }
  function input(label, id, value = '', multiline = false, max = 6000) {
    const wrapper = element('label', null, 'form-field'), node = element(multiline ? 'textarea' : 'input')
    node.id = id; node.value = value; node.maxLength = max
    wrapper.append(element('span', label), node)
    return { wrapper, node }
  }
  function select(label, id, labels, value) {
    const wrapper = element('label', null, 'form-field'), node = element('select'); node.id = id
    for (const [key, text] of Object.entries(labels)) { const option = element('option', text); option.value = key; node.append(option) }
    node.value = value; wrapper.append(element('span', label), node)
    return { wrapper, node }
  }
  function details(label, id, nodes, open = false) {
    const wrapper = element('details', null, 'form-details'); wrapper.id = id; wrapper.open = open
    wrapper.append(element('summary', label), ...nodes)
    return wrapper
  }
  function drafts(topicId = currentTopic()?.id, id = tableId) {
    if (typeof sessionStorage === 'undefined') return []
    return Object.keys(sessionStorage).filter(key => key.startsWith(`classifier-comparison-draft:${topicId}:`)).flatMap(key => {
      try { const draft = JSON.parse(sessionStorage.getItem(key)); return !id || draft.tableId === id ? [{ ...draft, key }] : [] } catch { return [] }
    })
  }
  function persistEditor() {
    if (!editor || saving || !editor.dirty || typeof sessionStorage === 'undefined') return
    const { kind, topicId, tableId, revision, documentId, columnId } = editor
    sessionStorage.setItem(draftKey(editor), JSON.stringify({ kind, topicId, tableId, revision, documentId, columnId, body: editor.read() }))
  }
  function renderDrafts() {
    const values = table ? drafts(table.topicId, table.id) : []
    const previous = $('comparison-draft-choice').value
    $('comparison-drafts').hidden = !values.length
    $('comparison-draft-choice').replaceChildren(...values.map(value => {
      const label = value.kind === 'cell' ? '比较项' : value.kind === 'analysis' ? '跨文献判断' : '范围与维度'
      const option = element('option', `${label} · ${(value.body.value || value.body.title || '').slice(0, 60)}`); option.value = value.key; return option
    }))
    if (values.some(value => value.key === previous)) $('comparison-draft-choice').value = previous
  }
  function reset() {
    persistEditor(); epoch++; readVersion++; editorEpoch++; clearTimeout(timer)
    if (!saving) { $('comparison-editor').close(); editor = null }
    $('comparison-inspector').close()
    table = null; tableId = null
    goalTable = null
    savedVisible = false; visibleRunId = null
    $('comparison-task-options').open = false; $('comparison-model-options').open = false
    $('comparison-draft-preview').replaceChildren(); $('comparison-task-status').replaceChildren()
  }
  async function open(id) {
    const navigation = enter(id), token = ++epoch
    tableId = id
    $('comparison-title').textContent = '正在打开比较表…'; $('comparison-question').textContent = ''
    $('comparison-grid').replaceChildren(); $('comparison-analyses').replaceChildren(); $('comparison-suggestions').replaceChildren()
    $('comparison-message').textContent = ''; $('comparison-retry').hidden = true
    for (const name of ['comparison-configure', 'comparison-history', 'comparison-archive', 'comparison-impact', 'comparison-generate', 'comparison-draft-generate', 'comparison-to-report']) $(name).disabled = true
    const value = await fetchTable(id, token)
    if (navigation !== navigationKey() || token !== epoch || !value) return
    table = value; render()
  }
  async function fetchTable(id = tableId, token = epoch) {
    const version = ++readVersion
    try {
      const value = await api(`/api/comparisons/${id}`)
      if (token !== epoch || version !== readVersion || tableId !== id) return null
      $('comparison-retry').hidden = true
      return value
    } catch (error) {
      if (token === epoch && version === readVersion) { $('comparison-message').textContent = error.message; $('comparison-retry').hidden = false }
      return null
    }
  }
  async function refresh() {
    const value = await fetchTable()
    if (value) { table = value; render() }
    else schedule()
  }
  function schedule() {
    clearTimeout(timer)
    if (table?.suggestions.some(run => ['running', 'queued'].includes(run.status))) timer = setTimeout(refresh, 1000)
  }
  function accept(value) { readVersion++; table = value; render() }
  async function showTopicComparisons(topic) {
    renderTaskComposer(topic)
    const token = ++topicVersion
    $('comparison-list').replaceChildren(element('p', '正在读取比较表…', 'hint'))
    try {
      const result = await api(`/api/topics/${topic.id}/comparisons`)
      if (token !== topicVersion) return
      updateTopicContent(topic.id, 'comparisons', result.comparisons, open)
      const cardFor = item => {
        const card = element('article', null, 'document-card'), info = element('div', null, 'document-card-body')
        info.append(element('h3', item.title), element('p', `${item.documentCount} 篇文献 · ${item.columnCount} 个维度${item.archived ? ' · 已归档' : ''}`, 'hint'))
        if (issueText(item.sourceIssues)) info.append(element('p', `${issueText(item.sourceIssues)}，保留已保存比较。`, 'notice'))
        card.append(info, button('打开比较', () => open(item.id))); return card
      }
      const active = result.comparisons.filter(item => !item.archived)
      $('comparison-list').replaceChildren(...active.map(cardFor))
      const archived = result.comparisons.filter(item => item.archived)
      if (archived.length) { const group = element('details'); group.append(element('summary', `归档比较（${archived.length}）`), ...archived.map(cardFor)); $('comparison-list').append(group) }
      const pending = drafts(topic.id, null).filter(value => value.kind === 'config' && !value.revision && !result.comparisons.some(item => item.id === value.tableId))
      for (const draft of pending) $('comparison-list').append(button(`继续创建：${draft.body.title || '未命名比较表'}`, () => configure(draft)))
      if (!active.length && !pending.length) $('comparison-list').append(element('p', '选定两篇或更多文献，开始比较。', 'collection-empty'))
    } catch (error) { if (token === topicVersion) $('comparison-list').replaceChildren(element('p', error.message, 'form-error')) }
  }
  function evidenceButton(item) { return button(`出处：${item.reference.title}`, () => inspectEvidence(item), 'quiet-button comparison-citation') }
  function inspect(title, nodes) {
    $('comparison-inspector-title').textContent = title; $('comparison-inspector-body').replaceChildren(...nodes)
    $('comparison-inspector-error').textContent = ''
    if (!$('comparison-inspector').open) $('comparison-inspector').showModal()
  }
  function inspectEvidence(item, cell = null) {
    const current = table?.documents.find(doc => doc.id === item.documentId)
    const valid = item.matchesCurrent ?? Boolean(current && !current.unavailable && typeof item.documentVersion === 'string' && current.evidenceVersion === item.documentVersion)
    const nodes = [element('p', `${item.documentTitle} · ${item.reference.title}`, 'hint'), element('blockquote', item.reference.text, 'comparison-quote')]
    const unavailable = sourceText(item.sourceState || current?.unavailable)
    nodes.push(element('p', unavailable ? `${unavailable}，保存时的证据仍保留。请先检查资料。` : valid ? (item.reference.needsReview ? '识别结果需要对照原文核对。' : '请核对这段原文是否支持比较项。') : '原文版本已变化或无法确认，下面保留的是保存时的证据。', 'notice'))
    const go = button('打开原文位置', async () => {
      persistEditor(); $('comparison-editor').close(); editor = null; editorEpoch++
      $('comparison-inspector').close(); await openSource(item, table.id)
    })
    go.disabled = !valid
    nodes.push(go)
    if (cell && valid && !cell.noteChanged && cell.evidence.every(ref => ref.matchesCurrent) && cell.reviewState !== 'checked') {
      const target = table, token = epoch
      nodes.push(button('标记已核对', async () => {
        const updated = await api(`/api/comparisons/${target.id}/cells/${cell.documentId}/${cell.columnId}`, json('PATCH', { revision: target.revision, reviewState: 'checked' }))
        if (token === epoch) { $('comparison-inspector').close(); accept(updated) }
      }))
    }
    inspect('比较项出处', nodes)
  }
  function render() {
    $('comparison-title').textContent = table.title
    $('comparison-impact').dataset.deletionId = table.id; $('comparison-impact').disabled = false
    $('comparison-question').textContent = table.question
    if (goalTable !== table.id) { $('comparison-task-goal').value = sessionStorage.getItem('classifier-research-followup:' + table.id) || ''; goalTable = table.id }
    $('comparison-message').textContent = issueText(table.sourceIssues) ? `${issueText(table.sourceIssues)}，旧比较与证据仍保留。请先检查资料再生成新内容。` : table.archived ? '此比较表已归档，可恢复后继续生成建议。' : table.documents.some(doc => !doc.linked) ? '部分文献已移出主题，旧比较与证据仍保留。生成新建议前请调整范围。' : ''
    for (const name of ['comparison-configure', 'comparison-history', 'comparison-archive']) $(name).disabled = false
    $('comparison-archive').textContent = table.archived ? '恢复比较表' : '归档'
    const matrix = element('table'), head = element('thead'), heading = element('tr')
    heading.append(element('th', '文献 / 比较维度'))
    for (const col of table.columns) { const th = element('th', col.name); if (col.description) th.append(element('small', col.description)); heading.append(th) }
    head.append(heading); matrix.append(head)
    const body = element('tbody')
    for (const doc of table.documents) {
      const tr = element('tr'); tr.dataset.documentId = doc.id
      const name = element('th', doc.title); name.scope = 'row'
      name.append(element('small', [doc.bibliography?.authors, doc.bibliography?.year, !doc.linked ? '已移出主题' : ''].filter(Boolean).join(' · ')))
      tr.append(name)
      for (const col of table.columns) {
        const cell = table.cells.find(item => item.documentId === doc.id && item.columnId === col.id)
        const td = element('td'); td.dataset.columnId = col.id
        if (cell.status !== 'recorded') td.append(element('span', statuses[cell.status], 'note-labels'))
        if (cell.value) td.append(element('p', cell.value, 'comparison-value'))
        if (cell.comparability !== 'unchecked' || cell.conditions) {
          const condition = element('details', null, 'comparison-condition')
          condition.append(element('summary', comparabilities[cell.comparability]))
          if (cell.conditions) condition.append(element('p', `条件：${cell.conditions}`, 'record-preview'))
          if (cell.reason) condition.append(element('p', cell.reason, 'record-preview'))
          td.append(condition)
        }
        const stale = cell.noteChanged || cell.evidence.some(item => !item.matchesCurrent)
        if (stale) td.append(element('p', cell.noteChanged ? ([...new Set(cell.noteSources.map(note => sourceText(note.sourceState, '来源笔记')))].filter(Boolean).join('、') || '来源笔记已更新') + '，当前保留旧版本内容。' : sourceText(doc.unavailable) || '原文版本已变化，请复核。', 'notice'))
        else if (cell.evidence.length) td.append(element('p', `${kinds[cell.kind]} · ${cell.reviewState === 'checked' ? '已人工核对' : '待人工核对'}`, 'hint'))
        const actions = element('div', null, 'note-actions')
        actions.append(button('编辑比较项', () => editCell(doc.id, col.id)))
        if (cell.evidence.length) actions.append(button(`查看出处 (${cell.evidence.length})`, () => {
          if (cell.evidence.length === 1) return inspectEvidence(cell.evidence[0], cell)
          inspect(`${doc.title} · ${col.name}`, cell.evidence.map(item => {
            const section = element('section', null, 'evidence-preview')
            section.append(element('p', item.reference.text.slice(0, 260)), button(`出处：${item.reference.title}`, () => inspectEvidence(item, cell)))
            return section
          }))
        }))
        td.append(actions); tr.append(td)
      }
      body.append(tr)
    }
    matrix.append(body); $('comparison-grid').replaceChildren(matrix)
    const emptyAnalyses = element('details'); emptyAnalyses.append(element('summary', '添加综合判断'))
    const analysisCards = table.columns.map(col => {
      const value = table.analyses.find(item => item.columnId === col.id), card = element('article', null, 'comparison-analysis')
      card.dataset.columnId = col.id
      card.append(element('h3', col.name))
      if (value) {
        card.append(element('p', `${relations[value.relation]} · ${value.origin.type === 'model' ? '模型归纳 · 待核对' : '用户判断'}`, 'note-labels'), element('p', value.value, 'comparison-value'))
        if (value.conditions) card.append(element('p', value.conditions, 'record-preview'))
        if (value.outdated) card.append(element('p', '研究问题、维度或依据的比较项已变化，需要复核此判断。', 'notice'))
        if (value.evidence.some(item => !item.matchesCurrent)) card.append(element('p', '引用的原文版本已变化。', 'notice'))
        card.append(element('p', `依据 ${value.rows.length} 篇文献的已保存比较项`, 'hint'))
        for (const item of value.evidence) card.append(evidenceButton(item))
      } else { card.append(button('编辑综合判断', () => editAnalysis(col.id))); emptyAnalyses.append(card); return null }
      card.append(button('编辑综合判断', () => editAnalysis(col.id))); return card
    }).filter(Boolean)
    $('comparison-analyses').replaceChildren(...analysisCards)
    if (emptyAnalyses.children.length > 1) $('comparison-analyses').append(emptyAnalyses)
    const previous = $('comparison-column').value
    $('comparison-column').replaceChildren(...table.columns.map(col => { const option = element('option', col.name); option.value = col.id; return option }))
    if (table.columns.some(col => col.id === previous)) $('comparison-column').value = previous
    $('comparison-model-hint').textContent = modelConfigured() ? '将本维度的相关原文发送至已配置服务，采用后更新本列。' : '尚未配置模型，可继续手工比较。'
    $('comparison-generate').disabled = !modelConfigured() || table.archived || table.documents.some(doc => !doc.linked || doc.unavailable) || Boolean(table.sourceIssues?.length) || table.suggestions.some(run => ['queued', 'running'].includes(run.status))
    $('comparison-draft-generate').disabled = $('comparison-generate').disabled
    $('comparison-to-report').disabled = !modelConfigured() || table.archived || Boolean(table.sourceIssues?.length) || table.cells.every(cell => cell.status === 'unfilled') || table.suggestions.some(run => ['queued', 'running'].includes(run.status))
    syncSavedVisibility()
    renderTaskResult()
    renderSuggestions(); renderDrafts(); schedule()
  }
  function syncSavedVisibility() {
    const run = table?.suggestions.find(item => item.purpose === 'comparison-draft')
    const previewing = run && ['queued', 'running', 'completed'].includes(run.status) && table.lastDraftRunId !== run.id && sessionStorage.getItem(`classifier-comparison-dismissed-draft:${run.id}`) !== '1'
    if (visibleRunId !== run?.id) { savedVisible = false; visibleRunId = run?.id }
    $('comparison-saved').hidden = Boolean(previewing && !savedVisible)
    $('comparison-saved-toggle').hidden = !previewing
    $('comparison-saved-toggle').textContent = savedVisible ? '收起已保存表格' : '查看／编辑已保存表格'
    $('comparison-saved-toggle').setAttribute('aria-expanded', String(savedVisible))
    $('comparison-to-report').hidden = Boolean(previewing)
  }
  $('comparison-saved-toggle').onclick = () => { savedVisible = !savedVisible; syncSavedVisibility() }
  async function mutate(path, body) {
    const target = table, token = epoch
    const result = await api(path, json('PATCH', { revision: target.revision, ...body }))
    if (token === epoch && tableId === target.id) { accept(result); notice('比较表已保存。') }
  }
  function showEditor(state, title, controls, read) {
    editorEpoch++
    editor = { ...state, read, dirty: Boolean(state.body) }
    $('comparison-editor-title').textContent = title
    $('comparison-editor-context').textContent = currentTopic()?.title || ''
    $('comparison-fields').replaceChildren(...controls)
    $('comparison-editor-error').textContent = ''; $('comparison-editor-latest').hidden = true; $('comparison-editor-latest').disabled = false
    if (!$('comparison-editor').open) $('comparison-editor').showModal()
  }
  async function configure(draft = null, loadedTopic = null) {
    const base = draft || (table ? { kind: 'config', tableId: table.id, topicId: table.topicId, revision: table.revision, body: null } : { kind: 'config', tableId: crypto.randomUUID(), topicId: currentTopic().id, revision: null })
    const token = ++editorEpoch, navigation = navigationKey()
    const topic = loadedTopic || await api(`/api/topics/${base.topicId}`)
    if (token !== editorEpoch || navigation !== navigationKey()) return
    const data = base.body || (base.revision ? table : { title: '文献比较', question: topic.question, documentIds: topic.documents.filter(link => link.selection !== 'excluded' && !link.document.unavailable).slice(0, 12).map(link => link.documentId), columns: ['方法', '研究对象', '主要发现', '局限'].map(name => ({ id: crypto.randomUUID(), name, description: '' })) })
    const title = input('比较表标题', 'cmp-title', data.title, false, 200), question = input('比较研究问题', 'cmp-question', data.question, true, 4000)
    title.node.required = true; question.node.required = true
    question.node.placeholder = '这次希望比较什么？已有主题问题会自动带入。'
    const options = new Map(topic.documents.map(link => [link.documentId, link.document]))
    if (base.revision) for (const doc of table.documents) if (!options.has(doc.id)) options.set(doc.id, { ...doc, removed: true })
    const documentBox = element('div', null, 'comparison-document-options'), checks = []
    for (const doc of options.values()) {
      const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.value = doc.id; check.checked = data.documentIds.includes(doc.id)
      checks.push(check); label.append(check, element('span', `${doc.title}${doc.removed ? '（已移出主题）' : ''}`)); documentBox.append(label)
    }
    const columnBox = element('div', null, 'comparison-column-options')
    function addColumn(col = { id: crypto.randomUUID(), name: '', description: '' }) {
      const row = element('div', null, 'comparison-column-option'); row.dataset.columnId = col.id
      const name = input('维度名称', '', col.name, false, 80), description = input('维度说明', '', col.description, false, 1000)
      name.node.className = 'column-name'; description.node.className = 'column-description'; name.node.required = true
      row.append(name.wrapper, button('上移', () => { if (row.previousElementSibling) columnBox.insertBefore(row, row.previousElementSibling); changed() }), button('移除维度', () => { row.remove(); changed() }), details(col.description ? `说明：${col.description.slice(0, 40)}` : '补充维度说明（可选）', '', [description.wrapper]))
      columnBox.append(row)
    }
    data.columns.forEach(addColumn)
    const add = button('＋ 添加维度', () => { addColumn(); changed() })
    showEditor(base, base.revision ? '调整比较范围与维度' : '新建比较表', [title.wrapper, question.wrapper, element('h3', '选定文献（2–12 篇）'), element('p', base.revision || base.body ? '已保留当前比较范围，可以按需调整。' : '已带入主题内未排除的文献，可以调整本次比较范围。', 'hint'), documentBox, element('h3', '比较维度（1–12 项）'), columnBox, add, element('p', '移除行或维度的旧内容仍保留在版本记录中。', 'hint')], () => ({ title: title.node.value, question: question.node.value, documentIds: checks.filter(check => check.checked).map(check => check.value), columns: [...columnBox.children].map(row => ({ id: row.dataset.columnId, name: row.querySelector('.column-name').value, description: row.querySelector('.column-description').value })) }))
  }
  async function editCell(documentId, columnId, draft = null, loadedSources = null) {
    const target = table, token = ++editorEpoch, navigation = navigationKey()
    const sourceData = loadedSources || await api(`/api/comparisons/${target.id}/sources/${documentId}`)
    if (token !== editorEpoch || navigation !== navigationKey() || tableId !== target.id) return
    const cell = target.cells.find(item => item.documentId === documentId && item.columnId === columnId)
    const data = draft?.body || cell, state = draft || { kind: 'cell', tableId: target.id, topicId: target.topicId, revision: target.revision, documentId, columnId }
    let source = data.source
    const value = input('比较内容', 'cmp-value', data.value, true), status = select('信息状态', 'cmp-status', statuses, data.status), kind = select('判断类型', 'cmp-kind', kinds, data.kind)
    const conditions = input('适用条件', 'cmp-conditions', data.conditions, true, 2000), comparable = select('可比性', 'cmp-comparability', comparabilities, data.comparability), reason = input('可比性理由', 'cmp-reason', data.reason, true, 2000)
    value.node.rows = 5; value.node.placeholder = '先记录这篇文献在当前维度上的内容，也可以从已有笔记填入。'
    conditions.node.rows = 2; reason.node.rows = 2
    const reasonBox = element('div', null, 'comparison-reason'); reasonBox.append(reason.wrapper)
    function showReason() { reasonBox.hidden = !['conditional', 'not_comparable'].includes(comparable.node.value) && !reason.node.value.trim() }
    comparable.node.onchange = showReason; showReason()
    const states = element('div', null, 'field-pair'); states.append(status.wrapper, comparable.wrapper)
    const attributes = details(`${kinds[data.kind]} · 适用条件${data.conditions ? '已填写' : '可选'}`, 'cmp-details', [kind.wrapper, conditions.wrapper], Boolean(data.conditions))
    function updateSummary() { attributes.querySelector('summary').textContent = `${kinds[kind.node.value]} · 适用条件${conditions.node.value.trim() ? '已填写' : '可选'}` }
    const noteChoice = select('选择已有笔记', 'cmp-note-choice', { '': '请选择笔记', ...Object.fromEntries(sourceData.notes.map(note => [note.id, `${note.field} · ${note.content.slice(0, 80) || statuses[note.status]}`])) }, '')
    function allowInference(allowed) { kind.node.querySelector('[value="inference"]').disabled = !allowed; if (!allowed && kind.node.value === 'inference') kind.node.value = 'user'; updateSummary() }
    allowInference(cell.origin.generatedKind === 'inference' || (source?.type === 'note' && sourceData.notes.find(note => note.id === source.noteId)?.kind === 'inference'))
    value.node.oninput = () => { if (status.node.value === 'unfilled' && value.node.value.trim()) status.node.value = 'recorded' }
    const copyNote = button('从笔记填入', () => {
      const note = sourceData.notes.find(note => note.id === noteChoice.node.value)
      if (!note) throw new Error('请先选择笔记。')
      source = { type: 'note', noteId: note.id, revision: note.revision }
      allowInference(note.kind === 'inference'); value.node.value = note.status === 'recorded' ? note.content : ''; status.node.value = note.status; kind.node.value = note.kind
      if (note.status !== 'recorded' && note.content) conditions.node.value = note.content
      updateSummary()
      $('cmp-source-description').textContent = `已选笔记：${note.field} · 版本 ${note.revision}`; changed()
    })
    const quoteBox = element('div', null, 'comparison-reference-options'); quoteBox.hidden = source?.type !== 'passages'
    const query = input('筛选原文片段', 'cmp-reference-query', '', false, 500), refs = element('div', null, 'attach-options')
    const selectedIds = new Set(source?.type === 'passages' ? source.referenceIds : cell.evidence.filter(item => item.matchesCurrent).map(item => item.reference.id))
    function drawRefs() {
      const matching = sourceData.document.references.filter(ref => `${ref.title} ${ref.text}`.toLowerCase().includes(query.node.value.toLowerCase())).slice(0, 50)
      refs.replaceChildren(...matching.map(ref => {
        const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.checked = selectedIds.has(ref.id)
        check.onchange = () => { if (check.checked) selectedIds.add(ref.id); else selectedIds.delete(ref.id); changed() }
        label.append(check, element('span', `${ref.title} · ${ref.text.slice(0, 130)}`)); return label
      }))
    }
    query.node.oninput = drawRefs; drawRefs(); quoteBox.append(query.wrapper, refs)
    const chooseRefs = button('选择当前原文', () => {
      source = { type: 'passages', referenceIds: [...selectedIds], documentVersion: sourceData.document.evidenceVersion }
      quoteBox.hidden = false; allowInference(false)
      $('cmp-source-description').textContent = '已切换到当前原文，保存时关联勾选的片段。'; changed()
    })
    const evidence = element('div', null, 'note-evidence'); for (const item of cell.evidence) evidence.append(evidenceButton(item))
    const sourceDescription = element('p', source?.type === 'note' ? '继续使用草稿中选定的笔记版本。' : '未更换来源时保留当前证据快照。', 'hint'); sourceDescription.id = 'cmp-source-description'
    const sources = details('从笔记或原文补充', 'cmp-sources', [noteChoice.wrapper, copyNote, chooseRefs, quoteBox], source?.type === 'passages')
    if (!sourceData.notes.length) { noteChoice.wrapper.hidden = true; copyNote.hidden = true }
    kind.node.onchange = updateSummary; conditions.node.oninput = updateSummary
    showEditor(state, `${target.columns.find(col => col.id === columnId).name} · 比较项`, [element('p', sourceData.document.title, 'dialog-context'), value.wrapper, states, reasonBox, attributes, element('h3', '内容依据'), sourceDescription, evidence, sources], () => ({ value: value.node.value, status: status.node.value, kind: kind.node.value, conditions: conditions.node.value, comparability: comparable.node.value, reason: reason.node.value, ...(source ? { source: source.type === 'passages' ? { ...source, referenceIds: [...selectedIds] } : source } : {}) }))
  }
  function editAnalysis(columnId, draft = null) {
    const current = table.analyses.find(item => item.columnId === columnId), data = draft?.body || current || { value: '', relation: 'insufficient', conditions: '' }
    const state = draft || { kind: 'analysis', tableId: table.id, topicId: table.topicId, revision: table.revision, columnId }
    const value = input('跨文献判断', 'cmp-analysis-value', data.value, true), relation = select('关系类型', 'cmp-relation', relations, data.relation), conditions = input('条件差异或材料不足', 'cmp-analysis-conditions', data.conditions, true, 2000)
    value.node.required = true
    const chosen = new Set(data.documentIds || current?.rows.map(row => row.documentId) || table.documentIds), rows = element('div'), checks = []
    for (const doc of table.documents) { const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.value = doc.id; check.checked = chosen.has(doc.id); checks.push(check); label.append(check, element('span', doc.title)); rows.append(label) }
    showEditor(state, `${table.columns.find(col => col.id === columnId).name} · 综合判断`, [value.wrapper, relation.wrapper, details('条件差异或材料不足（可选）', 'cmp-analysis-details', [conditions.wrapper], Boolean(data.conditions)), details('判断所依据的文献 · 已带入当前范围', 'cmp-analysis-sources', [rows, element('p', '保存这些行的当前比较项与证据快照。材料不足只能针对已选范围作出说明。', 'hint')])], () => ({ relation: relation.node.value, value: value.node.value, conditions: conditions.node.value, documentIds: checks.filter(check => check.checked).map(check => check.value) }))
  }
  function changed() { if (editor && !saving) { editor = { ...editor, dirty: true }; persistEditor() } }
  $('comparison-form').oninput = changed
  $('comparison-form').onchange = changed
  $('comparison-form').addEventListener('invalid', event => {
    for (let node = event.target.parentElement; node && node !== $('comparison-form'); node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true
  }, true)
  $('comparison-editor-close').onclick = () => { if (!saving) { persistEditor(); editor = null; editorEpoch++; $('comparison-editor').close(); renderDrafts() } }
  $('comparison-editor').oncancel = event => { if (saving) event.preventDefault(); else { persistEditor(); editor = null; editorEpoch++; renderDrafts() } }
  async function resume(draft) {
    if (draft.kind === 'config') return configure(draft)
    if (!table || draft.tableId !== table.id) return
    if (!table.columns.some(col => col.id === draft.columnId) || (draft.documentId && !table.documentIds.includes(draft.documentId))) {
      const nodes = [element('p', '草稿对应的维度或文献已移除，内容仍保留。可以复制下面的内容，或恢复原范围后继续编辑。', 'notice')]
      for (const [label, value] of [['未保存内容', draft.body.value], ['适用条件', draft.body.conditions], ['可比性理由', draft.body.reason]]) {
        if (value) nodes.push(element('h3', label), element('p', value, 'comparison-value'))
      }
      inspect('保留的比较草稿', nodes)
      return
    }
    if (draft.kind === 'cell') return editCell(draft.documentId, draft.columnId, draft)
    return editAnalysis(draft.columnId, draft)
  }
  $('comparison-resume').onclick = () => { const draft = drafts().find(item => item.key === $('comparison-draft-choice').value); if (draft) void resume(draft).catch(error => notice(error.message, true)) }
  $('comparison-discard').onclick = () => { sessionStorage.removeItem($('comparison-draft-choice').value); renderDrafts() }
  $('comparison-editor-latest').onclick = async () => {
    const target = editor, ticket = editorEpoch, navigation = navigationKey()
    try {
      const latest = await api(`/api/comparisons/${target.tableId}`)
      if (target.kind !== 'config' && (!latest.columns.some(col => col.id === target.columnId) || (target.documentId && !latest.documentIds.includes(target.documentId)))) throw new Error('当前维度或文献已移除，草稿仍保留。可以复制内容或恢复原范围后继续。')
      const sourceData = target.kind === 'cell' ? await api(`/api/comparisons/${target.tableId}/sources/${target.documentId}`) : null
      const topic = target.kind === 'config' ? await api(`/api/topics/${target.topicId}`) : null
      if (editor !== target || ticket !== editorEpoch || navigation !== navigationKey()) return
      const savedDraft = sessionStorage.getItem(draftKey(target))
      accept(latest)
      if (target.kind === 'config') await configure(null, topic)
      if (target.kind === 'cell') await editCell(target.documentId, target.columnId, null, sourceData)
      if (target.kind === 'analysis') editAnalysis(target.columnId)
      if (editor !== target && editor?.tableId === target.tableId && editor?.kind === target.kind && navigation === navigationKey() && sessionStorage.getItem(draftKey(target)) === savedDraft) sessionStorage.removeItem(draftKey(target))
      renderDrafts()
    } catch (error) { if (editor === target) $('comparison-editor-error').textContent = error.message }
  }
  $('comparison-form').onsubmit = async event => {
    event.preventDefault()
    if (!editor || saving) return
    persistEditor()
    const target = editor, body = target.read(), navigation = navigationKey()
    const controls = [...$('comparison-form').elements, $('comparison-editor-close')], disabled = controls.map(node => node.disabled)
    saving = true; controls.forEach(node => { node.disabled = true }); $('comparison-editor-error').textContent = ''
    try {
      let path = `/api/comparisons/${target.tableId}`, method = 'PATCH'
      if (!target.revision) { path = `/api/topics/${target.topicId}/comparisons`; method = 'POST'; body.id = target.tableId }
      else body.revision = target.revision
      if (target.kind === 'cell') path += `/cells/${target.documentId}/${target.columnId}`
      if (target.kind === 'analysis') path += `/analyses/${target.columnId}`
      const saved = await api(path, json(method, body))
      sessionStorage.removeItem(draftKey(target)); $('comparison-editor').close(); editor = null; editorEpoch++
      if (navigation === navigationKey()) {
        if (tableId === saved.id) accept(saved)
        else await open(saved.id)
        notice('比较表已保存。')
      }
    } catch (error) {
      if (editor === target) { $('comparison-editor-error').textContent = error.message; $('comparison-editor-latest').hidden = false }
    } finally { saving = false; controls.forEach((node, index) => { node.disabled = disabled[index] }) }
  }
  function renderSuggestions() {
    $('comparison-suggestions').replaceChildren(...table.suggestions.filter(run => run.purpose !== 'comparison-draft').map(run => {
      const card = element('article', null, 'comparison-analysis')
      card.append(element('h3', `${run.columnName} · 比较建议`))
      if (run.status === 'completed') card.append(button('审阅本列建议', () => inspectSuggestion(run)))
      else if (['queued', 'running'].includes(run.status)) card.append(element('p', '正在读取所选文献并生成建议…', 'hint'), button('停止生成', async () => { await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }); await refresh() }))
      else card.append(element('p', run.error || '任务已结束，可重新生成。', 'notice'))
      return card
    }))
  }
  function inspectSuggestion(run) {
    const target = table, token = epoch, nodes = []
    for (const cell of run.result.cells) {
      const section = element('section', null, 'comparison-analysis')
      section.append(element('h3', target.documents.find(doc => doc.id === cell.documentId)?.title || cell.documentId), element('p', cell.value || statuses[cell.status], 'comparison-value'), element('p', `${comparabilities[cell.comparability]}：${cell.reason} ${cell.conditions}`, 'hint'))
      for (const item of cell.evidence) section.append(evidenceButton(item))
      nodes.push(section)
    }
    nodes.push(element('h3', relations[run.result.analysis.relation]), element('p', run.result.analysis.value, 'comparison-value'), element('p', run.result.analysis.conditions, 'hint'))
    nodes.push(element('p', '采用后将更新本列全部比较项及综合判断，原内容进入版本记录。若生成期间本列已修改，会阻止覆盖。', 'notice'))
    const adopt = button('采用本列建议', async () => {
      adopt.disabled = true
      try {
        const updated = await api(`/api/comparisons/${target.id}/adopt`, json('POST', { revision: target.revision, runId: run.id }))
        if (token !== epoch) return
        $('comparison-inspector').close(); accept(updated); notice('本列建议已保存，仍需人工核对。')
      } catch (error) { if (token === epoch) $('comparison-inspector-error').textContent = error.message }
      finally { adopt.disabled = false }
    })
    nodes.push(adopt); inspect(`${run.columnName} · 审阅建议`, nodes)
  }
  $('comparison-generate').onclick = async () => {
    const target = table, token = epoch
    if (!target) return
    $('comparison-generate').disabled = true
    try {
      const run = await api(`/api/comparisons/${target.id}/suggestions`, json('POST', { revision: target.revision, columnId: $('comparison-column').value }))
      if (token !== epoch) return
      table.suggestions = [run, ...table.suggestions]; renderSuggestions(); schedule()
    } catch (error) { if (token === epoch) { render(); $('comparison-message').textContent = error.message } }
  }
  $('comparison-history').onclick = async () => {
    if (!table) return
    const target = table, token = epoch
    let full
    try { full = await api(`/api/comparisons/${target.id}/history`) }
    catch (error) { if (token === epoch) notice(error.message, true); return }
    if (token !== epoch) return
    const nodes = [...full.history].reverse().map(old => {
      const section = element('section', null, 'comparison-analysis')
      section.append(element('h3', `版本 ${old.revision} · ${old.title}`))
      for (const cell of old.cells) {
        const title = target.documents.find(doc => doc.id === cell.documentId)?.title || cell.evidence[0]?.documentTitle || '历史文献'
        section.append(element('p', `${title} · ${old.columns.find(col => col.id === cell.columnId)?.name || ''}：${cell.value || statuses[cell.status]}`, 'record-preview'))
        for (const item of cell.evidence) section.append(evidenceButton(item))
      }
      section.append(button('恢复为新版本', async () => {
        try {
          const updated = await api(`/api/comparisons/${target.id}`, json('PATCH', { revision: target.revision, restoreRevision: old.revision }))
          if (token === epoch) { $('comparison-inspector').close(); accept(updated) }
        } catch (error) { if (token === epoch) $('comparison-inspector-error').textContent = error.message }
      })); return section
    })
    inspect('比较表版本记录', nodes.length ? nodes : [element('p', '还没有历史版本。', 'hint')])
  }
  $('comparison-inspector-close').onclick = () => $('comparison-inspector').close()
  $('comparison-configure').onclick = () => configure().catch(error => notice(error.message, true))
  $('comparison-archive').onclick = () => mutate(`/api/comparisons/${table.id}`, { archived: !table.archived }).catch(error => notice(error.message, true))
  $('comparison-back').onclick = () => showTopic(currentTopic().id)
  $('comparison-retry').onclick = refresh
  $('new-comparison').onclick = () => { table = null; void configure().catch(error => notice(error.message, true)) }
  function taskKey(topic) { return 'classifier-research-task:' + topic.id }
  function readTask(topic) { try { return JSON.parse(sessionStorage.getItem(taskKey(topic))) } catch { return null } }
  function captureTask() {
    if (!taskTopic || taskBusy) return
    const previous = readTask(taskTopic)
    const next = { goal: $('research-task-goal').value, documentIds: [...$('research-task-documents').querySelectorAll('input:checked')].map(node => node.value) }
    if (previous?.goal === next.goal && JSON.stringify(previous.documentIds) === JSON.stringify(next.documentIds)) Object.assign(next, { id: previous.id, requestId: previous.requestId, title: previous.title })
    sessionStorage.setItem(taskKey(taskTopic), JSON.stringify(next))
    updateTaskScope()
  }
  function updateTaskScope() {
    const count = $('research-task-documents').querySelectorAll('input:checked').length
    $('research-task-scope').textContent = '已选 ' + count + ' 篇文献 · 调整范围'
    $('research-task-start').disabled = taskBusy || !modelConfigured() || count < 2 || count > 12
    const next = $('research-task-next'), total = taskTopic?.documents.length || 0
    $('research-task-input').hidden = total < 2
    $('research-task-start').hidden = total < 2
    next.hidden = false
    if (!total) {
      $('research-task-title').textContent = '先添加研究文献'
      $('research-task-hint').textContent = '导入新文献，或关联已有资料。'
      next.textContent = '导入文献'; next.onclick = () => $('topic-import').click()
    } else if (total === 1) {
      $('research-task-title').textContent = '开始阅读'
      $('research-task-hint').textContent = '可先阅读这一篇；比较需要至少两篇文献。'
      next.textContent = '阅读本篇'; next.onclick = () => openDocument(taskTopic.documents[0].documentId)
    } else if (count < 2 || count > 12) {
      $('research-task-title').textContent = '比较文献'
      $('research-task-hint').textContent = count > 12 ? `已选 ${count} 篇，最多 12 篇。请调整本次比较范围。` : '请至少选择两篇文献。'
      next.textContent = '调整选择'; next.onclick = () => { $('research-task-scope').parentElement.open = true; $('research-task-scope').focus() }
    } else if (!modelConfigured()) {
      $('research-task-title').textContent = '比较文献'
      $('research-task-hint').textContent = '尚未配置模型，可手工比较或连接模型生成草稿。'
      next.textContent = '连接模型'; next.onclick = () => $('model-settings-open').click()
    } else {
      $('research-task-title').textContent = '比较文献'
      $('research-task-hint').textContent = '将所选文献节选与笔记发送至已配置的模型服务。'
      next.hidden = true
    }
  }
  function renderTaskComposer(topic) {
    taskTopic = topic
    const draft = readTask(topic)
    $('research-task-goal').value = draft?.goal ?? topic.question
    $('research-task-error').textContent = ''
    const selected = draft?.documentIds || topic.documents.filter(link => link.selection !== 'excluded' && !link.document.unavailable).map(link => link.documentId)
    $('research-task-documents').replaceChildren(...topic.documents.map(link => {
      const row = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.value = link.documentId; check.checked = !link.document.unavailable && selected.includes(link.documentId); check.disabled = Boolean(link.document.unavailable)
      row.append(check, element('span', link.document.title + (link.document.unavailable ? '（暂不可用，请先核对资料库）' : link.selection === 'excluded' ? '（已排除）' : ''))); return row
    }))
    updateTaskScope()
  }
  $('research-task-form').oninput = captureTask
  $('research-task-form').onchange = captureTask
  $('research-task-form').onsubmit = async event => {
    event.preventDefault(); if (taskBusy || !taskTopic) return
    captureTask()
    const topic = taskTopic, draft = readTask(topic), nav = navigationKey()
    if (draft.documentIds.length < 2 || draft.documentIds.length > 12) return
    draft.id ||= crypto.randomUUID(); draft.requestId ||= crypto.randomUUID()
    draft.title ||= (topic.title + ' · AI 比较').slice(0, 200)
    sessionStorage.setItem(taskKey(topic), JSON.stringify(draft))
    taskBusy = true; updateTaskScope(); $('research-task-error').textContent = ''
    let created
    try {
      created = await api('/api/topics/' + topic.id + '/comparisons', json('POST', { id: draft.id, title: draft.title, question: draft.goal, documentIds: draft.documentIds }))
      await api('/api/comparisons/' + created.id + '/draft', json('POST', { revision: created.revision, instruction: draft.goal, requestId: draft.requestId }))
      sessionStorage.removeItem(taskKey(topic))
      if (nav === navigationKey()) await open(created.id)
    } catch (error) {
      if (nav === navigationKey()) {
        if (created) { await open(created.id); $('comparison-message').textContent = error.message + ' 可在此重试生成。' }
        else $('research-task-error').textContent = error.message
      }
    } finally { taskBusy = false; updateTaskScope() }
  }
  $('comparison-task-goal').oninput = () => { if (table) sessionStorage.setItem('classifier-research-followup:' + table.id, $('comparison-task-goal').value) }
  $('comparison-task-form').onsubmit = async event => {
    event.preventDefault(); const target = table, token = epoch
    if (!target || $('comparison-draft-generate').disabled) return
    $('comparison-draft-generate').disabled = true
    const requestKey = 'classifier-research-request:' + target.id
    const instruction = $('comparison-task-goal').value.trim() || target.question
    let request
    try { request = JSON.parse(sessionStorage.getItem(requestKey)) } catch {}
    const observed = target.suggestions.find(run => run.requestId === request?.requestId)
    if (!request || request.revision !== target.revision || request.instruction !== instruction || observed && !['queued', 'running'].includes(observed.status)) request = { revision: target.revision, instruction, requestId: crypto.randomUUID() }
    sessionStorage.setItem(requestKey, JSON.stringify(request))
    try {
      const run = await api('/api/comparisons/' + target.id + '/draft', json('POST', request))
      sessionStorage.removeItem(requestKey)
      if (token !== epoch) return
      table.suggestions = [run, ...table.suggestions.filter(item => item.id !== run.id)]; render()
    } catch (error) { if (token === epoch) { render(); $('comparison-message').textContent = error.message } }
  }
  $('comparison-to-report').onclick = async () => {
    if (!table) return
    const target = table, token = epoch; $('comparison-to-report').disabled = true
    try { await openReport(target) }
    catch (error) { if (token === epoch) { render(); $('comparison-message').textContent = error.message } }
  }
  function renderTaskResult() {
    const target = table, token = epoch
    const run = table.suggestions.find(run => run.purpose === 'comparison-draft')
    $('comparison-draft-preview').replaceChildren(); $('comparison-task-status').replaceChildren()
    if (!run) return
    if (['queued', 'running'].includes(run.status)) {
      const progress = element('div', null, 'research-progress')
      progress.append(element('strong', 'AI 正在整理所选文献'), ...run.events.filter(event => ['plan', 'progress'].includes(event.type)).slice(-2).map(event => element('p', event.message)), button('停止任务', async () => { await api('/api/runs/' + run.id + '/cancel', { method: 'POST' }); if (token === epoch) await refresh() }))
      $('comparison-task-status').append(progress); return
    }
    if (run.status !== 'completed') { $('comparison-task-status').append(element('p', (run.error || '任务中断。') + ' 已保存的比较内容不受影响，可重新生成。', 'notice')); return }
    if (table.lastDraftRunId === run.id) { $('comparison-task-status').append(element('p', '比较草稿已采用。', 'hint')); return }
    if (sessionStorage.getItem(`classifier-comparison-dismissed-draft:${run.id}`) === '1') { $('comparison-task-status').append(element('p', '已放弃此比较草稿。', 'hint')); return }
    const draft = element('div', null, 'research-draft')
    draft.append(element('h2', 'AI 比较草稿 · 待核对'), element('p', '以下内容基于所选文献的部分证据；未找到不代表论文未报告。采用会更新全部维度与内容，原版本保留。', 'hint'))
    const wrapper = element('div', null, 'comparison-grid'), matrix = element('table'), head = element('thead'), heading = element('tr')
    heading.append(element('th', '文献')); run.result.columns.forEach(col => heading.append(element('th', col.name))); head.append(heading); matrix.append(head)
    const body = element('tbody')
    const documents = run.documentVersions || [...new Set(run.result.cells.map(cell => cell.documentId))].map(id => ({ id }))
    for (const doc of documents) {
      const title = doc.title || table.documents.find(item => item.id === doc.id)?.title || run.result.cells.find(cell => cell.documentId === doc.id)?.evidence[0]?.documentTitle || '原任务文献'
      const row = element('tr'); row.append(element('th', title))
      for (const col of run.result.columns) {
        const cell = run.result.cells.find(cell => cell.documentId === doc.id && cell.columnId === col.id), td = element('td')
        if (!cell) { td.append(element('p', '此草稿未包含该项', 'hint')); row.append(td); continue }
        td.append(element('p', cell.value || statuses[cell.status], 'comparison-value'), element('p', kinds[cell.kind] + ' · ' + comparabilities[cell.comparability], 'hint'))
        if (cell.conditions || cell.reason) td.append(element('p', [cell.conditions, cell.reason].filter(Boolean).join('；'), 'hint'))
        cell.evidence.forEach(item => td.append(evidenceButton(item))); row.append(td)
      }
      body.append(row)
    }
    matrix.append(body); wrapper.append(matrix); draft.append(wrapper)
    for (const analysis of run.result.analyses) {
      draft.append(element('h3', run.result.columns.find(col => col.id === analysis.columnId).name + ' · ' + relations[analysis.relation]), element('p', analysis.value, 'comparison-value'), element('p', analysis.conditions, 'hint'))
      analysis.evidence.forEach(item => draft.append(evidenceButton(item)))
    }
    const actions = element('div', null, 'research-draft-actions'), errorNode = element('p', '', 'form-error')
    errorNode.setAttribute('role', 'alert')
    const apply = button('采用比较草稿', async () => {
      apply.disabled = true
      try {
        const updated = await api('/api/comparisons/' + target.id + '/adopt-draft', json('POST', { revision: target.revision, runId: run.id }))
        if (token === epoch) { accept(updated); notice('比较草稿已保存，可核对并生成研究总结。') }
      } catch (error) { if (token === epoch) errorNode.textContent = error.message }
      finally { apply.disabled = false }
    }, '')
    const discard = button('放弃草稿', () => {
      sessionStorage.setItem(`classifier-comparison-dismissed-draft:${run.id}`, '1')
      renderTaskResult(); syncSavedVisibility()
    })
    if (run.stale || table.archived || run.baseRevision !== table.revision) { apply.disabled = true; errorNode.textContent = table.archived ? '比较表已归档，请先恢复后再生成。' : '比较表或来源已修改，请重新生成；旧草稿按原范围保留供参考。' }
    actions.append(apply, discard); draft.append(actions, errorNode); $('comparison-draft-preview').append(draft)
  }
  return { open, reset, showTopic: showTopicComparisons, updateModel() { updateTaskScope(); if (table) render() } }
}
