export function createReportWorkspace({ api, element, currentTopic, enter, navigationKey, showTopic, openSource, modelConfigured, notice, storage, updateTopicContent = () => {} }) {
  const sourceText = (state, noun = '原文') => ({ deleted: `${noun}已删除`, missing: `${noun}缺失`, corrupt: `${noun}记录损坏`, unavailable: `${noun}暂时无法读取` })[state] || ''
  const issueText = issues => [...new Set((issues || []).map(item => sourceText(item.state, '来源')))].filter(Boolean).join('、')
  const sessionStorage = storage?.drafts || globalThis.sessionStorage
  const $ = id => document.getElementById(id)
  const kinds = { source: '原文报告', inference: '模型归纳', user: '用户判断', question: '待验证问题' }
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const key = source => `${source.type}:${source.id || source.documentId}`
  const retain = source => ({ type: source.type, ...(source.id ? { id: source.id } : { documentId: source.documentId }), retain: true })
  const draftKey = state => `classifier-report-draft:${state.topicId}:${state.id}:${state.kind}`
  let report = null, reportId = null, epoch = 0, reads = 0, topicReads = 0, editVersion = 0, editor = null, saving = false, exporting = false, timer
  function button(label, action, className = 'quiet-button') {
    const node = element('button', label, className); node.type = 'button'
    node.onclick = () => Promise.resolve().then(action).catch(error => notice(error.message, true))
    return node
  }
  function input(label, id, value = '', multiline = false, max = 4000) {
    const wrapper = element('label', null, 'form-field'), node = element(multiline ? 'textarea' : 'input')
    node.id = id; node.value = value; node.maxLength = max
    wrapper.append(element('span', label), node); return { wrapper, node }
  }
  function drafts(topicId = currentTopic()?.id, id = reportId) {
    if (typeof sessionStorage === 'undefined') return []
    return Object.keys(sessionStorage).filter(key => key.startsWith(`classifier-report-draft:${topicId}:`)).flatMap(key => {
      try { const draft = JSON.parse(sessionStorage.getItem(key)); return !id || draft.id === id ? [{ ...draft, key }] : [] } catch { return [] }
    })
  }
  function persist() {
    if (!editor?.dirty || saving) return
    const { id, topicId, revision, kind } = editor
    sessionStorage.setItem(draftKey(editor), JSON.stringify({ id, topicId, revision, kind, body: editor.read() }))
  }
  function changed() { if (editor && !saving) { editor = { ...editor, dirty: true }; editVersion++; persist() } }
  function closeEditor() {
    if (saving) return false
    persist(); editor = null; editVersion++; $('report-editor').close(); renderDrafts()
    return true
  }
  function renderDrafts() {
    const values = report ? drafts(report.topicId, report.id) : []
    $('report-drafts').hidden = !values.length
    $('report-draft-choice').replaceChildren(...values.map(value => { const option = element('option', value.kind === 'sources' ? '未保存的材料选择' : '未保存的正文与标题'); option.value = value.key; return option }))
  }
  function reset() {
    persist(); epoch++; reads++; editVersion++; clearTimeout(timer)
    if (!saving) { editor = null; $('report-editor').close() }
    $('report-inspector').close(); report = null; reportId = null
  }
  function current(target, nav) { return reportId === target.id && navigationKey() === nav }
  async function open(id) {
    const nav = enter(id), token = ++epoch
    reportId = id
    $('report-title').textContent = '正在打开研究成果…'; $('report-question').textContent = ''
    $('report-body').replaceChildren(); $('report-sources').replaceChildren(); $('report-suggestions').replaceChildren()
    $('report-message').textContent = ''; $('report-retry').hidden = true; $('report-drafts').hidden = true
    controls(true)
    try {
      const value = await api(`/api/reports/${id}`)
      if (token !== epoch || nav !== navigationKey()) return
      accept(value)
    } catch (error) { if (token === epoch) { $('report-message').textContent = error.message; $('report-retry').hidden = false } }
  }
  function controls(disabled) { for (const id of ['report-edit', 'report-materials', 'report-assemble', 'report-history', 'report-archive', 'report-impact', 'report-generate', 'report-export', 'report-export-word']) $(id).disabled = disabled }
  function accept(value) { reads++; report = value; render() }
  function schedule() {
    clearTimeout(timer)
    if (report?.suggestions.some(run => ['queued', 'running'].includes(run.status))) timer = setTimeout(refresh, 1000)
  }
  async function refresh() {
    const token = epoch, ticket = ++reads, id = reportId
    try {
      const value = await api(`/api/reports/${id}`)
      if (token === epoch && ticket === reads && id === reportId) accept(value)
    } catch (error) { if (token === epoch) { $('report-message').textContent = error.message; schedule() } }
  }
  function inspect(title, nodes) {
    $('report-inspector-title').textContent = title; $('report-inspector-body').replaceChildren(...nodes)
    $('report-inspector-error').textContent = ''; if (!$('report-inspector').open) $('report-inspector').showModal()
  }
  function evidenceButton(item, target = report) {
    return button(`出处：${item.documentTitle} · ${item.reference.title}`, () => {
      const jump = button('打开原文位置', async () => {
        if (!closeEditor()) return
        $('report-inspector').close()
        await openSource(item, target.id)
      })
      jump.disabled = !item.matchesCurrent
      inspect('原文证据', [element('h3', item.documentTitle), element('p', item.reference.title, 'hint'), element('blockquote', item.reference.text, 'report-quote'), element('p', sourceText(item.sourceState) ? `${sourceText(item.sourceState)}，保存时的摘录仍保留。请先检查资料。` : item.matchesCurrent ? '保存的摘录与当前原文版本一致。' : '原文版本已变化或不可用，保留保存时的摘录。', 'hint'), jump])
    }, 'quiet-button report-citation')
  }
  function blockNode(block, value = report, editable = false) {
    const node = element('article', null, 'report-block'); node.dataset.blockId = block.id
    node.append(element('h2', block.section), element('p', `${kinds[block.kind]} · ${block.reviewState === 'checked' && !block.outdated ? '已核对' : '待核对'}${block.outdated ? ' · 依据已变化' : ''}`, 'hint'), element('p', block.text || '尚未填写正文', 'report-prose'))
    if (sourceText(block.sourceState, '来源材料')) node.append(element('p', `${sourceText(block.sourceState, '来源材料')}，保留已保存段落。`, 'notice'))
    for (const id of block.citationIds) { const item = value.evidence.find(item => item.id === id); if (item) node.append(evidenceButton(item, value)) }
    if (editable && block.text) {
      const check = button('确认本段已核对', () => update({ reviewBlockId: block.id }))
      check.disabled = report.archived || block.outdated; node.append(check)
    }
    return node
  }
  function proposalUnavailable(run) {
    return report.archived || run.baseRevision !== report.revision || report.sources.some(source => source.changed)
  }
  function proposalEvidence(items) {
    return items.map(item => {
      const current = report.evidence.find(ref => ref.id === item.id)
      return { ...item, sourceState: current?.sourceState, matchesCurrent: current?.matchesCurrent || false }
    })
  }
  function render() {
    controls(false)
    $('report-title').textContent = report.title; $('report-question').textContent = report.question
    $('report-impact').dataset.deletionId = report.id
    const hasText = report.blocks.some(block => block.text.trim())
    const proposal = report.suggestions.find(run => run.status === 'completed' && run.baseRevision === report.revision)
    const pending = report.suggestions.some(run => ['queued', 'running'].includes(run.status))
    $('report-message').textContent = issueText(report.sourceIssues) ? `${issueText(report.sourceIssues)}，旧正文与引用仍保留。请先检查资料。` : report.archived ? '成果已归档。' : report.sources.some(source => source.changed) ? '研究材料已有更新，正文与引用仍保留保存时的版本。请复核所选材料。' : !hasText && proposal ? '当前为待采用草稿，采用后可编辑和导出。' : hasText ? `已保存 · ${report.blocks.length} 段${proposal || pending ? '；导出使用已保存正文' : ''}` : ''
    for (const id of ['report-export', 'report-export-word']) {
      $(id).disabled = !hasText || exporting
      $(id).title = hasText ? `导出已保存版本 ${report.revision}` : '先采用草稿或保存正文，再导出'
    }
    $('report-edit').disabled = report.archived || (!hasText && Boolean(proposal || pending))
    $('report-edit').textContent = hasText ? '编辑正文' : proposal || pending ? '采用后编辑' : '开始写作'
    $('report-pending').replaceChildren()
    if (hasText && proposal) $('report-pending').append(button('审阅研究草稿', () => suggestion(proposal)))
    $('report-body').replaceChildren(...(hasText ? report.blocks : []).map(block => blockNode(block, report, true)))
    if (!hasText) {
      if (proposal) {
        const preview = element('section', null, 'research-draft'), target = report, nav = navigationKey()
        const value = { ...report, blocks: proposal.result.blocks, evidence: proposalEvidence(proposal.result.evidence) }
        const adopt = button('采用研究总结', async () => {
          adopt.disabled = true
          try { await update({ runId: proposal.id }, '/adopt', 'POST') }
          catch (error) { if (current(target, nav)) notice(error.message, true) }
          finally { adopt.disabled = false }
        }, '')
        adopt.disabled = proposalUnavailable(proposal)
        preview.append(element('h2', '研究总结草稿 · 待核对'), ...value.blocks.map(block => blockNode(block, value)), adopt)
        if (adopt.disabled) preview.append(element('p', '成果已归档或研究材料已变化，请恢复成果并更新所选材料，再重新生成。', 'notice'))
        $('report-body').append(preview)
      } else $('report-body').append(element('p', pending ? '正在生成研究总结…' : '直接开始写作，或选择材料整理正文。', 'collection-empty'))
    }
    $('report-sources').replaceChildren(...report.sources.map(source => {
      const node = element('article', null, 'report-material')
      node.append(element('h3', source.title), element('p', `${source.revision ? `版本 ${source.revision} · ` : ''}${source.evidence.length} 个原文片段${source.changed ? ' · 材料已变化' : ''}`, 'hint'))
      const unavailable = sourceText(source.sourceState, '来源材料') || [...new Set(source.documents.map(doc => sourceText(doc.sourceState)))].filter(Boolean).join('、')
      if (unavailable) node.append(element('p', `${unavailable}，保留已选材料快照。`, 'notice'))
      const details = element('details'); details.append(element('summary', '查看所选证据'))
      for (const item of source.evidence) details.append(evidenceButton(report.evidence.find(ref => ref.id === item.id) || item))
      node.append(details); return node
    }))
    if (!report.sources.length) $('report-sources').append(element('p', '尚未选择材料。', 'hint'))
    $('report-archive').textContent = report.archived ? '恢复归档' : '归档'
    for (const name of ['report-materials', 'report-assemble']) $(name).disabled = report.archived
    $('report-assemble').disabled ||= !report.sources.length
    $('report-generate').disabled = report.archived || report.sources.some(source => source.changed) || !modelConfigured() || !report.sources.length || report.suggestions.some(run => ['queued', 'running'].includes(run.status))
    $('report-material-summary').textContent = `研究材料 ${report.sources.length} 项 · 查看与调整`
    $('report-model-hint').textContent = modelConfigured() ? '将所选材料发送至已配置服务；采用后替换正文，原版本保留。' : '尚未配置模型，可手工写作。'
    const adopted = new Set(report.blocks.map(block => block.origin?.runId).filter(Boolean))
    const older = []
    const renderRun = run => {
      const node = element('article', null, 'report-material')
      if (run.status === 'completed') node.append(button('审阅研究草稿', () => suggestion(run)))
      else if (['queued', 'running'].includes(run.status)) node.append(element('p', '正在组织所选研究材料…'), button('停止生成', async () => { await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }); await refresh() }))
      else node.append(element('p', run.error || '任务已结束，可重新生成。', 'hint'))
      return node
    }
    const currentRuns = report.suggestions.filter(run => {
      if (run === proposal) return false
      if (run.status === 'completed' || adopted.has(run.id)) { older.push(run); return false }
      return true
    })
    $('report-suggestions').replaceChildren(...currentRuns.map(renderRun))
    if (older.length) { const history = element('details'); history.append(element('summary', `以往生成记录（${older.length}）`), ...older.map(run => {
      const node = element('article', null, 'report-material')
      node.append(element('p', adopted.has(run.id) ? '已采用的草稿' : '旧草稿', 'hint'), button('查看旧草稿', () => suggestion(run))); return node
    })); $('report-suggestions').append(history) }
    renderDrafts(); schedule()
  }
  async function showTopicReports(topic) {
    const ticket = ++topicReads, nav = navigationKey()
    $('report-list').replaceChildren(element('p', '正在读取研究成果…', 'hint'))
    try {
      const value = await api(`/api/topics/${topic.id}/reports`)
      if (ticket !== topicReads || nav !== navigationKey()) return
      updateTopicContent(topic.id, 'reports', value.reports, open)
      const cardFor = item => {
        const card = element('article', null, 'document-card'), info = element('div', null, 'document-card-body')
        info.append(element('h3', item.title), element('p', `${item.blockCount} 个段落${item.archived ? ' · 已归档' : ''}`, 'hint'))
        if (issueText(item.sourceIssues)) info.append(element('p', `${issueText(item.sourceIssues)}，保留已保存成果。`, 'notice'))
        card.append(info, button('打开成果', () => open(item.id))); return card
      }
      $('report-list').replaceChildren(...value.reports.filter(item => !item.archived).map(cardFor))
      const archived = value.reports.filter(item => item.archived)
      if (archived.length) { const group = element('details'); group.append(element('summary', `归档总结（${archived.length}）`), ...archived.map(cardFor)); $('report-list').append(group) }
      for (const draft of drafts(topic.id, null).filter(item => !item.revision)) $('report-list').append(button(`继续成果草稿：${draft.body.title || '研究成果'}`, () => resume(draft)))
      if (!$('report-list').children.length) $('report-list').append(element('p', '把笔记和证据组织成可以继续修订的研究总结。', 'collection-empty'))
    } catch (error) { if (ticket === topicReads && nav === navigationKey()) $('report-list').replaceChildren(element('p', error.message, 'form-error')) }
  }
  function showEditor(state, title, nodes, read) {
    editVersion++; editor = { ...state, session: editVersion, dirty: Boolean(state.body), read }
    $('report-editor-title').textContent = title; $('report-fields').replaceChildren(...nodes)
    $('report-editor-error').textContent = ''; $('report-latest').hidden = !state.body || !state.revision
    $('report-save').textContent = state.kind === 'sources' ? '保存材料' : '保存成果'
    if (!$('report-editor').open) $('report-editor').showModal()
  }
  function editContent(draft = null) {
    const state = draft || { id: report?.id || crypto.randomUUID(), topicId: report?.topicId || currentTopic().id, revision: report?.revision || null, kind: 'content' }
    const value = draft?.body || report || { title: '研究总结', question: currentTopic().question, blocks: [] }
    const title = input('成果标题', 'report-title-input', value.title, false, 200), question = input('研究问题', 'report-question-input', value.question)
    title.node.required = true; question.node.required = true
    const container = element('div', null, 'report-block-editors'), status = element('p', '', 'hint report-writing-status')
    const undo = button('撤销移除段落', () => {
      const previous = removed.pop()
      if (!previous) return
      container.insertBefore(previous.row, container.children[previous.index] || null)
      updateStatus(); fit(previous.row.querySelector('textarea')); changed()
    })
    const removed = []
    undo.hidden = true
    function fit(node) { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px' }
    function updateStatus() {
      const rows = [...container.children], count = rows.reduce((sum, row) => sum + row.read().text.length, 0)
      status.textContent = `${rows.length >= 35 ? rows.length + '/40' : rows.length} 段 · ${count >= 27000 ? count + '/30000' : count} 字符 · 修改后保存`
      undo.hidden = !removed.length; undo.disabled = rows.length >= 40
      addButton.disabled = rows.length >= 40
    }
    const addButton = button('＋ 添加段落', () => {
      const previous = container.lastElementChild?.read()
      add({ id: crypto.randomUUID(), section: previous?.section || '研究总结', text: '', kind: 'user', citationIds: [] })
      updateStatus(); changed()
      const body = container.lastElementChild.querySelector('textarea'); fit(body); body.focus()
    })
    function add(block = { id: crypto.randomUUID(), section: '研究总结', text: '', kind: 'user', citationIds: [] }) {
      const row = element('section', null, 'report-block-editor'); row.dataset.blockId = block.id
      const heading = input('章节标题', `report-section-${block.id}`, block.section, false, 120), body = input('段落正文', `report-text-${block.id}`, block.text, true)
      heading.node.className = 'report-block-section'; body.node.className = 'report-block-text'; heading.node.required = true
      body.node.rows = 2; body.node.placeholder = '在这里继续写作…'
      body.node.oninput = () => { fit(body.node); updateStatus() }
      heading.wrapper.classList.add('report-section-field'); body.wrapper.classList.add('report-prose-field')
      const type = element('select'); type.className = 'report-block-kind'; type.setAttribute('aria-label', '段落判断类型')
      for (const [id, label] of Object.entries(kinds)) {
        const option = element('option', label); option.value = id
        if (id === 'inference' && !report?.blocks.some(item => item.id === block.id && (item.origin.type === 'model' || item.origin.generatedKind === 'inference'))) option.disabled = true
        type.append(option)
      }
      type.value = block.kind
      const refs = new Set(block.citationIds), choices = element('details', null, 'report-reference-options')
      const referenceSummary = element('summary', '选择本段引用'), selected = element('div', null, 'report-selected-citations')
      choices.append(referenceSummary)
      const settings = element('details', null, 'report-paragraph-settings'), settingsSummary = element('summary')
      function updateReferences() {
        settingsSummary.textContent = `${kinds[type.value]} · ${refs.size} 条引用 · 段落设置`
        referenceSummary.textContent = `选择本段引用（已选 ${refs.size}/24）`
        selected.replaceChildren(...[...refs].map(id => {
          const item = report?.evidence.find(item => item.id === id)
          return item ? evidenceButton(item) : element('p', '引用当前不可用，保存前请核对材料。', 'notice')
        }))
      }
      type.onchange = updateReferences
      for (const item of report?.evidence || []) {
        const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.value = item.id; check.checked = refs.has(item.id)
        check.onchange = () => { check.checked ? refs.add(item.id) : refs.delete(item.id); updateReferences() }
        label.append(check, element('span', `${item.documentTitle} · ${item.reference.title}：${item.reference.text.slice(0, 140)}${item.matchesCurrent ? '' : `（${sourceText(item.sourceState) || '原文已变化'}）`}`)); choices.append(label)
      }
      row.read = () => ({ id: block.id, section: heading.node.value, text: body.node.value, kind: type.value, citationIds: [...refs] })
      settings.append(settingsSummary, type, choices, button('上移段落', () => { if (row.previousElementSibling) container.insertBefore(row, row.previousElementSibling); changed() }), button('移除段落', () => {
        removed.push({ row, index: [...container.children].indexOf(row) }); row.remove(); updateStatus(); changed(); undo.focus()
      }))
      updateReferences()
      row.append(heading.wrapper, body.wrapper, selected, settings)
      container.append(row)
    }
    for (const block of value.blocks || []) add(block)
    if (!container.children.length) add()
    const context = element('details', null, 'report-writing-context'); context.append(element('summary', '研究问题'), question.wrapper)
    // Reveal invalid fields before native validation tries to focus them.
    question.node.oninvalid = () => { context.open = true }
    const nodes = [title.wrapper, state.revision ? context : question.wrapper, status, container, addButton, undo]
    showEditor(state, state.revision ? '编辑研究成果' : '新建研究成果', nodes, () => ({ title: title.node.value, question: question.node.value, blocks: [...container.children].map(row => row.read()).filter(block => state.revision || block.text.trim()) }))
    updateStatus()
    for (const node of container.querySelectorAll('textarea')) fit(node)
    container.querySelector('textarea')?.focus()
  }
  async function editSources(draft = null) {
    const target = report, nav = navigationKey(), ticket = ++editVersion
    const catalog = await api(`/api/topics/${target.topicId}/report-materials`)
    if (ticket !== editVersion || !current(target, nav)) return
    const state = draft || { id: target.id, topicId: target.topicId, revision: target.revision, kind: 'sources' }
    const selected = new Map((draft?.body.sources || target.sources.map(retain)).map(source => [key(source), source]))
    const candidates = new Map([...target.sources, ...catalog.materials].map(source => [key(source), source]))
    for (const [id, source] of selected) {
      if (candidates.has(id)) continue
      const doc = catalog.documents.find(doc => doc.id === source.documentId)
      const label = source.type === 'passages' ? '原文材料' : source.type === 'note' ? '笔记' : '比较表'
      candidates.set(id, { ...source, title: doc?.title || `${label}（当前不可用 · ${(source.documentId || source.id).slice(-8)}）` })
    }
    // Keep the exact draft selector even when its checkbox is toggled or the
    // catalog contains a newer version. Updating a version remains explicit.
    const choicesById = new Map([...candidates].map(([id, source]) => {
      const saved = target.sources.find(item => item.key === id)
      return [id, selected.get(id) || (saved ? retain(saved) : { type: source.type, id: source.id, revision: source.revision })]
    }))
    const list = element('div', null, 'report-material-options')
    function choices() {
      list.replaceChildren(...[...candidates].map(([id, source]) => {
        const row = element('div', null, 'report-material'), label = element('label', null, 'attach-option'), check = element('input')
        const saved = target.sources.find(item => item.key === id)
        const fresh = { type: source.type, id: source.id, revision: source.revision }
        check.type = 'checkbox'; check.checked = selected.has(id)
        check.disabled = !check.checked && !saved && Boolean(source.unavailable)
        check.onchange = () => { check.checked ? selected.set(id, choicesById.get(id)) : selected.delete(id) }
        label.append(check, element('span', source.title)); row.append(label)
        if (source.unavailable) row.append(element('p', `${sourceText(source.unavailable, '来源')}，不能选用当前材料；已保存快照可保留或取消。`, 'notice'))
        if (saved) {
          row.append(element('p', selected.get(id)?.retain ? `保留已选版本${saved.changed ? '，材料已有变化' : ''}` : '使用本次选择的材料', 'hint'))
          if (source.type !== 'passages' && saved.changed) {
            const update = button('选用当前版本', () => { choicesById.set(id, fresh); selected.set(id, fresh); choices(); changed() })
            update.disabled = Boolean(source.unavailable || sourceText(source.sourceState)); row.append(update)
          }
        }
        if (source.type === 'passages') {
          const choice = selected.get(id) || choicesById.get(id)
          const count = choice.referenceIds?.length ?? saved?.content.referenceIds.length
          row.append(element('p', count === undefined ? '原有材料已不可用，可取消此项' : `已选择 ${count} 个原文片段`, 'hint'))
        }
        if (source.preview) row.append(element('p', source.preview.slice(0, 200), 'hint'))
        return row
      }))
    }
    choices()
    const docChoice = element('select'); docChoice.id = 'report-document-choice'; docChoice.setAttribute('aria-label', '选择原文文献')
    const placeholder = element('option', '选择文献查看原文'); placeholder.value = ''; docChoice.append(placeholder)
    for (const doc of catalog.documents) { const option = element('option', doc.title); option.value = doc.id; option.disabled = Boolean(doc.unavailable); docChoice.append(option) }
    const search = input('查找原文片段', 'report-reference-query', '', false), refs = element('div', null, 'report-reference-picker'), status = element('p', '', 'hint')
    let sourceDoc = null, picked = new Set(), documentTicket = 0
    function renderRefs() {
      const matching = sourceDoc?.references.filter(item => `${item.title} ${item.text}`.toLocaleLowerCase().includes(search.node.value.trim().toLocaleLowerCase())) || []
      status.textContent = sourceDoc ? `${matching.length} 个匹配片段，显示前 60 个；已选 ${picked.size} 个。` : ''
      refs.replaceChildren(...matching.slice(0, 60).map(ref => {
        const label = element('label', null, 'attach-option'), check = element('input'); check.type = 'checkbox'; check.checked = picked.has(ref.id)
        check.onchange = () => { check.checked ? picked.add(ref.id) : picked.delete(ref.id); status.textContent = `已选 ${picked.size} 个片段，请点击“加入所选片段”。` }
        label.append(check, element('span', `${ref.title}：${ref.text}`)); return label
      }))
    }
    docChoice.onchange = async () => {
      const request = ++documentTicket, expected = editor
      sourceDoc = null; picked = new Set(); renderRefs()
      if (!docChoice.value) return
      try {
        const doc = await api(`/api/documents/${docChoice.value}`)
        if (request !== documentTicket || editor?.session !== expected?.session) return
        sourceDoc = doc; search.node.value = ''; renderRefs()
      } catch (error) { if (editor?.session === expected?.session) $('report-editor-error').textContent = error.message }
    }
    search.node.oninput = renderRefs
    const add = button('加入所选片段', () => {
      if (!sourceDoc || !picked.size) throw new Error('请先选择原文片段。')
      const source = { type: 'passages', documentId: sourceDoc.id, documentVersion: sourceDoc.evidenceVersion, referenceIds: [...picked] }
      choicesById.set(key(source), source); selected.set(key(source), source); candidates.set(key(source), { ...source, title: sourceDoc.title }); choices(); changed()
    })
    const originals = element('details', null, 'report-original-options'); originals.append(element('summary', '添加原文片段'), docChoice, search.wrapper, status, refs, add)
    showEditor(state, '选择研究材料', [element('p', '选择笔记、比较表或原文；已引用的旧摘录仍保留。', 'hint'), list, originals], () => ({ sources: [...selected.values()] }))
  }
  async function resume(draft) {
    if (!draft.revision) {
      const nav = navigationKey(), ticket = editVersion
      try {
        const saved = await api(`/api/reports/${draft.id}`)
        if (nav !== navigationKey() || ticket !== editVersion) return
        if (saved.topicId !== draft.topicId) throw new Error('成果不属于当前主题。')
        if (reportId !== saved.id) await open(saved.id)
        if (reportId !== saved.id || !report) return
        // A creation draft started from revision 1. Later changes still conflict.
        editContent({ ...draft, revision: 1, body: { ...draft.body, blocks: draft.body.blocks || [] } })
        return
      } catch (error) {
        if (nav !== navigationKey() || ticket !== editVersion) return
        if (error.status !== 404) throw error
      }
    }
    if (draft.kind === 'sources') await editSources(draft); else editContent(draft)
  }
  async function update(body, action = '', method = 'PATCH') {
    const target = report, nav = navigationKey()
    const value = await api(`/api/reports/${target.id}${action}`, json(method, { revision: target.revision, ...body }))
    if (current(target, nav)) { accept(value); notice('研究成果已保存。') }
    return value
  }
  function suggestion(run) {
    const target = report, nav = navigationKey()
    const value = { ...report, blocks: run.result.blocks, evidence: proposalEvidence(run.result.evidence) }
    const adopt = button('采用此草稿并替换正文', async () => {
      adopt.disabled = true
      try { await update({ runId: run.id }, '/adopt', 'POST'); if (current(target, nav)) $('report-inspector').close() }
      catch (error) { if (current(target, nav)) $('report-inspector-error').textContent = error.message }
      finally { adopt.disabled = false }
    })
    adopt.disabled = proposalUnavailable(run)
    inspect('审阅研究草稿', [element('p', adopt.disabled ? '成果或材料已变化，旧草稿不会覆盖人工修改。请恢复成果或更新材料后重新生成。' : '采用后替换当前正文，原正文进入版本记录。生成后的人工保存或材料变化会阻止采用旧草稿。', 'notice'), ...value.blocks.map(block => blockNode(block, value)), adopt])
  }
  $('report-form').oninput = changed; $('report-form').onchange = changed
  $('report-editor-close').onclick = closeEditor
  $('report-editor').oncancel = event => { if (saving) event.preventDefault(); else { persist(); editor = null; editVersion++; renderDrafts() } }
  $('report-form').onsubmit = async event => {
    event.preventDefault(); if (!editor || saving) return
    persist()
    const target = editor, body = target.read(), nav = navigationKey(), savedDraft = sessionStorage.getItem(draftKey(target))
    const nodes = [...$('report-form').elements, $('report-editor-close')], disabled = nodes.map(node => node.disabled)
    saving = true; nodes.forEach(node => { node.disabled = true }); $('report-editor-error').textContent = ''
    try {
      const value = await api(target.revision ? `/api/reports/${target.id}` : `/api/topics/${target.topicId}/reports`, json(target.revision ? 'PATCH' : 'POST', { ...body, ...(target.revision ? { revision: target.revision } : { id: target.id }) }))
      if (sessionStorage.getItem(draftKey(target)) === savedDraft) sessionStorage.removeItem(draftKey(target))
      if (editor === target) { editor = null; editVersion++; $('report-editor').close() }
      if (nav === navigationKey()) { if (reportId === value.id) accept(value); else await open(value.id); notice('研究成果已保存。') }
    } catch (error) {
      if (editor === target) { $('report-editor-error').textContent = error.message; $('report-latest').hidden = false }
    } finally { saving = false; nodes.forEach((node, index) => { node.disabled = disabled[index] }) }
  }
  $('report-latest').onclick = async () => {
    const target = editor, ticket = editVersion, nav = navigationKey()
    try {
      const latest = await api(`/api/reports/${target.id}`)
      if (editor !== target || ticket !== editVersion || nav !== navigationKey()) return
      // Show the saved version without discarding the local draft.
      const load = button('使用已保存版本编辑', async () => {
        if (editor !== target || ticket !== editVersion || nav !== navigationKey()) return
        accept(latest)
        if (target.kind === 'sources') await editSources()
        else editContent({ id: latest.id, topicId: latest.topicId, revision: latest.revision, kind: 'content', body: { title: latest.title, question: latest.question, blocks: latest.blocks } })
        $('report-inspector').close()
      })
      inspect(`已保存版本 ${latest.revision} · ${latest.title}`, [element('p', '当前草稿继续保留。可核对已保存内容，再决定载入。', 'hint'), ...latest.blocks.map(block => blockNode(block, latest)), load])
    } catch (error) { if (editor === target) $('report-editor-error').textContent = error.message }
  }
  $('new-report').onclick = () => editContent()
  $('report-edit').onclick = () => editContent()
  $('report-materials').onclick = () => void editSources().catch(error => notice(error.message, true))
  $('report-resume').onclick = () => { const draft = drafts().find(item => item.key === $('report-draft-choice').value); if (draft) void resume(draft).catch(error => notice(error.message, true)) }
  $('report-discard').onclick = () => { sessionStorage.removeItem($('report-draft-choice').value); renderDrafts() }
  $('report-back').onclick = () => void showTopic(report?.topicId || currentTopic().id).catch(error => notice(error.message, true))
  $('report-retry').onclick = () => void open(reportId)
  $('report-inspector-close').onclick = () => $('report-inspector').close()
  $('report-archive').onclick = () => void update({ archived: !report.archived }).catch(error => notice(error.message, true))
  $('report-assemble').onclick = async () => {
    const target = report, nav = navigationKey()
    $('report-assemble').disabled = true
    try {
      const value = await update({}, '/assemble', 'POST')
      if (current(target, nav)) notice(value.blocks.length === target.blocks.length ? '所选材料已在正文中，无需重复加入。' : `已加入 ${value.blocks.length - target.blocks.length} 个新材料段落，原有正文保留。`)
    } catch (error) { if (current(target, nav)) notice(error.message, true) }
    finally { if (report) render() }
  }
  async function generate(target) {
    const requestKey = 'classifier-report-request:' + target.id
    let request
    try { request = JSON.parse(sessionStorage.getItem(requestKey)) } catch {}
    const observed = target.suggestions.find(run => run.requestId === request?.requestId)
    if (!request || request.revision !== target.revision || observed && !['queued', 'running'].includes(observed.status)) request = { revision: target.revision, requestId: crypto.randomUUID() }
    sessionStorage.setItem(requestKey, JSON.stringify(request))
    const run = await api(`/api/reports/${target.id}/suggestions`, json('POST', request))
    sessionStorage.removeItem(requestKey)
    return run
  }
  $('report-generate').onclick = async () => {
    const target = report, nav = navigationKey(); $('report-generate').disabled = true
    try { await generate(target); if (current(target, nav)) await refresh() }
    catch (error) { if (current(target, nav)) { notice(error.message, true); render() } }
  }
  $('report-history').onclick = async () => {
    const target = report, nav = navigationKey()
    try {
      const value = await api(`/api/reports/${target.id}/history`)
      if (!current(target, nav)) return
      inspect('成果版本记录', [...value.history].reverse().map(old => {
        const node = element('section', null, 'report-history-item')
        node.append(element('h3', `版本 ${old.revision} · ${old.title}`), ...old.blocks.map(block => blockNode(block, old)))
        node.append(button('恢复为新版本', async () => {
          try { const restored = await api(`/api/reports/${target.id}`, json('PATCH', { revision: value.revision, restoreRevision: old.revision })); if (current(target, nav)) { accept(restored); $('report-inspector').close() } }
          catch (error) { if (current(target, nav)) $('report-inspector-error').textContent = error.message }
        })); return node
      }))
    } catch (error) { if (current(target, nav)) notice(error.message, true) }
  }
  async function exportReport(format) {
    if (exporting || !report?.blocks.some(block => block.text.trim())) return
    const target = report, nav = navigationKey(); exporting = true
    for (const id of ['report-export', 'report-export-word']) $(id).disabled = true
    try {
      const response = await fetch(`/api/reports/${target.id}/export?revision=${target.revision}&format=${format}`)
      if (!response.ok) throw new Error((await response.json()).error || '导出失败')
      const blob = await response.blob()
      if (!current(target, nav)) return
      const name = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = name ? decodeURIComponent(name) : `研究成果.${format === 'docx' ? 'docx' : 'md'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      notice(`已导出版本 ${target.revision} 的 ${format === 'docx' ? 'Word 文档' : 'Markdown'}。`)
    } catch (error) { if (current(target, nav)) notice(error.message, true) }
    finally { exporting = false; if (report) render() }
  }
  $('report-export').onclick = () => exportReport('markdown')
  $('report-export-word').onclick = () => exportReport('docx')
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', persist)
  async function fromComparison(table) {
    const nav = navigationKey()
    const value = await api('/api/comparisons/' + table.id + '/report', json('POST', { revision: table.revision }))
    if (nav !== navigationKey()) return
    await open(value.id)
    if (reportId !== value.id || !report || report.archived || report.sources.some(source => source.changed) || report.blocks.length || report.suggestions.some(run => ['queued', 'running'].includes(run.status) || run.status === 'completed' && run.baseRevision === report.revision)) return
    const target = report, token = epoch
    try {
      const run = await generate(target)
      if (token !== epoch) return
      report.suggestions = [run, ...report.suggestions]; render()
    } catch (error) { if (token === epoch) { $('report-message').textContent = error.message + ' 材料已保留，可点击“生成研究草稿”重试。'; renderDrafts() } }
  }
  return { reset, open, showTopic: showTopicReports, fromComparison, updateModel() { if (report) render() } }
}
