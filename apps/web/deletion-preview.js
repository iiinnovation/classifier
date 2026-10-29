export function createDeletionPreview({ api, element, onDeleted = async () => {} }) {
  const labels = { documents: '文献', topics: '主题', notes: '笔记', comparisons: '比较表', reports: '成果', runs: '模型任务', imports: '导入任务' }
  const dialog = element('dialog', null, 'edit-dialog'), heading = element('h2', '删除影响预览'), content = element('div'), message = element('p', '', 'hint')
  const close = element('button', '关闭', 'quiet-button'), refresh = element('button', '刷新影响范围', 'quiet-button'), actions = element('div', null, 'collection-actions')
  const execute = element('button', '确认普通删除', 'quiet-button'), confirmation = element('label', null, 'attach-option'), check = element('input'), confirmationText = element('span')
  check.type = 'checkbox'; check.id = 'deletion-confirm'; execute.id = 'deletion-execute'; execute.type = 'button'; execute.hidden = true
  confirmation.append(check, confirmationText); confirmation.hidden = true
  dialog.id = 'deletion-preview-dialog'; heading.id = 'deletion-preview-title'; dialog.setAttribute('aria-labelledby', heading.id)
  close.type = refresh.type = 'button'; message.setAttribute('role', 'status')
  actions.append(refresh, execute, close); dialog.append(heading, message, content, confirmation, actions); document.body.append(dialog)
  let request = 0, target = null, preview = null, operationId = null, executing = false
  function invalidate() { request++; target = null }
  close.onclick = () => { if (!executing) { invalidate(); dialog.close() } }
  dialog.addEventListener('cancel', event => { if (executing) event.preventDefault(); else invalidate() })
  dialog.addEventListener('close', invalidate)
  function group(title, records, describe) {
    if (!records.length) return
    const section = element('details'), summary = element('summary', `${title}（${records.length}）`), list = element('ul')
    for (const record of records.slice(0, 100)) list.append(element('li', describe(record)))
    if (records.length > 100) list.append(element('li', `另有 ${records.length - 100} 项，汇总已包含全部项目。`))
    section.append(summary, list); content.append(section)
  }
  async function load(value) {
    if (executing) return
    target = value
    preview = null; operationId = null; check.checked = false; confirmation.hidden = true; execute.hidden = true; execute.disabled = true
    const ticket = ++request
    heading.textContent = value.action === 'detach' ? '移出主题影响预览' : '删除影响预览'
    content.replaceChildren(); message.textContent = '正在检查关联、历史和活动任务…'; refresh.disabled = true
    if (!dialog.open) dialog.showModal()
    try {
      const query = value.action === 'detach' ? `?action=detach&topicId=${encodeURIComponent(value.topicId)}` : ''
      const result = await api(`/api/deletion-preview/${value.bucket}/${value.id}${query}`)
      if (ticket !== request || !dialog.open) return
      heading.textContent = `${result.action === 'detach' ? '移出主题' : '删除'}影响预览 · ${result.target.title}`
      message.textContent = result.complete ? '本次已读取当前影响范围；预览不会修改资料。' : '影响范围尚不完整，请先处理以下问题。'
      const counts = result.counts
      content.append(element('p', `涉及 ${counts.records} 条记录及其 ${counts.historyVersions} 个历史版本、${counts.topicLinks} 处主题关联、${counts.originalDocuments} 篇原文；保留 ${counts.retainedResearch} 条相关研究记录。`))
      const retention = element('details'); retention.append(element('summary', '保留内容与删除说明'))
      for (const notice of result.notices) {
        const node = element('p', notice, 'hint')
        if (notice.includes('JSON')) content.append(node); else retention.append(node)
      }
      for (const blocker of result.blockers) content.append(element('p', blocker.message, 'form-error'))
      content.append(retention)
      const describe = record => `${labels[record.bucket]}：${record.title}${record.historyVersions ? ` · ${record.historyVersions} 个自身历史版本` : ''}`
      group('按当前方案移除的记录', result.removes, describe)
      group('解除的主题关联', result.links, link => `${link.title} · 文献 ${link.documentId}`)
      group('保留的文献', result.preserves.documents, describe)
      group('保留的相关研究与复制内容', result.preserves.research, record => `${describe(record)}${record.currentReference ? ' · 当前内容有关联' : ''}${record.historicalVersions ? ` · ${record.historicalVersions} 个历史版本有关联` : ''}${record.retainedSource ? ' · 原始研究材料保留' : ''}`)
      group('需要协调的任务', result.tasks, task => `${labels[task.bucket]} · ${task.active ? '正在进行' : '已结束'} · ${task.status}${task.removesRecord ? ' · 所属任务记录随目标删除' : ' · 任务记录保留'} · ${task.id}`)
      preview = result; operationId = crypto.randomUUID()
      if (result.executionAvailable) {
        confirmation.hidden = execute.hidden = false
        confirmationText.textContent = `我确认删除上述 ${counts.records} 条记录及其 ${counts.historyVersions} 个历史版本、${counts.taskRecords} 条所属任务记录${counts.activeTasks ? `，并停止 ${counts.activeTasks} 个相关活动任务` : ''}；其他研究中的引用摘录、备份和导出副本保留。`
      }
    } catch (error) { if (ticket === request && dialog.open) message.textContent = error.message || '影响范围暂时无法读取，请重试。' }
    finally { if (ticket === request) refresh.disabled = false }
  }
  check.onchange = () => { execute.disabled = !check.checked || !preview?.complete || executing }
  execute.onclick = async () => {
    if (executing || !preview?.executionAvailable || !preview.complete || !check.checked) return
    executing = true; close.disabled = refresh.disabled = execute.disabled = check.disabled = true
    message.textContent = '正在停止相关任务并提交删除，请等待结果…'
    try {
      const result = await api(`/api/${target.bucket}/${target.id}`, { method: 'DELETE', timeoutMs: 60000, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, revision: preview.revision, policy: preview.policy, confirmed: true, stopTasks: true }) })
      executing = false; invalidate(); dialog.close()
      await onDeleted(result)
    } catch (error) { message.textContent = error.message || '删除结果暂未确认；可使用当前请求重试，或核对资料库。' }
    finally { executing = false; close.disabled = refresh.disabled = check.disabled = false; execute.disabled = !check.checked || !preview?.complete }
  }
  refresh.onclick = () => { if (target) void load(target) }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-deletion-bucket]')
    if (!button || button.disabled || !button.dataset.deletionId) return
    void load({ bucket: button.dataset.deletionBucket, id: button.dataset.deletionId, action: button.dataset.deletionAction || 'delete', topicId: button.dataset.deletionTopic })
  })
  return { open: load, close() { invalidate(); dialog.close() } }
}
