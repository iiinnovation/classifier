import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryMenu } from '../apps/desktop/library-menu.mjs'

function fixture({ responses = [], paths = [], manager = {} } = {}) {
  const messages = [], calls = [], checklists = []
  const menu = libraryMenu({
    dialog: {
      async showMessageBox(_window, options) { messages.push(options); return { response: responses.shift() ?? 0 } },
      async showOpenDialog() { const path = paths.shift(); return path ? { canceled: false, filePaths: [path] } : { canceled: true } },
    }, manager, currentDirectory: () => '/library/current', getWindow: () => ({}),
    afterOperation: async () => { calls.push('reload') }, saveChecklist: async result => { checklists.push(result) },
  })
  async function click(label) { menu.template.submenu.find(item => item.label === label).click(); await menu.idle() }
  return { menu, click, messages, calls, checklists }
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
