import { utilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { maintenanceChannel } from './maintenance-channel.mjs'

export function runMaintenance(command, args, { onProgress = () => {} } = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('CLASSIFIER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key]
  const child = utilityProcess.fork(fileURLToPath(new URL('./maintenance-worker.mjs', import.meta.url)), [], { env, serviceName: 'Classifier Library Maintenance', stdio: 'pipe' })
  child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {})
  return maintenanceChannel(child, command, args, { onProgress })
}
