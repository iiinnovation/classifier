import { acquireDataLock } from '../../apps/api/src/data-lock.mjs'
const lock = await acquireDataLock(process.argv[2])
process.send({ type: 'locked' })
process.on('message', message => { if (message === 'release') { lock.release(); process.disconnect() } })
