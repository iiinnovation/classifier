// A test-only fault injector for custom protocols, which CDP page.route does
// not intercept. Production packages do not include this server or its hooks.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'

const escape = value => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const matches = (pattern, url) => pattern instanceof RegExp ? pattern.test(url) : new RegExp(`^${pattern.split('**').map(part => part.split('*').map(escape).join('[^/]*')).join('.*')}$`).test(url)

export async function createDesktopRouting() {
  const token = randomBytes(32).toString('hex'), pages = new Map(), active = new Set()
  async function capture(response) {
    const bytes = Buffer.from(await response.arrayBuffer()), headers = Object.fromEntries(response.headers)
    return { status: () => response.status, headers: () => headers, body: async () => bytes, json: async () => JSON.parse(bytes.toString()), text: async () => bytes.toString() }
  }
  async function processRequest(req, res) {
    if (req.headers['x-test-control'] !== token) { res.writeHead(401); res.end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString()), url = new URL(input.url)
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Unexpected test backend destination')
    const pageUrl = `app://classifier${url.pathname}${url.search}`
    const routes = pages.get(input.page)?.routes || []
    const matching = [...routes].reverse().find(route => matches(route.pattern, pageUrl) && route.remaining > 0)
    const body = input.body === null ? undefined : Buffer.from(input.body, 'base64')
    let result
    const forward = async (options = {}) => capture(await fetch(input.url, { method: input.method, headers: input.headers, body, ...options, redirect: 'manual' }))
    const route = {
      request: () => ({ url: () => pageUrl, method: () => input.method, headers: () => input.headers, postDataBuffer: () => body || null, postData: () => body?.toString() || null, postDataJSON: () => JSON.parse(body.toString()) }),
      fetch: forward,
      async fulfill(options = {}) {
        const base = options.response
        const headers = { ...base?.headers(), ...options.headers }
        if (options.contentType) headers['content-type'] = options.contentType
        if (options.json !== undefined) headers['content-type'] = 'application/json'
        const bytes = options.json !== undefined ? Buffer.from(JSON.stringify(options.json)) : options.body !== undefined ? Buffer.from(options.body) : base ? await base.body() : Buffer.alloc(0)
        result = { status: options.status ?? base?.status() ?? 200, headers, body: bytes.toString('base64') }
      },
      async continue(options) { await route.fulfill({ response: await forward(options) }) },
      async abort() { result = { aborted: true } },
    }
    if (matching) { matching.remaining--; await matching.handler(route) }
    else await route.continue()
    if (!result) throw new Error('Test route did not continue, fulfill or abort')
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)) }
  }
  const server = createServer((req, res) => {
    const task = processRequest(req, res).catch(error => { if (!res.destroyed) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) } })
    active.add(task); void task.finally(() => active.delete(task))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return {
    connection: { port: server.address().port, token },
    install(page, id) {
      const state = { routes: [] }; pages.set(id, state)
      page.route = async (pattern, handler, options) => { state.routes.push({ pattern, handler, remaining: options?.times ?? Infinity }) }
      page.unroute = async (pattern, handler) => { state.routes = state.routes.filter(route => route.pattern !== pattern || (handler && route.handler !== handler)) }
      page.unrouteAll = async options => { state.routes = []; if (options?.behavior === 'wait') await Promise.allSettled([...active]) }
      return page.addInitScript(id => {
        const original = globalThis.fetch.bind(globalThis)
        globalThis.fetch = (input, options = {}) => {
          const headers = new Headers(input instanceof Request ? input.headers : options.headers)
          headers.set('x-classifier-test-page', id)
          return original(input, { ...options, headers })
        }
      }, id)
    },
    async close() { pages.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
