import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryMenu } from '../apps/desktop/library-menu.mjs'

function fixture({ responses = [], paths = [], savePaths = [], manager = {} } = {}) {
  const messages = [], calls = [], checklists = [], openDialogs = [], saveDialogs = []
  const menu = libraryMenu({
    dialog: {
      async showMessageBox(_window, options) { messages.push(options); return { response: responses.shift() ?? 0 } },
      async showOpenDialog(_window, options) { openDialogs.push(options); const path = paths.shift(); return path ? { canceled: false, filePaths: [path] } : { canceled: true } },
      async showSaveDialog(_window, options) { saveDialogs.push(options); const path = savePaths.shift(); return path ? { canceled: false, filePath: path } : { canceled: true } },
    }, manager, currentDirectory: () => '/library/current', getWindow: () => ({}),
    afterOperation: async () => { calls.push('reload') }, saveChecklist: async result => { checklists.push(result) },
  })
  async function click(label) { menu.template.submenu.find(item => item.label === label).click(); await menu.idle() }
  return { menu, click, messages, calls, checklists, openDialogs, saveDialogs }
}

test('desktop inspect requires confirmation and presents the checklist with an export choice', async () => {
  const result = { records: 1, originals: 0, issueCount: 1, issues: [{ severity: 'error', path: 'originals/id', message: '原文件缺失' }] }
  const f = fixture({ responses: [1, 1], manager: { inspect: async () => result } })
  await f.click('检查当前资料库…')
  assert.match(f.messages[0].detail, /请先保存编辑/)
  assert.match(f.messages[1].detail, /原文件缺失/)
  assert.deepEqual(f.calls, ['reload']); assert.deepEqual(f.checklists, [result])
})

test('cancelling restore does not stop tasks or write any library', async () => {
  let restores = 0
  const f = fixture({ paths: ['/backup'], responses: [0], manager: { restore: async () => { restores++ } } })
  await f.click('从目录备份恢复…')
  assert.equal(restores, 0); assert.deepEqual(f.calls, [])
})

test('restore uses only the native chosen path and explains the backup cutoff', async () => {
  let source
  const f = fixture({ paths: ['/backup'], responses: [1], manager: { restore: async path => { source = path; return { destination: '/new', previousBackup: '/safety' } } } })
  await f.click('从目录备份恢复…')
  assert.equal(source, '/backup'); assert.match(f.messages[0].detail, /不会合并/)
  assert.match(f.messages[1].detail, /\/safety/)
  assert.deepEqual(f.calls, ['reload'])
})

test('maintenance errors are visible and another menu action cannot interleave', async () => {
  const gate = Promise.withResolvers()
  let inspections = 0
  const f = fixture({ responses: [1], manager: { inspect: async () => { inspections++; await gate.promise; throw new Error('恢复失败但来源保留') } } })
  f.menu.template.submenu[0].click()
  await new Promise(resolve => setImmediate(resolve))
  f.menu.template.submenu[0].click()
  gate.resolve(); await f.menu.idle()
  assert.equal(inspections, 1)
  assert.match(f.messages.at(-1).message, /来源保留/)
  assert.deepEqual(f.calls, ['reload'])
})

test('desktop migration is explicit and shows the preserved source backup on success', async () => {
  let migrations = 0
  const f = fixture({ responses: [1], manager: { migrate: async () => { migrations++; return { destination: '/sqlite', backup: '/json-backup', records: 105 } } } })
  await f.click('升级当前 JSON 资料库…')
  assert.equal(migrations, 1)
  assert.match(f.messages[0].detail, /原 JSON 资料库保留/)
  assert.match(f.messages[1].detail, /\/json-backup/)
})

test('migration status can be viewed without resuming and continuation explains the snapshot cutoff', async () => {
  const status = { phase: 'records', completedRecords: 100, totalRecords: 105, completedFiles: 0, totalFiles: 2, snapshotCreatedAt: '2026-10-21T00:00:00Z', backup: '/backup', destination: '/target' }
  let resumed = 0
  const manager = { migrationStatus: async source => { assert.equal(source, '/partial'); return status }, resumeMigration: async () => { resumed++; return { destination: '/target', backup: '/backup', previousBackup: '/current-backup' } } }
  const view = fixture({ paths: ['/partial'], responses: [0], manager })
  await view.click('查看迁移进度或继续迁移…')
  assert.equal(resumed, 0); assert.deepEqual(view.calls, [])
  assert.match(view.messages[0].detail, /100\/105/)
  const resume = fixture({ paths: ['/partial'], responses: [1, 1], manager })
  await resume.click('查看迁移进度或继续迁移…')
  assert.equal(resumed, 1)
  assert.match(resume.messages[1].detail, /2026-10-21T00:00:00Z/)
  assert.match(resume.messages[1].detail, /不会合并/)
  assert.match(resume.messages[2].detail, /current-backup/)
})

