export function createComparisonWorkspace({ api, element, currentTopic, enter, navigationKey, showTopic, openSource, modelConfigured, notice }) {
  const $ = id => document.getElementById(id)
  const statuses = { unfilled: '未填写', recorded: '已记录', not_reported: '未报告', not_found: '未找到', not_applicable: '不适用' }
  const kinds = { user: '用户判断', source: '原文报告', inference: '模型归纳' }
  const comparabilities = { unchecked: '待判断', comparable: '可比较', conditional: '有条件可比', not_comparable: '不可直接比较' }
  const relations = { agreement: '共同点', difference: '差异', conflict: '相互冲突', insufficient: '材料不足' }
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let table = null, tableId = null, epoch = 0, readVersion = 0, topicVersion = 0, editorEpoch = 0, editor = null, saving = false, timer
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
  }
  async function open(id) {
    const navigation = enter(id), token = ++epoch
    tableId = id
    $('comparison-title').textContent = '正在打开比较表…'; $('comparison-question').textContent = ''
    $('comparison-grid').replaceChildren(); $('comparison-analyses').replaceChildren(); $('comparison-suggestions').replaceChildren()
    $('comparison-message').textContent = ''; $('comparison-retry').hidden = true
    for (const name of ['comparison-configure', 'comparison-history', 'comparison-archive', 'comparison-generate']) $(name).disabled = true
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
    const token = ++topicVersion
    $('comparison-list').replaceChildren(element('p', '正在读取比较表…', 'hint'))
    try {
      const result = await api(`/api/topics/${topic.id}/comparisons`)
      if (token !== topicVersion) return
      $('comparison-list').replaceChildren(...result.comparisons.map(item => {
        const card = element('article', null, 'document-card'), info = element('div', null, 'document-card-body')
        info.append(element('h3', item.title), element('p', `${item.documentCount} 篇文献 · ${item.columnCount} 个维度 · 版本 ${item.revision}${item.archived ? ' · 已归档' : ''}`, 'hint'))
        card.append(info, button('打开比较', () => open(item.id))); return card
      }))
      const pending = drafts(topic.id, null).filter(value => value.kind === 'config' && !value.revision && !result.comparisons.some(item => item.id === value.tableId))
      for (const draft of pending) $('comparison-list').append(button(`继续创建：${draft.body.title || '未命名比较表'}`, () => configure(draft)))
      if (!result.comparisons.length && !pending.length) $('comparison-list').append(element('p', '选定两篇或更多文献，开始整理证据与差异。', 'collection-empty'))
    } catch (error) { if (token === topicVersion) $('comparison-list').replaceChildren(element('p', error.message, 'form-error')) }
  }
  function evidenceButton(item) { return button(`出处：${item.reference.title}`, () => inspectEvidence(item), 'quiet-button comparison-citation') }
  function inspect(title, nodes) {
    $('comparison-inspector-title').textContent = title; $('comparison-inspector-body').replaceChildren(...nodes)
    $('comparison-inspector-error').textContent = ''
    if (!$('comparison-inspector').open) $('comparison-inspector').showModal()
  }
  function inspectEvidence(item) {
    const valid = item.matchesCurrent ?? table?.documents.find(doc => doc.id === item.documentId)?.evidenceVersion === item.documentVersion
    const nodes = [element('p', `${item.documentTitle} · ${item.reference.title}`, 'hint'), element('blockquote', item.reference.text, 'comparison-quote')]
    nodes.push(element('p', valid ? (item.reference.needsReview ? '识别结果需要对照原文核对。' : '请核对这段原文是否支持比较项。') : '原文版本已变化或无法确认，下面保留的是保存时的证据。', 'notice'))
    const go = button('打开原文位置', async () => {
      persistEditor(); $('comparison-editor').close(); editor = null; editorEpoch++
      $('comparison-inspector').close(); await openSource(item, table.id)
    })
    go.disabled = !valid
    nodes.push(go); inspect('比较项出处', nodes)
  }
  function render() {
    $('comparison-title').textContent = table.title
    $('comparison-question').textContent = table.question
    $('comparison-message').textContent = table.archived ? '此比较表已归档，可恢复后继续生成建议。' : table.documents.some(doc => !doc.linked) ? '部分文献已移出主题，旧比较与证据仍保留。生成新建议前请调整范围。' : ''
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
        td.append(element('span', `${statuses[cell.status]} · ${kinds[cell.kind]}`, 'note-labels'))
        if (cell.value) td.append(element('p', cell.value, 'comparison-value'))
        if (cell.conditions) td.append(element('p', `条件：${cell.conditions}`, 'record-preview'))
        td.append(element('p', `${comparabilities[cell.comparability]}${cell.reason ? `：${cell.reason}` : ''}`, 'comparison-condition'))
        const stale = cell.noteChanged || cell.evidence.some(item => !item.matchesCurrent)
        if (stale) td.append(element('p', cell.noteChanged ? '来源笔记已更新，当前保留旧版本内容。' : '原文版本已变化，请复核。', 'notice'))
        else if (cell.reviewState === 'checked') td.append(element('p', '已人工核对', 'hint'))
        else if (cell.evidence.length) td.append(element('p', '待人工核对', 'hint'))
        const actions = element('div', null, 'note-actions')
        actions.append(button('编辑比较项', () => editCell(doc.id, col.id)))
        if (cell.evidence.length) actions.append(button(`查看出处 (${cell.evidence.length})`, () => inspect(`${doc.title} · ${col.name}`, cell.evidence.map(evidenceButton))))
        if (!stale && cell.evidence.length && cell.reviewState !== 'checked') actions.append(button('标记已核对', () => mutate(`/api/comparisons/${table.id}/cells/${doc.id}/${col.id}`, { reviewState: 'checked' })))
        td.append(actions); tr.append(td)
      }
      body.append(tr)
    }
    matrix.append(body); $('comparison-grid').replaceChildren(matrix)
    $('comparison-analyses').replaceChildren(...table.columns.map(col => {
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
      } else card.append(element('p', '尚未记录跨文献判断。', 'hint'))
      card.append(button('编辑综合判断', () => editAnalysis(col.id))); return card
    }))
    const previous = $('comparison-column').value
    $('comparison-column').replaceChildren(...table.columns.map(col => { const option = element('option', col.name); option.value = col.id; return option }))
    if (table.columns.some(col => col.id === previous)) $('comparison-column').value = previous
    $('comparison-model-hint').textContent = modelConfigured() ? '每次针对一列读取所选文献的证据。建议经明确采用才更新表格，原版本会保留。' : '尚未配置模型，可以继续手工比较或从笔记、原文取值。'
    $('comparison-generate').disabled = !modelConfigured() || table.archived || table.documents.some(doc => !doc.linked) || table.suggestions.some(run => ['queued', 'running'].includes(run.status))
    renderSuggestions(); renderDrafts(); schedule()
  }
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
    const data = base.body || (base.revision ? table : { title: '文献比较', question: topic.question, documentIds: [], columns: ['方法', '研究对象', '主要发现', '局限'].map(name => ({ id: crypto.randomUUID(), name, description: '' })) })
    const title = input('比较表标题', 'cmp-title', data.title, false, 200), question = input('比较研究问题', 'cmp-question', data.question, true, 4000)
    title.node.required = true; question.node.required = true
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
      row.append(name.wrapper, description.wrapper, button('上移', () => { if (row.previousElementSibling) columnBox.insertBefore(row, row.previousElementSibling); changed() }), button('移除维度', () => { row.remove(); changed() }))
      columnBox.append(row)
    }
    data.columns.forEach(addColumn)
    const add = button('＋ 添加维度', () => { addColumn(); changed() })
    showEditor(base, base.revision ? '调整比较范围与维度' : '新建比较表', [title.wrapper, question.wrapper, element('h3', '选定文献（2–12 篇）'), documentBox, element('h3', '比较维度（1–12 项）'), columnBox, add, element('p', '移除行或维度的旧内容仍保留在版本记录中。', 'hint')], () => ({ title: title.node.value, question: question.node.value, documentIds: checks.filter(check => check.checked).map(check => check.value), columns: [...columnBox.children].map(row => ({ id: row.dataset.columnId, name: row.querySelector('.column-name').value, description: row.querySelector('.column-description').value })) }))
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
    const noteChoice = select('选择已有笔记', 'cmp-note-choice', { '': '请选择笔记', ...Object.fromEntries(sourceData.notes.map(note => [note.id, `${note.field} · ${note.content.slice(0, 80) || statuses[note.status]}`])) }, '')
    function allowInference(allowed) { kind.node.querySelector('[value="inference"]').disabled = !allowed; if (!allowed && kind.node.value === 'inference') kind.node.value = 'user' }
    allowInference(cell.origin.generatedKind === 'inference' || (source?.type === 'note' && sourceData.notes.find(note => note.id === source.noteId)?.kind === 'inference'))
    value.node.oninput = () => { if (status.node.value === 'unfilled' && value.node.value.trim()) status.node.value = 'recorded' }
    const copyNote = button('从笔记填入', () => {
      const note = sourceData.notes.find(note => note.id === noteChoice.node.value)
      if (!note) throw new Error('请先选择笔记。')
      source = { type: 'note', noteId: note.id, revision: note.revision }
      allowInference(note.kind === 'inference'); value.node.value = note.status === 'recorded' ? note.content : ''; status.node.value = note.status; kind.node.value = note.kind
      if (note.status !== 'recorded' && note.content) conditions.node.value = note.content
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
    showEditor(state, `${target.columns.find(col => col.id === columnId).name} · 比较项`, [element('p', sourceData.document.title, 'hint'), noteChoice.wrapper, copyNote, sourceDescription, value.wrapper, status.wrapper, kind.wrapper, conditions.wrapper, comparable.wrapper, reason.wrapper, evidence, chooseRefs, quoteBox], () => ({ value: value.node.value, status: status.node.value, kind: kind.node.value, conditions: conditions.node.value, comparability: comparable.node.value, reason: reason.node.value, ...(source ? { source: source.type === 'passages' ? { ...source, referenceIds: [...selectedIds] } : source } : {}) }))
  }
  function editAnalysis(columnId, draft = null) {
    const current = table.analyses.find(item => item.columnId === columnId), data = draft?.body || current || { value: '', relation: 'insufficient', conditions: '' }
    const state = draft || { kind: 'analysis', tableId: table.id, topicId: table.topicId, revision: table.revision, columnId }
    const value = input('跨文献判断', 'cmp-analysis-value', data.value, true), relation = select('关系类型', 'cmp-relation', relations, data.relation), conditions = input('条件差异或材料不足', 'cmp-analysis-conditions', data.conditions, true, 2000)
    value.node.required = true
    const chosen = new Set(data.documentIds || current?.rows.map(row => row.documentId) || table.documentIds), rows = element('div'), checks = []
    for (const doc of table.documents) { const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.value = doc.id; check.checked = chosen.has(doc.id); checks.push(check); label.append(check, element('span', doc.title)); rows.append(label) }
    showEditor(state, `${table.columns.find(col => col.id === columnId).name} · 综合判断`, [relation.wrapper, value.wrapper, conditions.wrapper, element('h3', '选择判断所依据的文献'), rows, element('p', '保存这些行的当前比较项与证据快照。材料不足只能针对已选范围作出说明。', 'hint')], () => ({ relation: relation.node.value, value: value.node.value, conditions: conditions.node.value, documentIds: checks.filter(check => check.checked).map(check => check.value) }))
  }
  function changed() { if (editor && !saving) { editor = { ...editor, dirty: true }; persistEditor() } }
  $('comparison-form').oninput = changed
  $('comparison-form').onchange = changed
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
    $('comparison-suggestions').replaceChildren(...table.suggestions.map(run => {
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
  return { open, reset, showTopic: showTopicComparisons }
}
