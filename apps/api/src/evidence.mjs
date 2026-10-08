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
