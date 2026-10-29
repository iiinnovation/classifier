import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, stat, statfs, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execute = promisify(execFile)
const capacity = 128 * 1024 ** 2

// Only this bounded, newly created image is filled. Never accept an arbitrary
// volume path or use the host's free-space limit as the fill target.
export async function withFullVolume(work) {
  if (process.platform !== 'darwin') throw new Error('The bounded APFS test requires macOS.')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'classifier-full-volume-')))
  const mount = join(root, 'mount'), image = join(root, 'bounded.dmg')
  let attached = false
  try {
    const host = await statfs(root)
    if (host.bavail * host.bsize < capacity * 4) throw new Error('Insufficient host space for the bounded test image.')
    await mkdir(mount)
    await execute('/usr/bin/hdiutil', ['create', '-size', '128m', '-fs', 'APFS', '-volname', 'ClassifierFullVolumeTest', '-nospotlight', image], { timeout: 60000 })
    const result = await execute('/usr/bin/hdiutil', ['attach', '-noautoopen', '-mountpoint', mount, image], { timeout: 60000 })
    attached = true
    const mounted = await stat(mount), parent = await stat(root), info = await statfs(mount)
    if (mounted.dev === parent.dev || info.blocks * info.bsize > capacity * 2 || !result.stdout.split('\n').some(line => line.trim().endsWith(mount))) throw new Error('Refusing to fill an unverified volume.')
    return await work({ root, mount, capacityBytes: info.blocks * info.bsize, device: mounted.dev, hostDevice: parent.dev, attachment: result.stdout.trim() })
  } finally {
    // If attach partially failed, detect a mounted device before touching the
    // parent. Never recursively remove an attached filesystem as cleanup.
    const mounted = await stat(mount).catch(() => null), parent = await stat(root)
    if (attached || mounted && mounted.dev !== parent.dev) {
      try { await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 60000 }) }
      catch (error) { throw new Error('Test volume could not be detached; retained at ' + root, { cause: error }) }
    }
    await rm(root, { recursive: true, force: true })
  }
}
