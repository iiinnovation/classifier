import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const suite = process.argv[2] || 'all', args = process.argv.slice(3)
if (!['all', 'business', 'shell'].includes(suite)) throw new Error('Suite must be all, business or shell')
const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'))
for (const current of suite === 'all' ? ['business', 'shell'] : [suite]) {
  const command = ['test', ...(current === 'shell' ? ['--config=playwright.desktop.config.mjs'] : []), ...args]
  const child = spawn(process.execPath, [cli, ...command], { stdio: 'inherit', env: { ...process.env, ...(current === 'business' ? { CLASSIFIER_E2E_TRANSPORT: 'electron' } : {}) } })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  if (code) { process.exitCode = code; break }
}
