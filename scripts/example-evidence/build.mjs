// #310 (map #238): remakes the evidence the bundled `kiwi-cover-mutual` example carries for the AI interview: its Source document pack
// (sources/), a decisions log for each Stage (interview/) and one Reviewed copy (reviews/) whose comments the logs show answered. Every
// name, figure and date is fictitious.
//
//   node scripts/example-evidence/build.mjs
//
// Run it after changing the example's Modules: the logs record a fingerprint of each Field a Field was drafted from, and the Reviewed copy
// is a render of the Full SOAP (tests/exampleEvidence.test.js fails when either has drifted). The citations in the Modules are written by
// hand and are checked there too. The binary files are made afresh each time, so expect them to show as changed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localFilesystemStorage } from '../../lib/storage.js'
import { createInstanceSourceStore } from '../../lib/sourceDocuments.js'
import { extractSourceTextOnServer } from '../../lib/sourceExtractNode.js'
import { stringifyReviewManifest } from '../../web/lib/reviewManifest.js'
import { clientBriefPdf, claimScreenPng, requirementsRegisterXlsx, workshopNotesDocx } from './pack.mjs'
import { buildReviewedCopy, writeReviewedCopy } from './review.mjs'
import { buildDecisionsLogs } from './logs.mjs'

export const WORKSPACE_DIR = 'workspaces/examples'
export const SLUG = 'kiwi-cover-mutual'
export const INSTANCE_DIR = join(WORKSPACE_DIR, SLUG)
export const UPLOADER = 'p.natarajan'

/** The pack, in the order it came in. `at` is when the story says it did. */
export const PACK = [
  { filename: 'Client brief.pdf', title: 'Client brief', at: '2026-03-09T09:12:00.000Z', build: clientBriefPdf },
  { filename: 'Requirements register.xlsx', title: 'Requirements register', at: '2026-03-09T09:15:00.000Z', build: requirementsRegisterXlsx },
  { filename: 'Design workshop notes.docx', title: 'Design workshop notes', at: '2026-03-16T16:40:00.000Z', build: workshopNotesDocx },
  { filename: 'Claim registration screen.png', title: 'Claim registration screen', at: '2026-03-16T16:44:00.000Z', build: claimScreenPng },
]

async function buildSources() {
  rmSync(join(INSTANCE_DIR, 'sources'), { recursive: true, force: true })
  let clock = ''
  const store = createInstanceSourceStore(localFilesystemStorage, WORKSPACE_DIR, SLUG, { now: () => clock })
  for (const item of PACK) {
    const bytes = await item.build()
    const { text } = await extractSourceTextOnServer(item.filename, bytes)
    clock = item.at
    await store.upload({ filename: item.filename, bytes, text: text ?? undefined, title: item.title, uploadedBy: UPLOADER })
  }
  const { entries } = await store.list()
  const texts = {}
  for (const entry of entries) if (entry.text) texts[entry.id] = await store.readText(entry.id)
  return { entries, texts }
}

const sources = await buildSources()
console.log(`sources: ${sources.entries.map((e) => `${e.id} (${e.size} bytes${e.text ? ', with text' : ''})`).join(', ')}`)

const reviewed = await buildReviewedCopy({ instanceDir: INSTANCE_DIR, slug: SLUG })
console.log(`reviewed copy: ${reviewed.name} (${reviewed.bytes.length} bytes, ${reviewed.read.threads.length} threads, ${reviewed.read.changes.length} tracked change)`)

const logs = buildDecisionsLogs({ instancesDir: WORKSPACE_DIR, slug: SLUG, sources, reviewed })
rmSync(join(INSTANCE_DIR, 'interview'), { recursive: true, force: true })
mkdirSync(join(INSTANCE_DIR, 'interview'), { recursive: true })
for (const [stageId, yaml] of Object.entries(logs)) writeFileSync(join(INSTANCE_DIR, 'interview', `${stageId}.yaml`), yaml)
console.log(`decisions logs: ${Object.keys(logs).join(', ')}`)

// Four threads were brought in and all four answered in the Shape log.
const entry = writeReviewedCopy(INSTANCE_DIR, reviewed, reviewed.read.threads.length)
writeFileSync(join(INSTANCE_DIR, 'reviews', 'manifest.yaml'), stringifyReviewManifest([entry]))
console.log('reviews/manifest.yaml written')
