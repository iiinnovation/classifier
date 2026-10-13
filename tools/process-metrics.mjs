import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export async function processSnapshot() {
  if (process.platform === 'win32') {
    const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $items=Get-CimInstance Win32_Process; $out=@(); foreach($item in $items){ try { $p=Get-Process -Id $item.ProcessId -ErrorAction Stop; $out += [pscustomobject]@{pid=[int]$item.ProcessId;parent=[int]$item.ParentProcessId;rss=[double]$p.WorkingSet64;privateBytes=[double]$p.PrivateMemorySize64;name=$item.Name;ocrRecognition=($item.Name -match "tesseract" -and $item.CommandLine -match "tessedit_create_tsv=1")} } catch {} }; ConvertTo-Json -Compress -InputObject $out'
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(stdout)
  }
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 4 * 1024 * 1024 })
  const processes = stdout.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? { pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]) * 1024, name: match[4] } : null
  }).filter(Boolean)
  const ocr = processes.filter(item => /tesseract/i.test(item.name))
  if (ocr.length) {
    // Inspect only OCR commands and keep a boolean, never record command lines.
    const { stdout: commands } = await execute('/bin/ps', ['-p', ocr.map(item => item.pid).join(','), '-o', 'pid=,args=']).catch(error => {
      if (error.code === 1) return { stdout: '' } // OCR may exit between snapshots.
      throw error
    })
    const recognizing = new Set(commands.split('\n').filter(line => /tessedit_create_tsv=1/.test(line)).map(line => Number(line.trim().split(/\s+/)[0])))
    for (const item of ocr) item.ocrRecognition = recognizing.has(item.pid)
  }
  return processes
}
export async function processTree(root) {
  const all = await processSnapshot(), ids = new Set([root])
  let changed = true
  while (changed) { changed = false; for (const item of all) if (ids.has(item.parent) && !ids.has(item.pid)) { ids.add(item.pid); changed = true } }
  return all.filter(item => ids.has(item.pid))
}
export async function privateMemorySnapshot(root) {
  const tree = await processTree(root)
  if (process.platform === 'win32') return { method: 'PrivateMemorySize64', processes: tree.map(({ pid, privateBytes }) => ({ pid, bytes: privateBytes })) }
  if (process.platform !== 'darwin') return { method: 'not available', processes: [] }
  const processes = []
  for (const item of tree) {
    try {
      const { stdout } = await execute('/usr/bin/vmmap', ['-summary', String(item.pid)], { maxBuffer: 4 * 1024 * 1024 })
      const value = stdout.match(/^Physical footprint:\s+([\d.]+)([BKMG])?/m)
      processes.push({ pid: item.pid, bytes: value ? Number(value[1]) * ({ B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[value[2] || 'B']) : null })
    } catch (error) { processes.push({ pid: item.pid, bytes: null, unavailable: error.code || 'vmmap failed' }) }
  }
  return { method: 'vmmap physical footprint (distinct from RSS)', processes }
}
