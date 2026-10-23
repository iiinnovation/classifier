// Resolve only after process exit: the caller can then reacquire directory
// ownership, including after launch timeout or a failed operation.
export function maintenanceChannel(child, command, args, { onProgress = () => {}, readyTimeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let result, failure, ready = false
    const timer = setTimeout(() => { failure = new Error('资料库维护进程启动超时。'); child.kill() }, readyTimeoutMs)
    child.on('message', data => {
      if (failure) return
      if (data?.type === 'ready' && !ready) { ready = true; clearTimeout(timer); child.postMessage({ command, ...args }) }
      else if (data?.type === 'progress') { try { onProgress(data.progress) } catch { /* UI failure must not interrupt migration. */ } }
      else if (data?.type === 'finished') child.kill()
      else if (typeof data?.ok === 'boolean') result = data
    })
    child.once('exit', () => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (result?.ok) resolve(result.result)
      else reject(new Error(result?.error || '资料库维护进程意外退出，来源资料及暂存副本仍保留。'))
    })
  })
}
