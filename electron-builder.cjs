const fs = require('node:fs')
const path = require('node:path')

module.exports = {
  appId: 'org.iiinnovation.classifier',
  productName: 'Classifier',
  directories: { output: 'dist/desktop' },
  asar: true,
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  files: ['apps/api/src/**', 'apps/web/**', 'apps/desktop/**', 'package.json', 'LICENSE'],
  asarUnpack: ['**/*.node', 'node_modules/pdfjs-dist/wasm/**'],
  mac: { target: ['zip', 'dmg'], identity: null, category: 'public.app-category.productivity', extraResources: [{ from: 'resources/ocr/darwin-${arch}', to: 'ocr' }] },
  win: { target: ['zip', 'nsis'], extraResources: [{ from: 'resources/ocr/win32-${arch}', to: 'ocr' }] },
  beforePack: async context => {
    const arch = require('builder-util').Arch[context.arch]
    const manifest = path.join(context.packager.projectDir, 'resources', 'ocr', `${context.electronPlatformName}-${arch}`, 'manifest.json')
    if (!fs.existsSync(manifest)) throw new Error(`Prepare the target OCR runtime before packaging: ${manifest}`)
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (value.platform !== context.electronPlatformName || value.arch !== arch || !value.languages.includes('eng') || !value.languages.includes('chi_sim')) throw new Error('OCR manifest does not match the target')
    const { verifyOcrBundle } = await import(require('node:url').pathToFileURL(path.join(context.packager.projectDir, 'tools', 'verify-ocr.mjs')).href)
    await verifyOcrBundle(path.dirname(manifest))
  },
}
