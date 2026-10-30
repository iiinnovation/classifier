import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseDocx } from '../../apps/api/src/docx.mjs'
import { clickControl } from './ui-actions.mjs'

// Same user-level export scenario runs in Chrome and the real desktop shell.
export async function reportExportScenario(page, info) {
  const setup = await page.evaluate(async () => {
    async function request(path, method = 'GET', body) {
      const response = await fetch(path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error)
      return value
    }
    const topic = await request('/api/topics', 'POST', { title: 'Word 导出验收', question: '这些研究发现在哪些条件下成立？' })
    const upload = new FormData()
    upload.append('file', new Blob(['# 合成研究\n\n研究发现：当前样本中的结果需要结合测量条件解释。']), 'export-source.md')
    upload.append('topicId', topic.id)
    const imported = await (await fetch('/api/documents', { method: 'POST', body: upload })).json()
    await request(`/api/documents/${imported.id}`, 'PATCH', { title: '合成研究资料', authors: '测试作者', year: '2026', venue: '合成验收期刊', doi: '10.1000/fixture' })
    const doc = await request(`/api/documents/${imported.id}`)
    const reference = doc.references.find(item => item.text.includes('研究发现：'))
    if (!reference) throw new Error('Synthetic research excerpt missing')
    const report = await request(`/api/topics/${topic.id}/reports`, 'POST', { title: '可继续编辑的中文研究总结', sources: [{ type: 'passages', documentId: doc.id, documentVersion: doc.evidenceVersion, referenceIds: [reference.id] }] })
    const assembled = await request(`/api/reports/${report.id}/assemble`, 'POST', { revision: report.revision })
    const saved = await request(`/api/reports/${report.id}`, 'PATCH', { revision: assembled.revision, blocks: assembled.blocks.map(({ id, section, kind, citationIds }) => ({ id, section, kind, citationIds, text: '只适用于当前样本。\n适用条件：测量条件相同；不直接合并数值。' })) })
    return { topicId: topic.id, title: topic.title, reportId: report.id, revision: saved.revision, excerpt: reference.text, documentId: doc.id }
  })
  await page.reload()
  await page.locator('#research-home').click()
  await page.locator('.topic-card').filter({ hasText: setup.title }).click()
  await page.locator('#topic-recent button').filter({ hasText: '可继续编辑的中文研究总结' }).click()
  await expect(page.locator('#report-export-word')).toBeEnabled()
  await expect(page.locator('#report-export')).not.toBeVisible()
  const downloading = page.waitForEvent('download')
  await page.locator('#report-export-word').click()
  const word = await downloading
  expect(word.suggestedFilename()).toBe('可继续编辑的中文研究总结.docx')
  const target = info.outputPath('saved-research.docx')
  await word.saveAs(target)
  const text = (await parseDocx(await readFile(target))).sections[0].text
  for (const expected of ['可继续编辑的中文研究总结', '只适用于当前样本。', '适用条件：测量条件相同', '测试作者', '合成验收期刊', '10.1000/fixture', setup.excerpt, setup.documentId]) expect(text).toContain(expected)
  await expect(page.locator('#app-message')).toContainText(`已导出版本 ${setup.revision} 的 Word 文档`)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('#report-export-word')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('word-export-narrow.png'), fullPage: true })
  await page.locator('#report-edit').click()
  await page.locator('.report-block-text').first().fill('未保存的新输入不得进入导出文件。')
  await page.locator('#report-editor-close').click()
  const savedDownload = page.waitForEvent('download')
  await page.locator('#report-export-word').click()
  const savedWord = await savedDownload
  const savedText = (await parseDocx(await readFile(await savedWord.path()))).sections[0].text
  expect(savedText).toContain('只适用于当前样本。'); expect(savedText).not.toContain('未保存的新输入')
  const markdownDownload = page.waitForEvent('download')
  await clickControl(page, '#report-export')
  const markdown = await markdownDownload
  expect(markdown.suggestedFilename()).toBe('可继续编辑的中文研究总结.md')
  expect(await readFile(await markdown.path(), 'utf8')).toContain('只适用于当前样本。')
  const unchanged = await page.evaluate(async id => (await (await fetch(`/api/reports/${id}`)).json()).revision, setup.reportId)
  expect(unchanged).toBe(setup.revision)
}
