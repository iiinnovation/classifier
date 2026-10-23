import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// All paths originate in native dialogs. No renderer filesystem IPC is exposed.
export function libraryMenu({ dialog, manager, currentDirectory, getWindow, afterOperation, saveChecklist, migrationHome, closing = () => false }) {
  let task = null
  const message = options => dialog.showMessageBox(getWindow(), options)
  async function confirm(title, detail) {
    const result = await message({ type: 'question', title, message: title, detail: `${detail}\n\n工作台将暂停，正在运行的生成或导入任务会停止。请先保存编辑；会话模型连接需要重新填写。`, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0 })
    return result.response === 1 && !closing()
  }
  async function directory(title, defaultPath) {
    const choice = await dialog.showOpenDialog(getWindow(), { title, ...(defaultPath ? { defaultPath } : {}), properties: ['openDirectory'] })
    return choice.canceled || closing() ? null : choice.filePaths[0]
  }
  function action(work) {
    return () => {
      if (task || closing()) return
      task = Promise.resolve().then(work).catch(async error => {
        if (!closing()) await message({ type: 'error', title: '资料库操作未完成', message: error.message })
      }).finally(() => { task = null })
    }
  }
  async function execute(work) {
    try { return await work() } finally { if (!closing()) await afterOperation() }
  }
  return {
    async idle() { await task },
    template: { label: '资料库', submenu: [
      { label: '检查当前资料库…', click: action(async () => {
        if (!await confirm('检查当前资料库', `检查位置：${currentDirectory()}\n列出损坏和缺失内容，保留所有原始资料。`)) return
        const result = await execute(() => manager.inspect())
        const choice = await message({ type: result.restartError || result.issues.some(item => item.severity === 'error') ? 'warning' : 'info', title: '资料库检查结果', message: `${result.records} 条有效记录，${result.originals} 份原文件，${result.issueCount} 项提示`,
          detail: (result.restartError ? `工作台服务未能重启：${result.restartError}\n请保存检查清单并从备份核对资料。\n\n` : '') + (result.issues.length ? result.issues.slice(0, 20).map(item => `${item.path}\n${item.message}`).join('\n\n') + (result.issueCount > 20 ? '\n\n更多内容请保存检查清单。' : '') : '本次检查未发现异常。未校验所有跨记录关系；无历史哈希的原文件仅检查存在性。'),
          buttons: ['关闭', '保存检查清单…'], defaultId: 0, cancelId: 0 })
        if (choice.response === 1 && !closing()) await saveChecklist(result)
      }) },
      { label: '创建目录备份…', click: action(async () => {
        const parent = await directory('选择备份存放目录（将在其中创建新目录）')
        if (!parent || !await confirm('创建资料库备份', '将复制当前记录、原文件和历史，校验后保存到新目录。')) return
        const result = await execute(() => manager.backup(join(parent, 'Classifier-backup-' + randomUUID())))
        await message({ type: 'info', message: '备份已完成并通过校验', detail: result.destination })
      }) },
      { label: '从目录备份恢复…', click: action(async () => {
        const source = await directory('选择包含 backup-manifest.json 的备份目录')
        if (!source || !await confirm('恢复备份并打开', `备份位置：${source}\n先备份当前库，再恢复到新目录。原库保留，备份时点之后的修改不会合并到恢复副本。`)) return
        const result = await execute(() => manager.restore(source))
        await message({ type: 'info', message: '已打开恢复后的资料库', detail: `新资料库：${result.destination}\n切换前备份：${result.previousBackup}` })
      }) },
      { label: '打开已有资料库…', click: action(async () => {
        const source = await directory('选择已有资料库目录')
        if (!source || !await confirm('打开已有资料库', `位置：${source}\n先检查目标库并备份当前库，再切换。两份资料分别保留，不合并。`)) return
        const result = await execute(() => manager.switchTo(source))
        await message({ type: 'info', message: '已打开资料库', detail: result.destination })
      }) },
      { type: 'separator' },
      { label: '升级当前 JSON 资料库…', click: action(async () => {
        if (!await confirm('升级当前资料库为 SQLite', `当前位置：${currentDirectory()}\n先创建升级前备份，再迁移到新目录；通过检查并启动后才切换，原 JSON 资料库保留。迁移期间请勿强制退出应用。`)) return
        const result = await execute(() => manager.migrate())
        await message({ type: 'info', message: '资料库升级完成', detail: `新资料库：${result.destination}\n升级前备份：${result.backup}\n迁移记录：${result.records} 条` })
      }) },
      { label: '查看迁移进度或继续迁移…', click: action(async () => {
        const source = await directory('选择迁移暂存目录或已发布的迁移目录', migrationHome)
        if (!source) return
        const status = await manager.migrationStatus(source)
        const phases = { records: '迁移记录', files: '迁移原文件', published: '已发布，等待完成标记', complete: '已完成' }
        const choice = await message({ type: 'info', title: '迁移进度', message: phases[status.phase] || status.phase,
          detail: `记录：${status.completedRecords}/${status.totalRecords}\n文件：${status.completedFiles}/${status.totalFiles}\n备份时点：${status.snapshotCreatedAt}\n备份：${status.backup}\n目标：${status.destination}`,
          buttons: ['关闭', status.phase === 'complete' ? '打开此资料库…' : '继续迁移…'], defaultId: 0, cancelId: 0 })
        if (choice.response !== 1 || closing()) return
        if (!await confirm('继续迁移并打开资料库', `将使用 ${status.snapshotCreatedAt} 的固定备份。\n中断之后的修改不会合并；切换前会另行备份当前资料库。已完成的迁移不会重复写入或覆盖后来修改。`)) return
        const result = await execute(() => manager.resumeMigration(source))
        await message({ type: 'info', message: '迁移资料库已打开', detail: `资料库：${result.destination}\n原迁移备份：${result.backup}${result.previousBackup ? '\n切换前备份：' + result.previousBackup : ''}` })
      }) },
    ] },
  }
}