test('ZIP export and restore use native file dialogs and preserve the snapshot cutoff explanation', async () => {
  let exported, restored
  const f = fixture({ savePaths: ['/chosen/backup.zip'], paths: ['/chosen/backup.zip'], responses: [1, 0, 1], manager: {
    backupZip: async destination => { exported = destination; return { destination } },
    restore: async (source, options) => { restored = { source, options }; return { destination: '/new', previousBackup: '/safety' } },
  } })
  await f.click('导出 ZIP 备份…')
  assert.equal(exported, '/chosen/backup.zip'); assert.deepEqual(f.saveDialogs[0].filters[0].extensions, ['zip'])
  await f.click('从 ZIP 备份恢复…')
  assert.deepEqual(restored, { source: '/chosen/backup.zip', options: { format: 'zip' } })
  assert.deepEqual(f.openDialogs[0].properties, ['openFile'])
  assert.match(f.messages[2].detail, /不会合并/); assert.match(f.messages[3].detail, /\/safety/)
  assert.deepEqual(f.calls, ['reload', 'reload'])
})

test('cancelling either ZIP dialog or confirmation performs no maintenance', async () => {
  for (const responses of [[], [0]]) {
    const f = fixture({ responses, ...(responses.length ? { paths: ['/backup.zip'], savePaths: ['/backup.zip'] } : {}), manager: {
      backupZip: () => assert.fail('cancelled export must not run'), restore: () => assert.fail('cancelled restore must not run'),
    } })
    await f.click('导出 ZIP 备份…'); await f.click('从 ZIP 备份恢复…')
    assert.deepEqual(f.calls, [])
  }
})

test('selective recovery previews versions, passes only chosen keys, and confirms preservation before applying', async () => {
  const plan = { revision: 'revision', snapshotCreatedAt: '2026-10-23', itemCount: 2, items: [
    { target: 'notes/a', type: 'record', choices: [{ key: 'selected-key', from: 'backup', savedAt: '2026-10-22', revision: 2 }] },
    { target: 'originals/b', type: 'original', choices: [{ key: 'skipped-key', from: 'backup', savedAt: '2026-10-22', revision: null }] },
  ] }
  let received
  const f = fixture({ paths: ['/backup'], responses: [1, 1, 1, 0, 1], manager: {
    recoveryPreview: async (source, options) => { assert.equal(source, '/backup'); assert.equal(options.format, 'directory'); return plan },
    recover: async (source, options) => { received = { source, options }; return { destination: '/new', preservation: '/preserved', restored: 1, remainingIssues: 1 } },
  } })
  await f.click('选择性恢复损坏资料…')
  assert.deepEqual(received, { source: '/backup', options: { format: 'directory', revision: 'revision', selections: ['selected-key'] } })
  assert.match(f.messages[4].detail, /未选的异常项目继续隔离/)
  assert.match(f.messages[5].detail, /\/preserved/); assert.equal(f.messages[5].type, 'warning')
  assert.deepEqual(f.calls, ['reload', 'reload'])
})

test('declining the final selective-recovery scope leaves all records intact', async () => {
  const plan = { revision: 'r', snapshotCreatedAt: '2026-10-23', itemCount: 1, items: [{ target: 'notes/a', choices: [{ key: 'key', from: 'backup', savedAt: '2026-10-22', revision: 1 }] }] }
  const f = fixture({ paths: ['/backup.zip'], responses: [2, 1, 1, 0], manager: {
    recoveryPreview: async (_source, options) => { assert.equal(options.format, 'zip'); return plan },
    recover: () => assert.fail('final cancellation must not apply recovery'),
  } })
  await f.click('选择性恢复损坏资料…')
  assert.deepEqual(f.openDialogs[0].properties, ['openFile']); assert.deepEqual(f.calls, ['reload'])
})

test('preparation rebuild explains the snapshot cutoff and preserves old partial work before switching', async () => {
  let source
  const f = fixture({ paths: ['/old-json-backup'], responses: [1], manager: { migrateFromBackup: async chosen => {
    source = chosen; return { destination: '/new-sqlite', backup: chosen, previousBackup: '/current-safety', snapshotCreatedAt: '2026-10-25' }
  } } })
  await f.click('从升级前备份重新准备迁移…')
  assert.equal(source, '/old-json-backup'); assert.match(f.messages[0].detail, /旧暂存目录完整保留/); assert.match(f.messages[0].detail, /不会合并/)
  assert.match(f.messages[1].detail, /current-safety/); assert.deepEqual(f.calls, ['reload'])
})
