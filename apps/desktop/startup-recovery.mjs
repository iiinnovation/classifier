import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Native dialogs are owned by the main process. No filesystem or maintenance
// IPC is exposed to the renderer while its library is unreadable.
export async function recoverStartup({ error, controller, manager, run, dialog, closing = () => false }) {
  let failure = error.message
  while (!closing()) {
    const action = await dialog.showMessageBox({ type: 'error', title: '资料库未能打开', message: failure,
      detail: `当前位置：${controller.dataDir}\n未知格式不会自动转换或写入。可检查、保全原件，或从本版本可读取的备份恢复到新目录。没有兼容备份时，请使用支持该资料库格式的应用版本。`,
      buttons: ['退出', '检查并保存清单…', '保全资料原件…', '从兼容备份恢复…'], defaultId: 0, cancelId: 0 })
    if (!action.response || closing()) return false
    try {
      if (action.response === 1) {
        const result = await run('inspect', { source: controller.dataDir })
        const choice = await dialog.showSaveDialog({ title: '保存资料库检查清单', defaultPath: 'Classifier-library-check.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (!choice.canceled && choice.filePath && !closing()) await writeFile(choice.filePath, JSON.stringify(result, null, 2), { mode: 0o600 })
      } else if (action.response === 2) {
        const choice = await dialog.showOpenDialog({ title: '选择原件保全位置', properties: ['openDirectory'] })
        if (choice.canceled || !choice.filePaths[0] || closing()) continue
        const result = await run('preserve', { source: controller.dataDir, destination: join(choice.filePaths[0], 'Classifier-preserved-' + randomUUID()) })
        await dialog.showMessageBox({ type: 'info', message: '资料原件副本已保全', detail: result.destination + '\n副本可能仍含损坏内容，未声明数据库逻辑完整性。' })
      } else if (action.response === 3) {
        const kind = await dialog.showMessageBox({ type: 'question', message: '选择兼容备份', detail: '备份必须可由当前版本读取。恢复不会合并备份时点之后的修改。', buttons: ['取消', '目录备份…', 'ZIP 备份…'], defaultId: 0, cancelId: 0 })
        if (![1, 2].includes(kind.response) || closing()) continue
        const format = kind.response === 2 ? 'zip' : 'directory'
        const choice = await dialog.showOpenDialog({ title: '选择兼容备份', properties: [format === 'zip' ? 'openFile' : 'openDirectory'], ...(format === 'zip' ? { filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] } : {}) })
        if (choice.canceled || !choice.filePaths[0] || closing()) continue
        const source = choice.filePaths[0], preview = await run('backup-compatibility', { source, format })
        if (closing()) return false
        const confirmation = await dialog.showMessageBox({ type: 'question', title: '核对恢复时点', message: '从兼容备份恢复并打开',
          detail: `备份：${source}\n备份时点：${preview.snapshotCreatedAt}\n格式：${preview.storage}（版本 ${preview.formatVersion}）\n\n先保全当前资料原件，再恢复到新目录。备份时点之后的修改不会合并到恢复副本。原库完整保留，可用支持其格式的新版应用重新打开；恢复成功并启动后才保存新位置。`,
          buttons: ['取消', '恢复并打开'], defaultId: 0, cancelId: 0 })
        if (confirmation.response !== 1 || closing()) continue
        const result = await manager.restoreUnavailable(source, { format, revision: preview.revision })
        if (!closing()) await dialog.showMessageBox({ type: 'info', message: '已打开兼容备份的恢复副本', detail: `新资料库：${result.destination}\n原件保全：${result.preservation}\n备份时点：${result.snapshotCreatedAt}` })
        return true
      }
    } catch (error) {
      failure = error.message
      if (!closing()) await dialog.showMessageBox({ type: 'error', message: '资料库恢复未完成', detail: error.message })
    }
  }
  return false
}
