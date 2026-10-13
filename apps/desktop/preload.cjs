const { contextBridge } = require('electron')
const argument = process.argv.find(value => value.startsWith('--classifier-session='))
const sessionId = argument ? argument.slice('--classifier-session='.length) : 'primary'
contextBridge.exposeInMainWorld('classifierDesktop', Object.freeze({ sessionId, version: 1 }))
