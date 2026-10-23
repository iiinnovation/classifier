import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json } from './helpers/test-app.mjs'

async function setup(t) {
  const app = await reportFixture(); t.after(() => app.close())
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '综述文稿', sources: app.selectors }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  const { document, window } = parseHTML(await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'))
  // Linkedom supplies DOM/event behavior; modal state, form controls and select
  // values are browser APIs it does not implement. Layout stays in Playwright.
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true }; dialog.close = () => { dialog.open = false }
  }
  const form = document.getElementById('report-form')
  Object.defineProperty(form, 'elements', { get: () => form.querySelectorAll('input, textarea, select, button') })
  function selectValue(node) {
    Object.defineProperty(node, 'value', { configurable: true,
      get: () => [...node.children].find(option => option.hasAttribute('selected'))?.value || node.firstElementChild?.value || '',
      set: value => { for (const option of node.children) option.toggleAttribute('selected', option.value === value) },
    })
  }
  document.querySelectorAll('select').forEach(selectValue)
  const storage = {}
  Object.defineProperties(storage, {
    getItem: { value: key => storage[key] ?? null },
    setItem: { value: (key, value) => { storage[key] = String(value) } },
    removeItem: { value: key => { delete storage[key] } },
  })
  const create = new Function('document', 'crypto', (await readFile(new URL('../apps/web/reports.js', import.meta.url), 'utf8')).replace('export function', 'function') + '\nreturn createReportWorkspace')(document, webcrypto)
  let navigation = 0
  const notices = []
  const workspace = create({
    api: async (path, options) => {
      const response = await app.request(path, options), value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status })
      return value
    },
    element: (tag, text, className) => {
      const node = document.createElement(tag)
      if (text != null) node.textContent = text
      if (className) node.className = className
      if (tag === 'select') selectValue(node)
      return node
    },
    currentTopic: () => app.topic, enter: () => ++navigation, navigationKey: () => navigation,
    showTopic: async () => {}, openSource: async () => {}, modelConfigured: () => false,
    notice: message => notices.push(message), storage: { drafts: storage },
  })
  t.after(() => workspace.reset())
  await workspace.open(report.id)
  const $ = selector => document.querySelector(selector)
  const click = async label => {
    const node = [...document.querySelectorAll('button')].find(node => node.textContent === label)
    assert.ok(node, label); await node.onclick()
  }
  function fill(selector, value) { const node = $(selector); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })) }
  return { app, report, workspace, document, $, click, fill, storage, notices,
    save: () => form.onsubmit({ preventDefault() {} }),
  }
}

test('manuscript edits preserve citations and order across remove undo draft resume and save', async t => {
  const { app, report, workspace, $, document, click, fill, save, storage } = await setup(t)
  await $('#report-edit').onclick()
  assert.equal($('.report-paragraph-settings').hasAttribute('open'), false)
  assert.equal($('.report-writing-context').hasAttribute('open'), false)
  assert.match($('.report-selected-citations').textContent, /出处/)
  fill('.report-block-text', '新的综述段落，保留原有引用。')
  const first = $('.report-block-editor')
  await click('移除段落')
  assert.equal(document.querySelectorAll('.report-block-editor').length, 3)
  await click('撤销移除段落')
  assert.equal($('.report-block-editor'), first)
  const second = first.nextElementSibling
  await [...second.querySelectorAll('button')].find(node => node.textContent === '上移段落').onclick()
  await $('#report-editor-close').onclick()
  assert.equal(Object.keys(storage).length, 1)
  await workspace.open(report.id)
  await $('#report-resume').onclick()
  // resume dispatches an async handler; the content editor itself is synchronous.
  assert.equal($('.report-block-editor').dataset.blockId, report.blocks[1].id)
  assert.equal(document.querySelectorAll('.report-block-text')[1].value, '新的综述段落，保留原有引用。')
  await save()
  assert.equal($('#report-editor-error').textContent, '')
  const saved = await app.value('/api/reports/' + report.id)
  assert.equal(saved.blocks[1].text, '新的综述段落，保留原有引用。')
  assert.deepEqual(saved.blocks.map(block => block.id), [report.blocks[1].id, report.blocks[0].id, ...report.blocks.slice(2).map(block => block.id)])
  for (const block of saved.blocks) assert.deepEqual(block.citationIds, report.blocks.find(item => item.id === block.id).citationIds)
  assert.equal(Object.keys(storage).length, 0)
})

test('manuscript paragraph settings save reference changes and preserve drafts on version conflicts', async t => {
  const { app, report, $, document, click, fill, save, storage } = await setup(t)
  await $('#report-edit').onclick()
  await click('＋ 添加段落')
  const last = [...document.querySelectorAll('.report-block-editor')].at(-1)
  assert.equal(last.read().section, report.blocks.at(-1).section)
  const select = last.querySelector('select'); select.value = 'source'; select.onchange()
  const reference = last.querySelector('input[type=checkbox]'); reference.checked = true; reference.onchange()
  assert.match(last.querySelector('.report-paragraph-settings > summary').textContent, /原文报告 · 1 条引用/)
  fill('.report-block-editor:last-child textarea', '新增的原文报告。')
  await save()
  let saved = await app.value('/api/reports/' + report.id)
  assert.equal(saved.blocks.at(-1).kind, 'source')
  assert.deepEqual(saved.blocks.at(-1).citationIds, [reference.value])
  await $('#report-edit').onclick()
  fill('.report-block-text', '版本冲突时仍保留的修订。')
  await app.value('/api/reports/' + report.id, json('PATCH', { revision: saved.revision, title: '另一个窗口的标题' }))
  await save()
  assert.match($('#report-editor-error').textContent, /已被修改/)
  assert.equal($('#report-editor').open, true)
  assert.equal($('.report-block-text').value, '版本冲突时仍保留的修订。')
  assert.ok(Object.values(storage).some(value => value.includes('版本冲突时仍保留的修订')))
})

test('opening a cited source from the manuscript keeps unsaved writing recoverable', async t => {
  const { $, fill, click, storage } = await setup(t)
  await $('#report-edit').onclick()
  fill('.report-block-text', '回查原文之前尚未保存的论述。')
  await $('.report-selected-citations button').onclick()
  assert.equal($('#report-inspector').open, true)
  await click('打开原文位置')
  assert.equal($('#report-editor').open, false)
  assert.ok(Object.values(storage).some(value => value.includes('回查原文之前尚未保存的论述')))
  await $('#report-resume').onclick()
  assert.equal($('.report-block-text').value, '回查原文之前尚未保存的论述。')
})
