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
        const choice = await message({ type: result.restartError || result.issues.some(item => item.severity === 'error') ? 'warning' : 'info', title: '资料库检查结果', message: `${result.records} 条有效记录，${result.originals} 份原文件，${result.quarantinedRecords || 0} 份隔离副本，${result.issueCount} 项提示`,
          detail: (result.restartError ? `工作台服务未能重启：${result.restartError}\n请保存检查清单并从备份核对资料。\n\n` : '') + (result.issues.length ? result.issues.slice(0, 20).map(item => `${item.path}\n${item.message}`).join('\n\n') + (result.issueCount > 20 ? '\n\n更多内容请保存检查清单。' : '') : '本次检查未发现异常。未校验所有跨记录关系；无历史哈希的原文件仅检查存在性。'),
          buttons: ['关闭', '保存检查清单…'], defaultId: 0, cancelId: 0 })
        if (choice.response === 1 && !closing()) await saveChecklist(result)
      }) },
      { label: '保全当前资料原件…', click: action(async () => {
        const parent = await directory('选择原件保全位置（将在其中创建新目录）')
        if (!parent || !await confirm('保全当前资料原件', '逐文件复制并校验当前记录、原文件和数据库辅助文件。副本可能仍含损坏内容，用于保留恢复机会，不代表已经修复或可作为正常备份使用。')) return
        const result = await execute(() => manager.preserve(join(parent, 'Classifier-preserved-' + randomUUID())))
        await message({ type: result.restartError ? 'warning' : 'info', message: '资料原件副本已保全', detail: `${result.destination}${result.restartError ? '\n服务重启未完成：' + result.restartError : ''}\n副本未通过数据库逻辑完整性验证，请保留并核对。` })
      }) },
      { label: '选择性恢复损坏资料…', click: action(async () => {
        const kind = await message({ type: 'question', message: '选择恢复来源', detail: '从备份或保留的临时版本逐项选择，只在新资料库中修复。当前资料库完整保留。', buttons: ['取消', '目录备份…', 'ZIP 备份…'], defaultId: 0, cancelId: 0 })
        if (!kind.response || closing()) return
        const format = kind.response === 2 ? 'zip' : 'directory'
        let source
        if (format === 'directory') source = await directory('选择包含 backup-manifest.json 的备份目录')
        else {
          const chosen = await dialog.showOpenDialog(getWindow(), { title: '选择 ZIP 备份', properties: ['openFile'], filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] })
          if (!chosen.canceled && !closing()) source = chosen.filePaths[0]
        }
        if (!source || !await confirm('预览可恢复资料', '将检查当前库与备份，并列出可选版本。暂不替换资料；选择后还需核对最终恢复范围。')) return
        const plan = await execute(() => manager.recoveryPreview(source, { format })), selections = [], targets = []
        for (const item of plan.items) {
          if (closing()) return
          if (!item.choices.length) continue
          const choices = item.choices.slice(0, 6)
          const choice = await message({ type: 'question', title: '选择恢复版本', message: item.target,
            detail: `${item.currentReadable ? '当前记录可读。选择临时版本将替换新库中的这一条，原已保存版本完整保全。' : item.type === 'original' ? '原文件缺失或校验不符。' : '记录损坏或主文件缺失。'}\n备份时点：${plan.snapshotCreatedAt}\n${choices.map((candidate, i) => `${i + 1}. ${candidate.from === 'backup' ? '备份版本' : '中断写入副本'} · ${candidate.savedAt}${candidate.revision === null ? '' : ' · 版本 ' + candidate.revision}${candidate.includesOriginal ? '（同时恢复原文件，已有引用可能需要复核）' : ''}`).join('\n')}${item.choices.length > choices.length ? '\n本次展示前六个候选，其余版本仍保留。' : ''}`,
            buttons: ['跳过', ...choices.map((candidate, i) => `选择版本 ${i + 1}`), '结束选择'], defaultId: 0, cancelId: 0 })
          if (choice.response === choices.length + 1) break
          if (choice.response > 0 && choice.response <= choices.length) { selections.push(choices[choice.response - 1].key); targets.push(item.target) }
        }
        if (!selections.length) {
          await message({ type: 'info', message: '未选择恢复项目', detail: `发现 ${plan.itemCount} 项待核对资料，另有 ${plan.blockedCount || 0} 项无法形成可用候选。无可用候选或未选中的资料继续保留；未替换任何记录。` }); return
        }
        if (!await confirm('确认所选恢复范围', `将在新库中恢复 ${selections.length} 项：\n${targets.slice(0, 20).join('\n')}${targets.length > 20 ? '\n其余所选项目已计入总数。' : ''}\n\n其他正常资料保留当前修改；未选的异常项目继续隔离。与所选原文件冲突的旧待办将由本次恢复替代，不再重放，原日志完整保全。先创建当前原件的完整保全副本，再恢复并检查新库，启动成功后才切换。`)) return
        const result = await execute(() => manager.recover(source, { format, revision: plan.revision, selections }))
        await message({ type: result.remainingIssues ? 'warning' : 'info', message: '所选资料已恢复并打开新库', detail: `已恢复 ${result.restored} 项，仍有 ${result.remainingIssues} 项检查提示。\n新资料库：${result.destination}\n当前原件保全：${result.preservation}` })
      }) },
      { label: '创建目录备份…', click: action(async () => {
        const parent = await directory('选择备份存放目录（将在其中创建新目录）')
        if (!parent || !await confirm('创建资料库备份', '将复制当前记录、原文件和历史，校验后保存到新目录。')) return
        const result = await execute(() => manager.backup(join(parent, 'Classifier-backup-' + randomUUID())))
        await message({ type: 'info', message: '备份已完成并通过校验', detail: result.destination })
      }) },
      { label: '导出 ZIP 备份…', click: action(async () => {
        const choice = await dialog.showSaveDialog(getWindow(), { title: '保存 ZIP 资料库备份', defaultPath: 'Classifier-backup-' + randomUUID() + '.zip', filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] })
        if (choice.canceled || !choice.filePath || closing() || !await confirm('导出 ZIP 资料库备份', '将当前记录、原文件和历史保存为一个 ZIP 文件，校验后完成。请选择新文件名。')) return
        const result = await execute(() => manager.backupZip(choice.filePath))
        await message({ type: 'info', message: 'ZIP 备份已完成并通过校验', detail: result.destination })
      }) },
      { label: '从目录备份恢复…', click: action(async () => {
        const source = await directory('选择包含 backup-manifest.json 的备份目录')
        if (!source || !await confirm('恢复备份并打开', `备份位置：${source}\n先备份当前库，再恢复到新目录。原库保留，备份时点之后的修改不会合并到恢复副本。`)) return
        const result = await execute(() => manager.restore(source))
        await message({ type: 'info', message: '已打开恢复后的资料库', detail: `新资料库：${result.destination}\n切换前备份：${result.previousBackup}` })
      }) },
      { label: '从 ZIP 备份恢复…', click: action(async () => {
        const choice = await dialog.showOpenDialog(getWindow(), { title: '选择 Classifier ZIP 备份', properties: ['openFile'], filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] })
        const source = choice.filePaths?.[0]
        if (choice.canceled || !source || closing() || !await confirm('从 ZIP 恢复并打开', `备份位置：${source}\n先验证 ZIP 并备份当前库，再恢复到新目录。原库保留，备份时点之后的修改不会合并到恢复副本。`)) return
        const result = await execute(() => manager.restore(source, { format: 'zip' }))
        await message({ type: 'info', message: '已打开 ZIP 恢复后的资料库', detail: `新资料库：${result.destination}\n切换前备份：${result.previousBackup}` })
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
      { label: '从升级前备份重新准备迁移…', click: action(async () => {
        const source = await directory('选择已验证的升级前 JSON 目录备份')
        if (!source || !await confirm('从固定备份重新准备迁移', `备份位置：${source}\n用于迁移准备未完成、无法继续原批次的情况。将先备份当前库，再从该备份时点建立新迁移批次并打开。备份之后的修改不会合并；旧暂存目录完整保留，不原地修复或覆盖。`)) return
        const result = await execute(() => manager.migrateFromBackup(source))
        await message({ type: 'info', message: '已从升级前备份重建并打开迁移库', detail: `资料库：${result.destination}\n固定备份：${result.backup}\n备份时点：${result.snapshotCreatedAt}\n切换前备份：${result.previousBackup}` })
      }) },
    ] },
  }
}
