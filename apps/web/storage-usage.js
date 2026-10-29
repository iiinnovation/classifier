export function createStorageUsage({ api, element, button }) {
  const dialog = element('dialog', null, 'edit-dialog'), title = element('h2', '存储用量与保留'), status = element('p', '', 'hint'), body = element('div')
  const refresh = element('button', '刷新用量', 'quiet-button'), close = element('button', '关闭', 'quiet-button'), actions = element('div', null, 'collection-actions')
  dialog.id = 'storage-usage-dialog'; title.id = 'storage-usage-title'; dialog.setAttribute('aria-labelledby', title.id)
  status.setAttribute('role', 'status'); close.type = refresh.type = 'button'
  actions.append(refresh, close); dialog.append(title, status, body, actions); document.body.append(dialog)
  let ticket = 0
  function invalidate() { ticket++ }
  close.onclick = () => { invalidate(); dialog.close() }
  dialog.addEventListener('cancel', invalidate); dialog.addEventListener('close', invalidate)
  function size(value) {
    if (value === null) return '未统计'
    if (value < 1024) return `${value} B`
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4)
    return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
  }
  function line(label, text, parent = body) { const row = element('p'); row.append(element('strong', label + '：'), document.createTextNode(text)); parent.append(row) }
  async function load() {
    const current = ++ticket
    body.replaceChildren(); status.textContent = '正在统计资料库文件…'; refresh.disabled = true
    if (!dialog.open) dialog.showModal()
    try {
      const value = await api('/api/storage-usage')
      if (ticket !== current || !dialog.open) return
      status.textContent = `${value.complete ? '本次扫描完成' : '本次统计不完整，已读取部分仍可查看'} · ${new Date(value.finishedAt).toLocaleString()}`
      line('当前资料库文件', `${size(value.library.bytes)} · ${value.library.files} 个文件`)
      const empty = element('details'); empty.append(element('summary', '其他存储类别'))
      for (const group of value.library.categories) line(group.label, `${size(group.bytes)} · ${group.files} 个文件`, group.bytes || group.files ? body : empty)
      if (empty.children.length > 1) body.append(empty)
      line('自动备份与保全副本', value.managedBackups.available ? `${size(value.managedBackups.bytes)} · ${value.managedBackups.files} 个文件${value.managedBackups.complete ? '' : ' · 统计不完整'}（整个配置目录，可能包含其他资料库）` : '未统计；Web 开发环境未提供桌面备份目录，或备份目录不可安全读取。')
      const records = value.records
      line('已读有效记录', `${records.count} 条，其中 ${records.archived} 条归档；${records.historyVersions} 个历史版本${records.complete ? '' : ' · 统计不完整'}`)
      const details = element('details'), heading = element('summary', '统计口径与数据保留'), list = element('ul')
      details.append(heading)
      line('记录正文估算', size(records.currentBytes), details); line('历史内容估算', size(records.historyBytes), details)
      line('资料库文件精确大小', `${value.library.bytes.toLocaleString()} 字节`, details)
      for (const text of value.notices) list.append(element('li', text))
      details.append(list); body.append(details)
      body.append(element('p', '归档不释放空间；当前页面只查看用量。', 'hint'))
      details.append(element('h3', '未纳入统计'))
      for (const text of value.unmeasured) details.append(element('p', text, 'hint'))
      if (value.issueCount) body.append(element('p', `${value.issueCount} 项无法完整统计（例如文件变化、损坏、链接或读取限制）。请结束在途任务后刷新，仍异常时从资料库菜单检查。`, 'form-error'))
    } catch (error) { if (ticket === current && dialog.open) status.textContent = error.message || '暂时无法统计，请重试。' }
    finally { if (ticket === current) refresh.disabled = false }
  }
  button.onclick = refresh.onclick = () => { void load() }
  return { open: load, close() { invalidate(); dialog.close() } }
}
