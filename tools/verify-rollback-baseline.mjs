// Verify a locally retained preview baseline against its recorded package and
// executed compatibility fixtures. This is not a signing/trust-chain check.
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(await readFile(process.argv[2] || resolve(root, 'docs/rollback-baseline.json'), 'utf8'))
function local(path) {
  assert.equal(typeof path, 'string'); assert.equal(isAbsolute(path), false)
  const result = resolve(root, path)
  assert.ok(result.startsWith(root + sep), 'baseline paths must remain inside the project')
  return result
}
async function hash(path) {
  const value = createHash('sha256')
  for await (const bytes of createReadStream(path)) value.update(bytes)
  return value.digest('hex')
}
assert.equal(registry.registryVersion, 1)
assert.equal(registry.status, 'preview-recovery-baseline')
assert.equal(registry.releaseApproved, false, 'this verifier only validates an unreleased preview baseline')
assert.equal(registry.actualCrossVersionPairsVerified, false, 'fixture results cannot certify actual binary version pairs')
assert.equal(await hash(local(registry.build.artifact)), registry.build.zipSha256, 'rollback ZIP does not match the registered build')
assert.equal(await hash(local(registry.build.asar)), registry.build.asarSha256, 'rollback ASAR does not match the registered build')
const evidencePath = local(registry.evidence)
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
assert.equal(evidence.build.zipSha256, registry.build.zipSha256)
assert.equal(evidence.build.appAsarSha256, registry.build.asarSha256)
const fixturePath = local(registry.compatibilityResults)
const fixtureHash = evidence.evidenceSha256?.[relative(dirname(evidencePath), fixturePath)]
assert.match(fixtureHash || '', /^[a-f0-9]{64}$/, 'compatibility results must be recorded in the validation manifest')
assert.equal(await hash(fixturePath), fixtureHash, 'compatibility results differ from the recorded evidence')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.packaged, true); assert.equal(fixture.futureVersionsAreFixtures, true)
assert.deepEqual(fixture.cases.map(value => value.name).sort(), ['json-directory-format', 'json-zip-format', 'sqlite-directory-format', 'sqlite-zip-format', 'sqlite-directory-record', 'sqlite-zip-database'].sort())
assert.ok(fixture.cases.every(value => value.passed && value.refusedBeforeTaskUpdates && value.recoveredSnapshotAndHistory && value.newerLibraryPreserved && value.unknownPathsPreserved && value.restoredLibraryEditableAfterRestart))
console.log(JSON.stringify({ baselineId: registry.baselineId, matchesRecordedArtifacts: true, compatibilityFixturesPassed: fixture.cases.length, releaseApproved: registry.releaseApproved, actualCrossVersionPairsVerified: registry.actualCrossVersionPairsVerified, note: 'Future formats are fixtures. Revalidate actual upgrade/downgrade binary pairs before release; this preview is not signed or notarized.' }, null, 2))
