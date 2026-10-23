const { contextBridge } = require('electron')
const argument = process.argv.find(value => value.startsWith('--classifier-session='))
const sessionId = argument ? argument.slice('--classifier-session='.length) : 'primary'
const libraryId = process.argv.find(value => value.startsWith('--classifier-library='))?.slice('--classifier-library='.length) || null
contextBridge.exposeInMainWorld('classifierDesktop', Object.freeze({ sessionId, libraryId, version: 1 }))
