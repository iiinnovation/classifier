import assert from 'node:assert/strict'
import { decodeRecord } from '../../apps/api/src/record-integrity.mjs'

const id = 'ea0216d9-7938-4317-9e24-86cae9d940b0', count = 750000
const bytes = '{"id":"' + id + '","createdAt":"2026-10-26T00:00:00.000Z","sections":[],"references":[],"warnings":[' + '"kept",'.repeat(count - 1) + '"kept"]}'
const record = decodeRecord('documents', id, bytes)
assert.equal(record.warnings.length, count)
assert.equal(record.warnings[0], 'kept'); assert.equal(record.warnings.at(-1), 'kept')
console.log(JSON.stringify({ count, recordBytes: Buffer.byteLength(bytes), passed: true }))
