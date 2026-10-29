import { createHash } from 'node:crypto'

// Bibliography is editable; only source and parsed content define an evidence version.
export function evidenceVersion(document) {
  return createHash('sha256').update(JSON.stringify({
    source: document.source || null, schemaVersion: document.schemaVersion || 1,
    sections: document.sections, references: document.references,
  })).digest('hex')
}

export function captureEvidence(document, references, version = evidenceVersion(document)) {
  return references.map(reference => ({
    documentId: document.id, documentVersion: version, fileName: document.fileName,
    documentTitle: document.title, reference: structuredClone(reference),
  }))
}

// Presentation state is computed from live sources, never written into saved
// evidence. Absence is not proof of deletion; read failures are not corruption.
export function evidenceStatus(item, current, version = current?.value ? evidenceVersion(current.value) : null) {
  const document = current?.value
  return { ...item, sourceState: current?.state || 'missing', matchesCurrent: Boolean(document && item.documentId?.toLowerCase() === document.id?.toLowerCase() && typeof item.documentVersion === 'string' && item.documentVersion === version) }
}

export function sourceStateText(state, noun = '原文') {
  return ({ deleted: `${noun}已删除`, missing: `${noun}缺失`, corrupt: `${noun}记录损坏`, unavailable: `${noun}暂时无法读取` })[state] || ''
}
