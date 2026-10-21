import assert from 'node:assert/strict'
import { join } from 'node:path'

// The same assertions run in Node child processes and packaged Electron utility
// processes. A checkpoint means the parent kills the live process, not a throw.
export async function storageScenarios(root, run, stop) {
  const cases = [], runtimes = []
  async function execute(folder, action, options) {
    const response = await run(join(root, folder), action, options)
    if (response.runtime) runtimes.push(response.runtime)
    return response
  }
  const state = async (folder, action = 'inspect') => (await execute(folder, action)).result
  function preserved(value, originalSnapshots) {
    assert.equal(value.integrity, 'ok')
    assert.equal(value.journalMode, 'wal')
    assert.equal(value.sharedOriginalExists, true)
    assert.deepEqual(value.snapshots, originalSnapshots)
    for (const topic of value.topics) assert.ok(topic.documentIds.includes('shared-2'))
  }
  function deleted(value) {
    assert.equal(value.document.status, 'deleted')
    assert.equal(value.originalExists, false)
    assert.equal(value.document.references, undefined)
    assert.ok(value.topics.every(topic => !topic.documentIds.includes('document-1')))
    assert.equal(value.task.status, 'cancelled')
    assert.equal(value.operationCount, 1)
    assert.equal(value.fileOperations.length, 1)
    assert.equal(value.fileOperations[0].state, 'done')
    assert.equal(value.fileOperations[0].error, null)
  }
  for (const checkpoint of ['before-commit', 'after-commit', 'before-unlink', 'after-unlink']) {
    const initial = await state(checkpoint, 'seed')
    const crash = await execute(checkpoint, 'delete', { checkpoint })
    assert.equal(crash.checkpoint, checkpoint)
    assert.equal(crash.killed, true)
    let current = await state(checkpoint)
    preserved(current, initial.snapshots)
    if (checkpoint === 'before-commit') {
      assert.deepEqual(current, initial)
      current = await state(checkpoint, 'delete')
    } else {
      assert.equal(current.document.status, 'deleted')
      assert.equal(current.originalExists, checkpoint !== 'after-unlink')
      assert.equal(current.fileOperations[0].state, 'pending')
      current = await state(checkpoint, 'recover')
    }
    deleted(current); preserved(current, initial.snapshots)
    assert.deepEqual(await state(checkpoint, 'recover'), current)
    assert.deepEqual(await state(checkpoint, 'delete'), current)
    cases.push({ name: checkpoint, passed: true, forcedExit: true, idempotentRecovery: true })
  }
  const fullInitial = await state('database-full', 'seed')
  const full = await state('database-full', 'full')
  assert.match(full.error.message, /full/i)
  assert.deepEqual(full.state, fullInitial)
  deleted(await state('database-full', 'delete'))
  cases.push({ name: 'database-full', passed: true, injection: 'SQLite max_page_count produces a real SQLITE_FULL write error', error: full.error })

  const fileInitial = await state('file-permission', 'seed')
  const failed = await state('file-permission', 'file-error')
  assert.equal(failed.document.status, 'deleted')
  assert.equal(failed.originalExists, true)
  assert.equal(failed.fileOperations[0].state, 'pending')
  assert.equal(failed.fileOperations[0].error, 'EACCES')
  preserved(failed, fileInitial.snapshots)
  const recovered = await state('file-permission', 'recover')
  deleted(recovered); preserved(recovered, fileInitial.snapshots)
  cases.push({ name: 'file-permission', passed: true, injection: 'Explicit EACCES fault at unlink boundary', retryCompleted: true })

  await state('contention', 'seed')
  const held = await execute('contention', 'hold', { checkpoint: 'locked', hold: true })
  try { assert.equal((await state('contention', 'contend')).blocked, true) }
  finally { await stop(held.handle) }
  assert.equal((await state('contention', 'contend')).blocked, false)
  deleted(await state('contention', 'delete'))
  cases.push({ name: 'second-process-contention', passed: true, releasedAfterForcedExit: true })

  await state('backup', 'seed')
  const backup = await state('backup', 'backup')
  assert.equal(backup.restored, true)
  assert.equal(backup.liveDeleted, true)
  assert.equal(backup.files, 2)
  cases.push({ name: 'consistent-backup-restore', passed: true, method: 'Quiesced writers + VACUUM INTO + SHA-256 originals manifest', independentRestore: true })
  const unique = [...new Map(runtimes.map(value => [JSON.stringify(value), value])).values()]
  assert.equal(unique.length, 1)
  return { cases, runtime: unique[0], allPassed: true, limitations: ['Process termination is tested; power-loss durability is not.', 'The prototype coordinates fixture records; live import/model cancellation remains D1/D2 integration work.', 'Backup assumes exclusive ownership and quiesced file writers; production barrier, archive validation and restore activation remain D1 work.'] }
}
