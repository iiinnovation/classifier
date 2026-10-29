// Validate the containers and scalar types that saved-record consumers use.
// This is deliberately separate from create/edit business validation: optional
// legacy metadata and unknown extensions are retained, never filled or rewritten.
const list = item => ({ list: item })
const nullable = item => ({ nullable: item })
const text = names => Object.fromEntries(names.split(' ').map(name => [name, 'string']))
const common = {
  ...text('id createdAt updatedAt title fileName status'),
  topicId: nullable('uuid'), documentId: nullable('uuid'),
}
const evidence = {
  ...text('id documentTitle fileName'), documentId: 'uuid', documentVersion: nullable('string'),
  reference: 'reference', bibliography: 'bibliography',
}
const cell = {
  ...text('value status kind conditions comparability reason reviewState'), documentId: 'uuid', columnId: 'uuid',
  evidence: list('evidence'), noteSources: list('version'), origin: 'origin', citationIds: list('string'),
}
const analysis = {
  ...text('value conditions relation definitionHash reviewState'), columnId: 'uuid',
  evidence: list('evidence'), rows: list('row'), origin: 'origin', citationIds: list('string'),
}
const shapes = {
  documents: { ...common, mediaType: 'string', sections: list('section'), references: list('reference'), warnings: list('string'), bibliography: 'bibliography', source: nullable('object') },
  topics: { ...common, ...text('question scope'), documents: list('link') },
  notes: { ...common, documentId: 'uuid', ...text('field content kind reviewState'), evidence: list('evidence'), origin: 'origin', history: list('noteSnapshot') },
  comparisons: { ...common, topicId: 'uuid', question: 'string', documentIds: list('uuid'), columns: list('column'), cells: list('cell'), analyses: list('analysis'), history: list('comparisonSnapshot') },
  reports: { ...common, topicId: 'uuid', question: 'string', blocks: list('block'), sources: list('material'), evidence: list('evidence'), history: list('reportSnapshot') },
  runs: { ...common, ...text('purpose question comparisonId reportId'), events: list('object'), documentVersions: list('version'), baseNotes: list('version'), baseCells: list('row'), result: nullable('runResult') },
  imports: { ...common, mode: 'string', events: list('object'), progress: 'object' },
  section: { ...text('id title text'), blocks: list('parsedBlock') },
  parsedBlock: text('id type text'),
  reference: { ...text('id title text blockId section type'), page: nullable('number') },
  bibliography: text('authors year venue doi url'),
  link: { ...text('selection readingStatus relevance reason addedAt updatedAt'), documentId: 'uuid' },
  origin: text('type runId referenceId generatedKind originalContent sourceKey itemKey'),
  evidence,
  version: { title: 'string', id: 'uuid', version: nullable('string') },
  row: { ...text('value status digest'), documentId: 'uuid' },
  column: { ...text('name description'), id: 'uuid' },
  cell,
  analysis,
  block: { ...text('id section text kind reviewState'), citationIds: list('string'), origin: 'origin' },
  material: { ...text('key type title'), id: 'uuid', documentId: 'uuid', documentVersion: nullable('string'), documentIds: list('uuid'), documents: list('documentSummary'), evidence: list('evidence') },
  documentSummary: { ...common, bibliography: 'bibliography' },
  noteMaterial: { ...text('field text kind status reviewState'), citationIds: list('string') },
  comparisonMaterial: { question: 'string', columns: list('column'), cells: list('materialCell'), analyses: list('materialAnalysis') },
  materialCell: cell,
  materialAnalysis: analysis,
  passageMaterial: { referenceIds: list('string') },
  runResult: { references: list('reference'), readReferences: list('reference'), claims: list('claim'), evidence: list('evidence'), columns: list('column'), cells: list('cell'), analysis: 'analysis', analyses: list('analysis'), baseNotes: list('version'), blocks: list('block') },
  claim: { ...text('text kind'), referenceIds: list('string') },
}
// These arrays/locators were already emitted by the first M1–M4 producers.
// History entries are snapshots, not complete top-level records: in particular
// they do not need their own history array. Material documents are summaries.
shapes.noteSnapshot = { ...shapes.notes }; delete shapes.noteSnapshot.history
shapes.comparisonSnapshot = { ...shapes.comparisons }; delete shapes.comparisonSnapshot.history
shapes.reportSnapshot = { ...shapes.reports }; delete shapes.reportSnapshot.history
const required = {
  documents: ['sections', 'references'], topics: ['documents'],
  notes: ['documentId', 'content', 'evidence', 'history'], noteSnapshot: ['content', 'evidence'],
  comparisons: ['topicId', 'documentIds', 'columns', 'cells', 'analyses', 'history'],
  comparisonSnapshot: ['documentIds', 'columns', 'cells', 'analyses'],
  reports: ['topicId', 'blocks', 'sources', 'evidence', 'history'], reportSnapshot: ['blocks', 'sources', 'evidence'],
  section: ['text'], parsedBlock: ['text'], reference: ['id', 'text'], link: ['documentId'],
  evidence: ['documentId', 'reference'], column: ['id', 'name'], version: ['id'], row: ['documentId'], origin: ['type'],
  cell: ['documentId', 'columnId', 'value', 'evidence', 'noteSources', 'origin'],
  analysis: ['columnId', 'value', 'evidence', 'rows', 'origin'],
  block: ['id', 'section', 'text', 'kind', 'citationIds', 'origin'],
  material: ['key', 'type', 'documentIds', 'documents', 'evidence', 'content'], documentSummary: ['id'],
  noteMaterial: ['field', 'text', 'citationIds'], comparisonMaterial: ['columns', 'cells', 'analyses'], passageMaterial: ['referenceIds'],
  materialCell: ['documentId', 'columnId', 'value', 'citationIds', 'origin'], materialAnalysis: ['columnId', 'value', 'citationIds', 'origin'],
  claim: ['text', 'referenceIds'],
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateRecordShape(bucket, record) {
  // An explicit stack also avoids overflowing on a damaged deeply nested
  // history. JSON size limits are enforced by the caller before validation.
  const pending = [[record, bucket]]
  while (pending.length) {
    const next = pending.pop()
    if (next.comparison) {
      const { table, documentIds } = next.comparison, documents = new Set(documentIds), columns = new Set(table.columns.map(column => column.id))
      if (table.cells.some(cell => !documents.has(cell.documentId) || !columns.has(cell.columnId)) || table.analyses.some(analysis => !columns.has(analysis.columnId))) throw new Error('INVALID_COMPARISON_LOCATOR')
      // Analysis rows are saved inputs; changing the current scope deliberately
      // leaves them intact and marks the analysis stale in the presenter.
      continue
    }
    if (next.iterator) {
      const item = next.iterator.next()
      if (!item.done) pending.push(next, [item.value, next.rule])
      continue
    }
    const [value, rule] = next
    if (rule?.nullable) { if (value !== null) pending.push([value, rule.nullable]); continue }
    if (rule?.list) {
      if (!Array.isArray(value)) throw new Error('INVALID_RECORD_CONTAINER')
      // Keep only the current item and iterator, rather than duplicating a
      // potentially large persisted array into an equally large work queue.
      pending.push({ iterator: value.values(), rule: rule.list })
      continue
    }
    if (rule === 'string' || rule === 'number') {
      if (typeof value !== rule || rule === 'number' && !Number.isFinite(value)) throw new Error('INVALID_RECORD_FIELD')
      continue
    }
    if (rule === 'uuid') { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('INVALID_RECORD_ID'); continue }
    if (!object(value)) throw new Error('INVALID_RECORD_OBJECT')
    if (rule === 'object') continue
    if ((required[rule] || []).some(key => !Object.hasOwn(value, key))) throw new Error('MISSING_RECORD_FIELD')
    // Run relationship checks after the child shapes have been validated.
    if (rule === 'comparisons' || rule === 'comparisonSnapshot') pending.push({ comparison: { table: value, documentIds: value.documentIds } })
    for (const [key, child] of Object.entries(shapes[rule])) if (Object.hasOwn(value, key)) pending.push([value[key], child])
    if (rule === 'material') {
      if (!['note', 'comparison', 'passages'].includes(value.type) || !Object.hasOwn(value, value.type === 'passages' ? 'documentId' : 'id')) throw new Error('INVALID_MATERIAL_SOURCE')
      if (value.type === 'note') pending.push([value.content, list('noteMaterial')])
      else if (value.type === 'comparison') pending.push([value.content, 'comparisonMaterial'])
      else if (value.type === 'passages') pending.push([value.content, 'passageMaterial'])
    }
    if (rule === 'runs') {
      if (value.purpose === 'comparison-draft' && !Array.isArray(value.documentVersions)) throw new Error('MISSING_DOCUMENT_VERSIONS')
      if (value.status === 'completed') {
        const resultFields = { 'comparison-draft': ['columns', 'cells', 'analyses', 'baseNotes'], 'comparison-suggestion': ['cells', 'analysis'], 'report-suggestion': ['blocks', 'evidence'], 'note-suggestion': ['references'] }[value.purpose]
        if (resultFields && (!object(value.result) || resultFields.some(key => !Object.hasOwn(value.result, key)))) throw new Error('MISSING_TASK_RESULT')
      }
    }
  }
}
