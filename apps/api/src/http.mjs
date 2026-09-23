export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, '文件过大，单次最多上传 25 MB。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req) {
  try {
    const value = JSON.parse((await readBody(req, 128 * 1024)).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '请求需要有效的 JSON 对象。')
  }
}

export async function readUpload(req) {
  if (!String(req.headers['content-type']).startsWith('multipart/form-data')) throw new HttpError(415, '请使用文件上传表单。')
  const bytes = await readBody(req)
  try {
    const request = new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes,
    })
    const form = await request.formData()
    const file = form.get('file')
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new Error()
    return { fileName: file.name, contentType: file.type, mode: form.get('mode') || 'auto', bytes: Buffer.from(await file.arrayBuffer()) }
  } catch { throw new HttpError(400, '缺少有效文件，请重新上传。') }
}

export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
