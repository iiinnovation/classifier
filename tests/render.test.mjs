import test from 'node:test'
import assert from 'node:assert/strict'
import { pageImageInWorker } from '../apps/api/src/render.mjs'
import { openPdf, rasterPage } from '../apps/api/src/pdf.mjs'
import { textPdf } from './helpers/pdf-fixture.mjs'

test('page worker returns a complete PNG and reports invalid pages', async () => {
  const bytes = textPdf(1)
  const png = await pageImageInWorker(bytes, 1)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.ok(png.length > 1000)
  await assert.rejects(pageImageInWorker(bytes, 2), /无效页码/)
})

test('page rendering cancellation terminates work without returning a stale image', async () => {
  const controller = new AbortController(), reason = new Error('test navigation changed')
  const rendering = pageImageInWorker(textPdf(1), 1, { signal: controller.signal })
  controller.abort(reason)
  await assert.rejects(rendering, error => error === reason)
})

test('reused PDF rasters contain only the new page and match an independent render', async () => {
  const task = openPdf(textPdf(2))
  try {
    const pdf = await task.promise
    const first = await rasterPage(await pdf.getPage(1))
    const context = first.getContext('2d')
    context.fillStyle = 'red'; context.fillRect(0, 0, first.width, first.height)
    const page = await pdf.getPage(2)
    const reused = await rasterPage(page, 2200, first)
    const independent = await rasterPage(page)
    assert.deepEqual(reused.toBuffer('image/png'), independent.toBuffer('image/png'))
  } finally { await task.destroy() }
})
