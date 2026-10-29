export function createNotebook({ api, element, jump, openNote, notice, storage, useReaderTopic = async () => {}, updateTopicContent = () => {} }) {
  const sourceText = state => ({ deleted: '原文已删除', missing: '原文缺失', corrupt: '原文记录损坏', unavailable: '原文暂时无法读取' })[state] || ''
  const localStorage = storage?.persistent || globalThis.localStorage
  const sessionStorage = storage?.session || globalThis.sessionStorage
  const $ = id => document.getElementById(id)
  const fields = ['研究问题', '材料或对象', '方法', '主要发现', '局限', '待验证问题']
  const kinds = { source: '原文报告', inference: '模型归纳', user: '用户判断' }
  const statuses = { recorded: '已记录', not_reported: '未报告', not_applicable: '不适用', not_found: '未找到' }
  let context = null, notes = [], suggestions = [], linked = false, generation = 0, requestVersion = 0, topicVersion = 0
  let editor = null, saving = false, pollTimer, modelConfigured = false, pendingContext = null, choosingTopic = false, topicRequest = 0
  const ownerStorageKey = 'classifier-note-draft-owner'
  const navigationType = typeof performance !== 'undefined' ? performance.getEntriesByType('navigation')[0]?.type : null
  const previousOwner = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ownerStorageKey) : null
  // A new tab may inherit sessionStorage from its opener. Fresh navigations get
  // a new owner; reloads retain ownership of that tab's drafts.
  const ownerId = storage?.ownerId || (previousOwner && ['reload', 'back_forward'].includes(navigationType) ? previousOwner : crypto.randomUUID())
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(ownerStorageKey, ownerId)
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const draftPrefix = value => `classifier-note-draft:${value.topic.id}:${value.document.id}`
  const draftKey = value => `${draftPrefix(value.context)}:${value.id}:${value.draftId}`
  const draftPreference = value => `classifier-note-last-draft:${value.topic.id}:${value.document.id}`
  const tabKey = value => `classifier-note-tab:${value.topic?.id || 'all'}:${value.document.id}`
  const sameContext = value => context?.document.id === value.document.id && context?.topic?.id === value.topic?.id
  function button(label, action, className = 'quiet-button') {
    const node = element('button', label, className)
    node.type = 'button'
    node.onclick = () => Promise.resolve().then(action).catch(error => notice(error.message, true))
    return node
  }
  function selectTab(tab) {
    const show = tab === 'notes'
    $('qa-panel').hidden = show; $('notes-panel').hidden = !show
    $('qa-tab').setAttribute('aria-selected', String(!show)); $('notes-tab').setAttribute('aria-selected', String(show))
    $('qa-tab').tabIndex = show ? -1 : 0; $('notes-tab').tabIndex = show ? 0 : -1
    if (context) localStorage.setItem(tabKey(context), tab)
  }
  $('qa-tab').onclick = () => selectTab('qa')
  $('notes-tab').onclick = () => selectTab('notes')
  for (const [id, other, tab] of [['qa-tab', 'notes-tab', 'notes'], ['notes-tab', 'qa-tab', 'qa']]) $(id).onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); selectTab(tab); $(other).focus() }
  }
  function reset() {
    generation++; requestVersion++; clearTimeout(pollTimer)
    if (editor && !saving) { saveDraft(); $('note-dialog').close(); editor = null }
    context = null; notes = []; suggestions = []; linked = false
    pendingContext = null; topicRequest++; $('note-topic-dialog').close()
    $('new-note').disabled = true; $('generate-notes').disabled = true
    $('notes-list').replaceChildren(); $('suggestions-list').replaceChildren()
  }
  async function load(document, topic, options = {}) {
    reset()
    context = { document, topic }
    modelConfigured = Boolean(options.modelConfigured)
    $('notes-context').textContent = topic ? `笔记归属：${topic.title}` : '记录时选择所属主题。'
    $('notes-message').textContent = topic ? '正在读取笔记…' : ''
    $('new-note').disabled = false
    $('notes-retry').hidden = true
    $('suggestion-hint').textContent = modelConfigured ? '建议只在你选择保存后成为笔记，再次生成会保留已有笔记。' : '尚未配置问答模型，可以手动记录或从原文创建笔记。'
    $('note-suggestions').hidden = !topic
    selectTab(options.tab || (options.noteId ? 'notes' : localStorage.getItem(tabKey(context)) || 'qa'))
    renderDraft()
    if (topic) await reload(options.noteId)
  }
  function schedulePoll() {
    clearTimeout(pollTimer)
    if (suggestions.some(run => ['queued', 'running'].includes(run.status))) pollTimer = setTimeout(() => reload(), 900)
  }
  async function reload(focusId = null) {
    if (!context?.topic) return
    const target = context, token = generation, version = ++requestVersion
    try {
      const result = await api(`/api/topics/${target.topic.id}/documents/${target.document.id}/notes`)
      if (token !== generation || version !== requestVersion) return
      notes = result.notes; suggestions = result.suggestions; linked = result.linked
      $('notes-message').textContent = linked ? '' : '文献已移出此主题，既有笔记仍可编辑与核对；重新关联后可创建新笔记。'
      $('notes-retry').hidden = true
      $('new-note').disabled = false; $('generate-notes').disabled = !linked || !modelConfigured || suggestions.some(run => ['running', 'queued'].includes(run.status))
      renderNotes(); renderSuggestions(); renderDraft(); schedulePoll()
      if (focusId) document.getElementById(`note-${focusId}`)?.scrollIntoView({ block: 'nearest' })
    } catch (error) {
      if (token !== generation || version !== requestVersion) return
      $('notes-message').textContent = error.message; $('notes-retry').hidden = false
      schedulePoll()
    }
  }
  $('notes-retry').onclick = () => reload()
  function listDrafts(noteId = null) {
    if (!context?.topic) return []
    const prefix = draftPrefix(context), drafts = []
    for (const key of Object.keys(localStorage)) {
      // The exact prefix is the old single-draft format; keep it recoverable.
      if (key !== prefix && !key.startsWith(`${prefix}:`)) continue
      try {
        const raw = localStorage.getItem(key), value = JSON.parse(raw)
        if (value?.id && value.context?.topic.id === context.topic.id && value.context?.document.id === context.document.id && (!noteId || value.id === noteId)) drafts.push({ ...value, _key: key, _raw: raw })
      } catch { /* Ignore malformed browser draft records. */ }
    }
    return drafts.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
  }
  function preferredDraftKey() {
    return typeof sessionStorage !== 'undefined' && context?.topic ? sessionStorage.getItem(draftPreference(context)) : null
  }
  function readDraft(noteId = null) {
    const drafts = listDrafts(noteId), preferred = preferredDraftKey()
    const own = drafts.filter(draft => !draft.ownerId || draft.ownerId === ownerId)
    return own.find(draft => draft._key === preferred) || own[0] || (noteId ? null : drafts[0]) || null
  }
  function renderDraft() {
    const drafts = listDrafts(), selected = $('note-draft-choice').value || preferredDraftKey()
    $('note-draft-notice').hidden = !drafts.length
    $('note-draft-choice').replaceChildren(...drafts.map((draft, index) => {
      const owner = draft.ownerId && draft.ownerId !== ownerId ? '其他标签页 · ' : ''
      const option = element('option', `${index + 1}. ${owner}${draft.field || '主要发现'} · ${(draft.content || '未填写内容').slice(0, 60)}`)
      option.value = draft._key
      return option
    }))
    $('note-draft-choice').value = drafts.some(draft => draft._key === selected) ? selected : readDraft()?._key || ''
  }
  function captureEditor() {
    return { ...editor, field: $('note-field').value.trim() || '主要发现', content: $('note-content').value, kind: $('note-kind').value, status: $('note-status').value }
  }
  function removeParentDraft(value) {
    if (value.parentDraft && (!value.parentDraft.ownerId || value.parentDraft.ownerId === ownerId) && localStorage.getItem(value.parentDraft.key) === value.parentDraft.raw) localStorage.removeItem(value.parentDraft.key)
  }
  function clearDraft(value) {
    localStorage.removeItem(draftKey(value))
    removeParentDraft(value)
  }
  function persistDraft(value) {
    const sourceContext = value.context
    const draft = Object.fromEntries(['id', 'draftId', 'revision', 'field', 'content', 'kind', 'status', 'origin', 'evidence', 'referenceIds', 'replaceEvidence', 'documentVersion', 'dirty'].map(key => [key, value[key]]))
    const key = draftKey(value)
    localStorage.setItem(key, JSON.stringify({ ...draft, ownerId, savedAt: Date.now(), context: {
      topic: { id: sourceContext.topic.id, title: sourceContext.topic.title },
      document: { id: sourceContext.document.id, evidenceVersion: sourceContext.document.evidenceVersion },
    } }))
    // A restored editor gets its own key before its unchanged predecessor is removed.
    removeParentDraft(value)
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(draftPreference(sourceContext), key)
  }
  function saveDraft() {
    if (!editor || saving || !editor.dirty) return
    editor = captureEditor()
    persistDraft(editor)
    renderDraft()
  }
  function resumeDraft(draft, note = notes.find(note => note.id === draft.id)) {
    // A draft whose creation response was lost is based on creation revision 1.
    // Do not silently adopt a newer server revision and overwrite concurrent edits.
    showEditor({ ...draft, revision: draft.revision ?? (note ? 1 : undefined), context })
  }
  $('resume-note-draft').onclick = () => { const draft = listDrafts().find(value => value._key === $('note-draft-choice').value); if (draft) resumeDraft(draft) }
  $('discard-note-draft').onclick = () => {
    const draft = listDrafts().find(value => value._key === $('note-draft-choice').value)
    if (draft && localStorage.getItem(draft._key) === draft._raw) localStorage.removeItem(draft._key)
    renderDraft()
  }
  function originLabel(value) {
    return value?.type === 'answer' ? '来自问答证据' : value?.type === 'reference' ? '来自原文片段' : '手动记录'
  }
  function renderEditorSummary() {
    const status = $('note-status').value
    $('note-details-summary').textContent = ['分类与状态', $('note-field').value.trim() || '主要发现', kinds[$('note-kind').value], status === 'recorded' ? '' : statuses[status]].filter(Boolean).join(' · ')
    $('note-content').required = status === 'recorded'
  }
  function renderEditorEvidence() {
    // Keep the saved snapshot until the user explicitly replaces it. Selected
    // references belong to the draft's version, not automatically today's text.
    const currentVersion = editor.documentVersion === editor.context.document.evidenceVersion
    const evidence = editor.replaceEvidence ? (currentVersion ? editor.referenceIds.map(id => editor.context.document.references.find(ref => ref.id === id)).filter(Boolean).map(reference => ({
      documentId: editor.context.document.id, documentVersion: editor.documentVersion, documentTitle: editor.context.document.title, reference, matchesCurrent: true,
    })) : []) : editor.evidence
    $('note-existing-evidence').replaceChildren(...evidence.map(item => button(item.reference.title, () => showEvidence(item))))
    if (editor.replaceEvidence && editor.referenceIds.length && !currentVersion) $('note-existing-evidence').append(element('p', '已选原文版本已变化，请重新选择原文。', 'form-error'))
    else if (evidence.some(item => !item.matchesCurrent)) $('note-existing-evidence').append(element('p', '原文版本待核对，当前保留的是保存时的快照。', 'form-error'))
    else if (!evidence.length) $('note-existing-evidence').append(element('p', '可按需关联原文。', 'hint'))
    $('note-change-evidence').textContent = evidence.length || editor.referenceIds.length ? '重新选择原文' : '＋ 关联原文'
  }
  function showEditor(value) {
    editor = { referenceIds: [], evidence: [], replaceEvidence: false, dirty: !value.revision && Boolean(value.content), documentVersion: value.context.document.evidenceVersion, ...value,
      draftId: crypto.randomUUID(), parentDraft: value._key ? { key: value._key, raw: value._raw, ownerId: value.ownerId } : null }
    editor.evidence = editor.evidence.map(item => ({ ...item, matchesCurrent: item.documentId === editor.context.document.id && item.documentVersion === editor.context.document.evidenceVersion }))
    $('note-dialog-title').textContent = editor.revision ? '编辑阅读笔记' : '新建阅读笔记'
    $('note-origin').textContent = `${editor.context.topic.title} · ${originLabel(editor.origin)}`
    $('note-field').value = editor.field || '主要发现'
    $('note-content').value = editor.content || ''
    $('note-status').value = editor.status || 'recorded'
    $('note-kind').value = editor.kind || 'user'
    $('note-kind').querySelector('[value="inference"]').disabled = editor.origin?.generatedKind !== 'inference'
    $('note-details').open = false
    renderEditorSummary()
    $('note-error').textContent = ''; $('note-load-latest').hidden = true; $('note-load-latest').disabled = false
    $('note-change-evidence').hidden = !editor.revision && editor.origin?.type === 'answer'
    $('note-reference-picker').hidden = true
    $('note-reference-query').value = ''
    renderEditorEvidence()
    renderReferencePicker()
    selectTab('notes')
    if (!$('note-dialog').open) $('note-dialog').showModal()
    $('note-content').focus()
  }
  function ensureContext(continueRecording) {
    if (!context) return false
    if (!context.topic || !linked) {
      void chooseTopic(continueRecording).catch(error => notice(error.message, true))
      return false
    }
    return true
  }
  async function chooseTopic(continueRecording) {
    const target = context, token = generation, ticket = ++topicRequest
    const result = await api('/api/topics')
    if (token !== generation || context !== target || ticket !== topicRequest) return
    pendingContext = { target, token, continueRecording }
    $('note-topic-choice').replaceChildren(...result.topics.map(topic => {
      const option = element('option', topic.title); option.value = topic.id; return option
    }))
    const create = element('option', '＋ 创建新主题'); create.value = 'new'; $('note-topic-choice').append(create)
    // A selection stays explicit even when only one topic is available.
    const placeholder = element('option', '请选择主题'); placeholder.value = ''
    $('note-topic-choice').prepend(placeholder); $('note-topic-choice').value = ''
    $('note-topic-new-title').value = ''; $('note-topic-new-field').hidden = true
    $('note-topic-error').textContent = ''
    if (!$('note-topic-dialog').open) $('note-topic-dialog').showModal()
  }
  $('note-topic-choice').onchange = () => { $('note-topic-new-field').hidden = $('note-topic-choice').value !== 'new' }
  $('note-topic-close').onclick = () => { if (!choosingTopic) { pendingContext = null; $('note-topic-dialog').close() } }
  $('note-topic-dialog').oncancel = event => { if (choosingTopic) event.preventDefault(); else pendingContext = null }
  $('note-topic-form').onsubmit = async event => {
    event.preventDefault()
    const pending = pendingContext
    if (!pending || choosingTopic) return
    const choice = $('note-topic-choice').value
    if (!choice) { $('note-topic-error').textContent = '请选择笔记所属主题。'; return }
    const controls = ['note-topic-submit', 'note-topic-choice', 'note-topic-new-title', 'note-topic-close'].map($)
    choosingTopic = true; controls.forEach(node => { node.disabled = true }); $('note-topic-error').textContent = ''
    try {
      let topicId = choice
      if (choice === 'new') {
        if (!$('note-topic-new-title').value.trim()) throw new Error('请填写新主题标题。')
        const topic = await api('/api/topics', json('POST', { title: $('note-topic-new-title').value }))
        topicId = topic.id
        const option = element('option', topic.title); option.value = topicId; $('note-topic-choice').prepend(option); $('note-topic-choice').value = topicId
      }
      await api(`/api/topics/${topicId}/documents/${pending.target.document.id}`, { method: 'PUT' })
      if (pending.token !== generation || pendingContext !== pending) return
      const topic = await useReaderTopic(topicId, pending.target.document.id)
      if (pending.token !== generation || pendingContext !== pending) return
      context = { document: pending.target.document, topic }; linked = true
      $('notes-context').textContent = `笔记归属：${topic.title}`
      $('notes-message').textContent = ''; $('note-suggestions').hidden = false
      pendingContext = null; $('note-topic-dialog').close()
      await reload()
      if (context?.document.id === pending.target.document.id && context?.topic.id === topicId) pending.continueRecording()
    } catch (error) { if (pendingContext === pending) $('note-topic-error').textContent = error.message }
    finally { choosingTopic = false; controls.forEach(node => { node.disabled = false }) }
  }
  function newNote(field = '主要发现') {
    if (!ensureContext(() => newNote(field))) return
    showEditor({ id: crypto.randomUUID(), context, field, origin: { type: 'manual' }, replaceEvidence: true })
  }
  function fromReference(reference) {
    if (!ensureContext(() => fromReference(reference))) return
    showEditor({ id: crypto.randomUUID(), context, field: '主要发现', content: reference.text, kind: 'source', origin: { type: 'reference' }, referenceIds: [reference.id], replaceEvidence: true })
  }
  function fromAnswer(run, source, field = '主要发现') {
    if (!ensureContext(() => fromAnswer(run, source, field))) return
    if (run.documentId !== context.document.id) return
    const claim = source.claimIndex === undefined ? null : run.result.claims[source.claimIndex]
    const refs = claim ? run.result.references.filter(ref => claim.referenceIds.includes(ref.id)) : run.result.references.filter(ref => ref.id === source.referenceId)
    const kind = claim?.kind || 'source'
    showEditor({ id: crypto.randomUUID(), context, field, kind, content: claim?.text || refs[0]?.text || '',
      origin: { type: 'answer', runId: run.id, ...source, generatedKind: kind },
      evidence: refs.map(reference => ({ documentId: run.documentId, documentVersion: run.documentVersion || null, documentTitle: run.documentTitle, reference, matchesCurrent: run.documentVersion === context.document.evidenceVersion })),
    })
  }
  function renderReferencePicker() {
    if (!editor) return
    const query = $('note-reference-query').value.trim().toLocaleLowerCase()
    const matching = editor.context.document.references.filter(ref => `${ref.title} ${ref.text}`.toLocaleLowerCase().includes(query))
    $('note-reference-options').replaceChildren(...matching.slice(0, 60).map(ref => {
      const label = element('label', null, 'attach-option'), input = element('input')
      input.type = 'checkbox'; input.checked = editor.referenceIds.includes(ref.id)
      input.onchange = () => {
        editor.referenceIds = input.checked ? [...new Set([...editor.referenceIds, ref.id])] : editor.referenceIds.filter(id => id !== ref.id)
        editor.dirty = true
        renderEditorEvidence()
        saveDraft()
      }
      label.append(input, element('span', `${ref.title} · ${ref.text.slice(0, 150)}`)); return label
    }))
    if (matching.length > 60) $('note-reference-options').append(element('p', '显示前 60 个片段，可用关键词缩小范围。', 'hint'))
  }
  $('note-change-evidence').onclick = () => {
    if (!editor.replaceEvidence || editor.documentVersion !== editor.context.document.evidenceVersion) editor.referenceIds = editor.evidence.filter(item => item.matchesCurrent).map(item => item.reference.id)
    editor.replaceEvidence = true
    editor.dirty = true; editor.documentVersion = editor.context.document.evidenceVersion
    $('note-reference-picker').hidden = false; renderReferencePicker(); renderEditorEvidence(); saveDraft()
    $('note-reference-query').focus()
  }
  $('note-reference-query').oninput = renderReferencePicker
  $('new-note').onclick = () => newNote()
  for (const id of ['note-field', 'note-content', 'note-kind', 'note-status']) $(id).oninput = () => { editor.dirty = true; renderEditorSummary(); saveDraft() }
  $('close-note').onclick = () => { if (!saving) { saveDraft(); $('note-dialog').close(); editor = null } }
  $('note-dialog').oncancel = event => { if (saving) event.preventDefault(); else { saveDraft(); editor = null } }
  $('note-load-latest').onclick = async () => {
    const target = editor, token = generation
    if (!target) return
    $('note-load-latest').disabled = true
    try {
      const saved = await api(`/api/notes/${target.id}`)
      if (editor !== target || token !== generation || !$('note-dialog').open) return
      if (saved.topicId !== target.context.topic.id || saved.documentId !== target.context.document.id) throw new Error('笔记归属与当前编辑器不一致。')
      clearDraft(target)
      showEditor({ ...saved, context: target.context })
      renderDraft()
    } catch (error) { if (editor === target && token === generation) $('note-error').textContent = error.message }
    finally { if (editor?.draftId === target.draftId && token === generation) $('note-load-latest').disabled = false }
  }
  $('note-form').onsubmit = async event => {
    event.preventDefault()
    if (!editor || saving) return
    saveDraft()
    const draft = captureEditor(), controls = [...$('note-form').elements, $('close-note')], disabled = controls.map(node => node.disabled)
    const token = generation
    saving = true; controls.forEach(node => { node.disabled = true }); $('note-error').textContent = ''
    try {
      const body = { field: draft.field, content: draft.content, kind: draft.kind, status: draft.status }
      if (draft.revision) body.revision = draft.revision
      else {
        body.id = draft.id
        const { generatedKind, originalContent, ...origin } = draft.origin
        body.origin = origin
      }
      if (draft.replaceEvidence) { body.referenceIds = draft.referenceIds; body.documentVersion = draft.documentVersion }
      const path = draft.revision ? `/api/notes/${draft.id}` : `/api/topics/${draft.context.topic.id}/documents/${draft.context.document.id}/notes`
      const saved = await api(path, json(draft.revision ? 'PATCH' : 'POST', body))
      clearDraft(draft)
      $('note-dialog').close(); editor = null
      if (token === generation && sameContext(draft.context)) {
        notes = [saved, ...notes.filter(note => note.id !== saved.id)]; renderNotes(); renderDraft()
        notice('阅读笔记已保存。'); await reload()
      }
    } catch (error) {
      if (token !== generation || editor?.draftId !== draft.draftId) return
      // A POST may have committed even if its response was lost. Recover its
      // identity without discarding input or treating it as a new note again.
      if (!draft.revision) {
        try {
          const saved = await api(`/api/notes/${draft.id}`)
          if (token !== generation || editor?.draftId !== draft.draftId) return
          if (saved.topicId === draft.context.topic.id && saved.documentId === draft.context.document.id) {
            editor.revision = 1; editor.dirty = true
            persistDraft(captureEditor())
            $('note-dialog-title').textContent = '编辑阅读笔记'
            $('note-error').textContent = '笔记已创建，当前输入已保留。可再次保存修订，或载入已保存版本。'
            $('note-load-latest').hidden = false
            return
          }
        } catch { /* Keep the original error and creation ID when recovery is unavailable. */ }
      }
      if (token !== generation || editor?.draftId !== draft.draftId) return
      $('note-error').textContent = error.message
      $('note-load-latest').hidden = !draft.revision && error.status !== 409
    } finally { saving = false; controls.forEach((node, index) => { node.disabled = disabled[index] }) }
  }
  async function change(note, fields) {
    const token = generation
    const saved = await api(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, ...fields }))
    if (token !== generation) return
    notes = notes.map(item => item.id === note.id ? saved : item)
    renderNotes(); await reload()
    return saved
  }
  function showEvidence(item) {
    $('evidence-title').textContent = item.reference.title
    $('evidence-location').textContent = `${item.documentTitle || context?.document.title || ''}${item.reference.page ? ` · 第 ${item.reference.page} 页` : ''}`
    $('evidence-text').textContent = item.reference.text
    $('evidence-warning').textContent = sourceText(item.sourceState) ? `${sourceText(item.sourceState)}，保存时的证据快照仍可阅读。请先检查资料，再核对原文位置。` : !item.matchesCurrent ? '原文版本已变化或无法确认。这是保存时的原文快照，请重新核对后选择当前证据。' : item.reference.needsReview ? '这段内容来自识别或版面推断，数字、表格和公式需要对照原文件核对。' : '以下为保存时的原文。请判断它是否支持笔记中的结论。'
    $('evidence-open-source').disabled = !item.matchesCurrent || context?.document.id !== item.documentId
    $('evidence-open-source').onclick = () => {
      $('evidence-dialog').close(); $('note-history-dialog').close()
      if ($('note-dialog').open && !saving) { saveDraft(); $('note-dialog').close(); editor = null }
      jump(item.reference.id)
    }
    $('evidence-dialog').showModal()
  }
  $('close-evidence').onclick = () => $('evidence-dialog').close()
  async function history(note, afterRestore) {
    const token = generation, value = await api(`/api/notes/${note.id}`)
    if (token !== generation) return
    $('note-history-error').textContent = ''
    $('note-history-list').replaceChildren(...[value, ...[...value.history].reverse()].map(version => {
      const row = element('article', null, 'note-history-item')
      row.append(element('strong', `版本 ${version.revision} · ${version.field}`), element('p', version.content || statuses[version.status]))
      if (sourceText(version.sourceState)) row.append(element('p', `${sourceText(version.sourceState)}，保留已保存内容。`, 'notice'))
      for (const item of version.evidence) row.append(button(item.reference.title, () => showEvidence(item)))
      if (version.revision !== value.revision) row.append(button('恢复为新版本', async () => {
        try {
          const saved = await change(value, { restoreRevision: version.revision })
          if (saved && token === generation) { $('note-history-dialog').close(); await afterRestore?.() }
        }
        catch (error) { $('note-history-error').textContent = error.message }
      }))
      return row
    }))
    $('note-history-dialog').showModal()
  }
  $('close-note-history').onclick = () => $('note-history-dialog').close()
  function renderNotes() {
    const visible = notes.filter(note => $('notes-show-archived').checked || !note.archived)
    if (!visible.length) {
      $('notes-list').replaceChildren(element('p', notes.length ? '笔记已归档，可勾选“显示归档笔记”查看。' : '还没有笔记。可以直接写下想法，或从原文保存片段。', 'collection-empty'))
      return
    }
    const presentFields = new Set(visible.map(note => note.field))
    const allFields = [...new Set([...fields, ...presentFields])].filter(field => presentFields.has(field))
    $('notes-list').replaceChildren(...allFields.map(field => {
      const group = element('section', null, 'note-group')
      group.append(element('h3', field))
      const entries = visible.filter(note => note.field === field)
      for (const note of entries) {
        const card = element('article', null, 'note-card'); card.id = `note-${note.id}`
        const stale = note.evidence.some(item => !item.matchesCurrent)
        card.append(element('p', [kinds[note.kind], statuses[note.status], note.archived ? '已归档' : '', note.editedByUser ? '已人工修订' : '', sourceText(note.sourceState) || (stale ? '原文版本待核对' : note.reviewState === 'checked' ? '已人工核对' : note.evidence.length ? '待核对' : '')].filter(Boolean).join(' · '), 'note-labels'))
        if (note.content) card.append(element('p', note.content, 'note-text'))
        const evidence = element('div', null, 'note-evidence')
        for (const item of note.evidence) evidence.append(button(`出处：${item.reference.title}`, () => showEvidence(item)))
        card.append(evidence)
        const actions = element('div', null, 'note-actions')
        actions.append(button('编辑', () => {
          const draft = readDraft(note.id)
          if (draft) resumeDraft(draft, note)
          else showEditor({ ...note, context })
        }))
        if (note.evidence.length && !stale && note.reviewState !== 'checked') actions.append(button('已核对出处', () => change(note, { reviewState: 'checked' })))
        const more = element('details', null, 'more-actions'), extras = element('div', null, 'more-actions-list')
        more.append(element('summary', '更多'), extras)
        extras.append(button('版本记录', () => history(note)), button(note.archived ? '取消归档' : '归档', () => change(note, { archived: !note.archived })))
        const impact = element('button', '删除影响', 'quiet-button')
        impact.type = 'button'; impact.dataset.deletionBucket = 'notes'; impact.dataset.deletionId = note.id; extras.append(impact); actions.append(more)
        card.append(actions); group.append(card)
      }
      return group
    }))
  }
  $('notes-show-archived').onchange = renderNotes
  function renderSuggestions() {
    $('suggestions-list').replaceChildren(...suggestions.map(run => {
      const box = element('article', null, 'note-suggestion')
      box.append(element('h3', `${run.field} · 笔记建议`))
      if (run.status === 'completed' && run.result) {
        if (run.result.mode === 'model') run.result.claims.forEach((claim, claimIndex) => {
          const row = element('div', null, 'suggestion-row')
          row.append(element('p', `${kinds[claim.kind]}：${claim.text}`), button('采用为新笔记', () => fromAnswer(run, { claimIndex }, run.field)))
          box.append(row)
        })
        else {
          box.append(element('p', run.result.warning || run.result.answer, 'notice'))
          for (const reference of run.result.references) box.append(button(`保存原文：${reference.title}`, () => fromAnswer(run, { referenceId: reference.id }, run.field)))
        }
        if (run.result.limitations) box.append(element('p', run.result.limitations, 'notice'))
      } else if (['queued', 'running'].includes(run.status)) {
        box.append(element('p', '正在读取证据并生成建议…', 'hint'), button('停止生成', async () => { await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }); await reload() }))
      } else box.append(element('p', run.error || '任务已结束，可重新生成。', 'notice'))
      return box
    }))
  }
  $('generate-notes').onclick = async () => {
    if (!ensureContext()) return
    const target = context, token = generation
    $('generate-notes').disabled = true
    try {
      const run = await api(`/api/topics/${target.topic.id}/documents/${target.document.id}/note-suggestions`, json('POST', { field: $('suggestion-field').value }))
      if (token !== generation) return
      suggestions = [run, ...suggestions]; renderSuggestions(); schedulePoll()
    } catch (error) { if (token === generation) { $('notes-message').textContent = error.message; $('generate-notes').disabled = false } }
  }
  async function showTopic(topic) {
    const version = ++topicVersion
    $('topic-note-list').replaceChildren(element('p', '正在读取主题笔记…', 'hint'))
    try {
      const result = await api(`/api/topics/${topic.id}/notes`)
      if (version !== topicVersion) return
      const values = result.notes.filter(note => !note.archived)
      updateTopicContent(topic.id, 'notes', result.notes, () => {})
      const cardFor = note => {
        const card = element('article', null, 'document-card')
        const info = element('div', null, 'document-card-body')
        info.append(element('h3', `${note.field} · ${note.documentTitle}`), element('p', note.content || statuses[note.status], 'record-preview'))
        if (sourceText(note.sourceState)) info.append(element('p', `${sourceText(note.sourceState)}，已保存笔记与历史仍可查看。`, 'notice'))
        if (!note.linked) info.append(element('p', '文献已移出主题，笔记与出处仍保留。', 'hint'))
        const open = button('打开笔记', () => openNote(note)); open.disabled = Boolean(sourceText(note.sourceState))
        card.append(info, open, button('查看笔记与历史', () => history(note, () => { if (version === topicVersion) return showTopic(topic) }))); return card
      }
      $('topic-note-list').replaceChildren(...values.map(cardFor))
      const archived = result.notes.filter(note => note.archived)
      if (archived.length) {
        const details = element('details'); details.append(element('summary', `归档笔记（${archived.length}）`), ...archived.map(cardFor)); $('topic-note-list').append(details)
      }
      if (!values.length) $('topic-note-list').append(element('p', '进入文献研读后，可从原文或问答中保存笔记。', 'collection-empty'))
    } catch (error) { if (version === topicVersion) $('topic-note-list').replaceChildren(element('p', error.message, 'form-error')) }
  }
  return { load, reset, fromReference, fromAnswer, showTopic, selectTab }
}
