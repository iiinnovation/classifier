import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/desktop-application.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { researchReply } from '../helpers/research-fixture.mjs'

test('real desktop connects a runtime model and completes a cited research task through utility backend', async ({ desktop }, testInfo) => {
  const requests = [], { page } = desktop
  const service = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()), input = JSON.parse(body.messages[1].content)
      requests.push({ input, authorization: req.headers.authorization, model: body.model })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(researchReply(input)) } }] }))
    } catch { res.writeHead(500); res.end('{}') }
  })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  try {
    await page.locator('#model-settings-open').click()
    await page.locator('#model-settings-url').fill('http://127.0.0.1:' + service.address().port + '/v1/chat/completions')
    await page.locator('#model-settings-model').fill('local-test-model')
    await page.locator('#model-settings-key').fill('desktop-test-secret-only')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('desktop-test-secret-only')
    expect(await page.evaluate(async () => (await (await fetch('/api/settings/text-model')).json()).hasKey)).toBe(true)
    await page.locator('#new-topic').click()
    await page.locator('#topic-name-input').fill('桌面 AI 研究')
    await page.locator('#topic-details > summary').click()
    await page.locator('#topic-question-input').fill('比较两篇资料的方法与结论')
    await page.locator('#topic-form button[type=submit]').click()
    await page.locator('#topic-import').click()
    await page.locator('#file').setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('研究方法：实验一比较两组材料。主要发现：当前条件下表现不同。') },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('研究方法：实验二使用不同样本。主要发现：测量设置影响结果。') },
    ])
    await expect(page.locator('#topic-documents .document-card')).toHaveCount(2)
    await expect(page.locator('#import-dialog')).not.toBeVisible()
    await expect(page.locator('#research-task-start')).toBeEnabled()
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    await expect(page.locator('#comparison-saved')).not.toBeVisible()
    await page.locator('#comparison-saved-toggle').click()
    await expect(page.locator('#comparison-saved')).toBeVisible()
    await page.getByRole('button', { name: '采用比较草稿', exact: true }).click()
    await expect(page.locator('#comparison-task-status')).toContainText('已采用')
    await page.locator('#comparison-to-report').click()
    await expect(page.locator('#report-body')).toContainText('研究总结草稿')
    await page.getByRole('button', { name: '采用研究总结', exact: true }).click()
    await expect(page.locator('#report-body .report-block')).toHaveCount(2)
    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.authorization === 'Bearer desktop-test-secret-only' && request.model === 'local-test-model')).toBe(true)
    const settings = await page.evaluate(async () => (await fetch('/api/settings/text-model')).text())
    expect(settings).not.toContain('desktop-test-secret-only')
    for (const name of await readdir(join(desktop.profile, 'data/runs'))) expect(await readFile(join(desktop.profile, 'data/runs', name), 'utf8')).not.toContain('desktop-test-secret-only')
    await page.screenshot({ path: testInfo.outputPath('desktop-research-completed.png'), fullPage: true })
    await page.locator('#model-settings-open').click()
    await expect(page.locator('#model-settings-key')).toHaveValue('')
    await clickControl(page, '#model-settings-clear')
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    expect(await page.evaluate(async () => (await (await fetch('/health')).json()).modelConfigured)).toBe(false)
    await expect(page.locator('#report-generate')).toBeDisabled()
    await expect(page.locator('#report-body')).toContainText('所选研究的方法与条件不同')
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) }
})
