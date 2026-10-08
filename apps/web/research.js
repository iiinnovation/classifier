export function createResearchWorkspace({ api, element, openDocument, resetReader, openImport, metadataChanged, libraryChanged }) {
  const $ = id => document.getElementById(id)
  const selectionLabels = { pending: '待筛选', included: '已纳入', excluded: '已排除' }
  const readingLabels = { unread: '未读', reading: '阅读中', read: '已读' }
  let topics = [], documents = [], activeTopic = null, readerId = null
  let view = 'home', navigation = 0, refreshVersion = 0, documentsVersion = 0
  let editingTopic = null, editingDocument = null, editingLink = null, attachingTopic = null
  const chosenDocuments = new Set()
  const saving = new Set()
  const report = error => notice(error.message || String(error), true)
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  function notice(message, error = false) {
    $('app-message').hidden = !message
    $('app-message').textContent = message
    $('app-message').className = `app-message${error ? ' is-error' : ''}`
    $('app-message').setAttribute('role', error ? 'alert' : 'status')
  }
  function remember() {
    localStorage.setItem('classifier-workspace', JSON.stringify({ view, topicId: activeTopic?.id || null, documentId: view === 'reader' ? readerId : null }))
  }
  function panels() {
    $('research-home-panel').hidden = view !== 'home'
    $('topic-panel').hidden = view !== 'topic' || !activeTopic
    $('all-documents-panel').hidden = view !== 'all'
    $('workspace').hidden = view !== 'reader'
    $('welcome').hidden = true
  }
  function navigate(next) {
    navigation++
    resetReader()
    readerId = null
    view = next
    notice('')
    panels()
  }
  function button(label, action, className = 'quiet-button') {
    const node = element('button', label, className)
    node.type = 'button'
    node.onclick = () => Promise.resolve().then(action).catch(report)
    return node
  }
  function searchable(doc, query) {
    return `${doc.title} ${doc.fileName} ${doc.bibliography?.authors || ''} ${doc.bibliography?.year || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }
  function documentCard(doc, link = null) {
    const card = element('article', null, 'document-card')
    card.dataset.documentId = doc.id
    const title = button(doc.title, () => openDocument(doc.id), 'document-link')
    const bibliography = doc.bibliography || {}
    const info = element('div', null, 'document-card-body')
    info.append(title, element('p', [bibliography.authors, bibliography.year, bibliography.venue].filter(Boolean).join(' · ') || doc.fileName, 'document-byline'))
    if (link) {
      const statuses = element('div', null, 'document-statuses')
      statuses.append(element('span', selectionLabels[link.selection], `status-chip ${link.selection}`), element('span', readingLabels[link.readingStatus], 'status-chip'))
      info.append(statuses)
      if (link.relevance) info.append(element('p', `相关性：${link.relevance}`, 'record-preview'))
      if (link.reason) info.append(element('p', `筛选理由：${link.reason}`, 'record-preview'))
    }
    const actions = element('div', null, 'document-actions')
    actions.append(button('打开研读', () => openDocument(doc.id)), button('书目信息', () => editMetadata(doc.id)))
    if (link) {
      const topicId = activeTopic.id
      actions.append(button('筛选与阅读记录', () => editRecord(doc.id)))
      const remove = button('移出主题', async () => {
        remove.disabled = true
        try {
          updateTopic(await api(`/api/topics/${topicId}/documents/${doc.id}`, { method: 'DELETE' }))
          await refreshSaved('已移出主题。文献仍保存在全部文献中。')
        } finally { remove.disabled = false }
      }, 'quiet-button remove-link')
      actions.append(remove)
    }
    card.append(info, actions)
    return card
  }
  function renderHome() {
    $('topic-cards').replaceChildren(...topics.map(topic => {
      const card = button(null, () => showTopic(topic.id), 'topic-card')
      card.append(element('h2', topic.title), element('p', topic.question), element('small', `${topic.documentCount} 篇文献 · ${topic.includedCount} 篇已纳入 · ${topic.readCount} 篇已读`))
      return card
    }))
    if (!topics.length) $('topic-cards').append(element('p', '创建第一个研究主题，把研究问题和相关文献放在一起。', 'collection-empty'))
    $('all-document-count').textContent = `已保存 ${documents.length} 篇文献，可直接研读或关联到多个主题。`
  }
  function renderAll() {
    const matching = documents.filter(doc => searchable(doc, $('library-query').value))
    $('all-documents-list').replaceChildren(...matching.map(doc => documentCard(doc)))
    if (!matching.length) $('all-documents-list').append(element('p', documents.length ? '没有符合条件的文献。' : '导入第一份资料，开始文献研读。', 'collection-empty'))
  }
  function renderTopic() {
    if (!activeTopic) return
    $('topic-title').textContent = activeTopic.title
    $('topic-question').textContent = activeTopic.question
    $('topic-scope').textContent = activeTopic.scope
    $('topic-scope-section').hidden = !activeTopic.scope
    $('topic-stats').textContent = `${activeTopic.documentCount} 篇文献 · ${activeTopic.includedCount} 篇已纳入 · ${activeTopic.readCount} 篇已读`
    const selection = $('selection-filter').value, reading = $('reading-filter').value
    const links = activeTopic.documents.filter(link => (!selection || link.selection === selection) && (!reading || link.readingStatus === reading))
    $('topic-documents').replaceChildren(...links.map(link => documentCard(link.document, link)))
    if (!links.length) $('topic-documents').append(element('p', activeTopic.documents.length ? '没有符合当前筛选条件的文献。' : '导入新文献，或从全部文献中关联已有资料。', 'collection-empty'))
    $('reader-back').textContent = `← ${activeTopic.title}`
  }
  async function refresh() {
    const token = navigation, version = ++refreshVersion, topicId = activeTopic?.id
    const documentRequest = beginDocumentsRequest()
    const [library, collection, topic] = await Promise.all([api('/api/documents'), api('/api/topics'), topicId ? api(`/api/topics/${topicId}`) : null])
    if (version !== refreshVersion || token !== navigation) return
    topics = collection.topics
    if (topicId && activeTopic?.id === topicId) activeTopic = topic
    setDocuments(library.documents, documentRequest)
    renderHome(); renderTopic()
  }
  async function refreshSaved(message, reload = refresh) {
    try { await reload(); notice(message) }
    catch (error) { notice(`${message} 页面刷新失败：${error.message}。可以重新打开当前页面查看。`, true) }
  }
  function updateTopic(topic) {
    refreshVersion++
    const counts = {
      documentCount: topic.documents.length,
      includedCount: topic.documents.filter(link => link.selection === 'included').length,
      readCount: topic.documents.filter(link => link.readingStatus === 'read').length,
    }
    const current = { ...topic, ...counts }
    topics = [current, ...topics.filter(item => item.id !== topic.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (activeTopic?.id === topic.id) activeTopic = current
    renderHome(); renderTopic()
  }
  function showHome() {
    activeTopic = null
    navigate('home'); renderHome(); remember()
    return refresh()
  }
  function showAll() {
    activeTopic = null
    navigate('all'); renderAll(); remember()
    return refresh()
  }
  async function showTopic(id) {
    activeTopic = null
    navigate('topic')
    const token = navigation
    notice('正在打开研究主题…')
    try {
      const topic = await api(`/api/topics/${id}`)
      if (token !== navigation) return
      activeTopic = topic
      $('selection-filter').value = ''; $('reading-filter').value = ''
      panels(); renderTopic(); remember(); notice('')
      return true
    } catch (error) {
      if (token !== navigation) return
      view = 'home'; panels(); renderHome(); remember(); report(error)
      return false
    }
  }
  function readerOpened(id) {
    readerId = id
    if (!activeTopic?.documents.some(link => link.documentId === id)) activeTopic = null
    view = 'reader'; panels(); remember()
    $('reader-back').textContent = activeTopic ? `← ${activeTopic.title}` : '← 全部文献'
    $('reader-record').hidden = !activeTopic
  }
  function beginDocumentsRequest() { return ++documentsVersion }
  function setDocuments(values, version = beginDocumentsRequest()) {
    if (version !== documentsVersion) return false
    documents = values
    renderHome(); renderAll()
    libraryChanged(documents)
    return true
  }
  function prepareImport() {
    if ($('file').disabled) return
    $('import-topic').replaceChildren(element('option', '仅保存到全部文献'))
    $('import-topic').children[0].value = ''
    for (const topic of topics) {
      const option = element('option', topic.title)
      option.value = topic.id
      $('import-topic').append(option)
    }
    $('import-topic').value = activeTopic?.id || ''
  }
  async function restore(expectedNavigation = navigation) {
    if (expectedNavigation !== navigation) return
    const collection = await api('/api/topics')
    if (expectedNavigation !== navigation) return
    topics = collection.topics
    renderHome()
    let saved
    try { saved = JSON.parse(localStorage.getItem('classifier-workspace') || 'null') } catch { /* Ignore obsolete browser navigation data. */ }
    if (saved?.topicId && topics.some(topic => topic.id === saved.topicId)) {
      if (await showTopic(saved.topicId) !== true) return
    }
    if (saved?.view === 'reader' && documents.some(doc => doc.id === saved.documentId)) {
      await openDocument(saved.documentId)
    } else if (saved?.view === 'all') await showAll()
    else if (!activeTopic) {
      const legacy = !saved && localStorage.getItem('classifier-document')
      if (documents.some(doc => doc.id === legacy)) await openDocument(legacy)
      else await showHome()
    }
  }
  function editTopic(topic = null) {
    editingTopic = topic?.id || null
    $('topic-dialog-title').textContent = topic ? '编辑研究主题' : '创建研究主题'
    $('topic-name-input').value = topic?.title || ''
    $('topic-question-input').value = topic?.question || ''
    $('topic-scope-input').value = topic?.scope || ''
    $('topic-form-error').textContent = ''
    $('topic-dialog').showModal()
  }
  function editMetadata(id) {
    const doc = documents.find(item => item.id === id)
    if (!doc) return
    editingDocument = id
    $('metadata-name').value = doc.title
    for (const field of ['authors', 'year', 'venue', 'doi', 'url']) $(`metadata-${field}`).value = doc.bibliography?.[field] || ''
    $('metadata-error').textContent = ''
    $('metadata-dialog').showModal()
  }
  function editRecord(id) {
    const link = activeTopic?.documents.find(item => item.documentId === id)
    if (!link) return
    editingLink = { topicId: activeTopic.id, documentId: id }
    $('record-context').textContent = `${activeTopic.title} · ${link.document.title}。记录仅用于当前主题。`
    $('record-selection').value = link.selection; $('record-reading').value = link.readingStatus
    $('record-relevance').value = link.relevance; $('record-reason').value = link.reason
    $('record-error').textContent = ''
    $('record-dialog').showModal()
  }
  function renderAttach() {
    const matching = documents.filter(doc => !attachingTopic.documents.some(link => link.documentId === doc.id) && searchable(doc, $('attach-query').value))
    $('attach-options').replaceChildren(...matching.map(doc => {
      const label = element('label', null, 'attach-option'), input = element('input')
      input.type = 'checkbox'; input.value = doc.id; input.checked = chosenDocuments.has(doc.id)
      input.onchange = () => input.checked ? chosenDocuments.add(doc.id) : chosenDocuments.delete(doc.id)
      label.append(input, element('span', doc.title))
      return label
    }))
    if (!matching.length) $('attach-options').append(element('p', '没有可关联的匹配文献，可以调整搜索或导入新资料。', 'hint'))
  }
  function form(id, dialogId, errorId, closeId, submit) {
    const dialog = $(dialogId)
    $(closeId).onclick = () => { if (!saving.has(dialogId)) dialog.close() }
    dialog.oncancel = event => { if (saving.has(dialogId)) event.preventDefault() }
    $(id).onsubmit = async event => {
      event.preventDefault()
      if (saving.has(dialogId)) return
      saving.add(dialogId)
      const controls = [...$(id).elements, $(closeId)]
      const disabled = controls.map(control => control.disabled)
      controls.forEach(control => { control.disabled = true })
      $(errorId).textContent = ''
      try { await submit(); dialog.close() }
      catch (error) { $(errorId).textContent = error.message }
      finally { saving.delete(dialogId); controls.forEach((control, index) => { control.disabled = disabled[index] }) }
    }
  }
  form('topic-form', 'topic-dialog', 'topic-form-error', 'close-topic', async () => {
    const data = { title: $('topic-name-input').value, question: $('topic-question-input').value, scope: $('topic-scope-input').value }
    const topic = await api(editingTopic ? `/api/topics/${editingTopic}` : '/api/topics', json(editingTopic ? 'PATCH' : 'POST', data))
    editingTopic = topic.id
    updateTopic(topic)
    await refreshSaved('研究主题已保存。', async () => {
      if (await showTopic(topic.id) === false) throw new Error('暂时无法读取主题')
      await refresh()
    })
  })
  form('metadata-form', 'metadata-dialog', 'metadata-error', 'close-metadata', async () => {
    const id = editingDocument, data = { title: $('metadata-name').value }
    for (const field of ['authors', 'year', 'venue', 'doi', 'url']) data[field] = $(`metadata-${field}`).value
    const updated = await api(`/api/documents/${id}`, json('PATCH', data))
    refreshVersion++
    setDocuments(documents.map(doc => doc.id === id ? updated : doc))
    if (activeTopic) activeTopic.documents = activeTopic.documents.map(link => link.documentId === id ? { ...link, document: updated } : link)
    renderTopic()
    metadataChanged(updated)
    await refreshSaved('书目信息已保存，所有关联主题已同步。')
  })
  form('record-form', 'record-dialog', 'record-error', 'close-record', async () => {
    const { topicId, documentId } = editingLink
    updateTopic(await api(`/api/topics/${topicId}/documents/${documentId}`, json('PATCH', { selection: $('record-selection').value, readingStatus: $('record-reading').value, relevance: $('record-relevance').value, reason: $('record-reason').value })))
    await refreshSaved('当前主题的筛选与阅读记录已保存。')
  })
  form('attach-form', 'attach-dialog', 'attach-error', 'close-attach', async () => {
    if (!chosenDocuments.size) throw new Error('请先选择文献。')
    const target = attachingTopic.id
    try {
      for (const id of [...chosenDocuments]) {
        const updated = await api(`/api/topics/${target}/documents/${id}`, { method: 'PUT' })
        updateTopic(updated); attachingTopic = updated
        chosenDocuments.delete(id)
      }
    } finally {
      renderAttach()
    }
    await refreshSaved('所选文献已关联到研究主题。')
  })
  $('research-home').onclick = () => showHome().catch(report)
  $('topic-back').onclick = () => showHome().catch(report)
  $('all-documents-open').onclick = () => showAll().catch(report)
  $('new-topic').onclick = () => editTopic()
  $('edit-topic').onclick = () => editTopic(activeTopic)
  $('all-import').onclick = openImport
  $('topic-import').onclick = openImport
  $('selection-filter').onchange = renderTopic
  $('reading-filter').onchange = renderTopic
  $('library-query').oninput = renderAll
  $('reader-back').onclick = () => (activeTopic ? showTopic(activeTopic.id) : showAll()).catch(report)
  $('edit-document').onclick = () => editMetadata(readerId)
  $('reader-record').onclick = () => editRecord(readerId)
  $('attach-existing').onclick = () => {
    attachingTopic = activeTopic
    chosenDocuments.clear(); $('attach-query').value = ''; $('attach-error').textContent = ''
    renderAttach(); $('attach-dialog').showModal()
  }
  $('attach-query').oninput = renderAttach
  return { beginDocumentsRequest, setDocuments, restore, refresh, readerOpening: () => ++navigation, readerOpened, prepareImport, showTopic, notice, report, navigationKey: () => navigation }
}
