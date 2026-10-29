import fs from 'node:fs/promises'
import { basename } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const [source, backup, destination, preservation, selectionFile] = process.argv.slice(2), rename = fs.rename
fs.rename = async (from, to) => {
  if (basename(to) === 'crash-target') process.kill(process.pid, 'SIGKILL')
  return rename(from, to)
}
syncBuiltinESMExports()
const { recoverLibrary } = await import('../../apps/api/src/library-recovery.mjs')
const selection = JSON.parse(await fs.readFile(selectionFile, 'utf8'))
await recoverLibrary(source, backup, destination, preservation, selection)
