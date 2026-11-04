// Source documents, decisions logs and Reviewed copies — what the AI interview adds to an Instance, read and written by an outside
// agent exactly as the web UI does (docs/adr/0067, which keeps ADR-0043's rule that the MCP server does everything the web UI can).
// Ticket #305. Every tool here is a thin call to a `gantry serve` route; the rules (25 MB, one commit on the current stage's branch,
// the `gantry-*` check for a Reviewed copy, the extractors) live there, so a browser and an agent cannot drift apart.

import { z } from 'zod'
import { resolveInstanceWorkspace } from '../gantryClient.js'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

// Same shape as the other tool clusters: resolves the instance's workspace id (for credential attachment) from whichever of
// slug/scope/ref the caller supplied. Returns `{ workspaceId, scope }`, or `{ errorResult }`.
async function resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient }) {
  if (!slug && !ref) {
    return { errorResult: errorResult('Provide "slug" or "ref" to identify the instance.') }
  }
  const res = await resolveInstanceWorkspace({ gantryClient, slug, scope, ref })
  if (!res.ok) return { errorResult: upstreamErrorResult(res) }
  return { workspaceId: res.body?.workspaceId, scope: res.body?.scope }
}

const slugRefShape = {
  slug: z.string().optional().describe('The instance slug. Provide this or "ref".'),
  scope: z.string().optional().describe('The opaque workspace-scope token GET /api/instance/workspace or a prior instance lookup returned. Pins the lookup to one workspace when a bare slug is ambiguous.'),
  ref: z.string().optional().describe('The instance\'s numeric reference (e.g. "w1i2"), as an alternative to "slug".'),
}

// Calls one gantry serve route for the instance and hands back `{ res }` to read, or `{ result }` — a tool result already shaped for
// return — when the instance could not be resolved, a credential is missing or gantry serve refused.
async function callInstanceRoute(args, { gantryClient }, { path, method, query, body }) {
  const { slug, scope, ref } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return { result: resolved.errorResult }
  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path,
    method,
    query: { slug, scope: scope ?? resolved.scope, ref, ...query },
    body,
  })
  if (res.credentialError) return { result: credentialErrorResult(res.credentialError) }
  if (!res.ok) return { result: upstreamErrorResult(res) }
  return { res }
}

// A caller may paste a "data:...;base64," URL; either way the bytes are decoded and re-encoded, so a malformed string fails here rather
// than as a confusing upstream error.
function cleanBase64(contentBase64) {
  const cleaned = String(contentBase64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  const bytes = Buffer.from(cleaned, 'base64')
  if (bytes.length === 0) return null
  return bytes.toString('base64')
}

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

async function listSourceDocuments(args, context) {
  const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/sources' })
  if (result) return result
  if (!Array.isArray(res.body?.entries)) return errorResult('gantry serve returned an unexpected shape listing Source documents', res.body)
  const byId = new Map(res.body.entries.map((entry) => [entry.id, entry]))
  // "replacedBy" is worked out here from the newer document's "replaces", so an agent sees at a glance which documents are superseded.
  const replacedBy = new Map()
  for (const entry of res.body.entries) {
    if (entry.replaces && byId.has(entry.replaces)) replacedBy.set(entry.replaces, entry.id)
  }
  const documents = res.body.entries.map((entry) => ({
    ...entry,
    removed: Boolean(entry.removedAt),
    hasText: Boolean(entry.text),
    ...(replacedBy.has(entry.id) ? { replacedBy: replacedBy.get(entry.id) } : {}),
  }))
  return okResult({ documents, totalBytes: res.body.totalBytes, warning: res.body.warning, limits: res.body.limits })
}

async function readSourceDocument(args, context) {
  const { id, page } = args
  if (!id) return errorResult('Provide "id" — a Source document id from list_source_documents.')
  const { res, result } = await callInstanceRoute(args, context, {
    path: `/api/instance/sources/${encodeURIComponent(id)}/content`,
    query: { page },
  })
  if (result) return result
  // A picture is handed over as a picture, so the agent's own model can look at it.
  if (res.body?.image?.dataBase64) {
    const { image, ...meta } = res.body
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ...meta, note: 'The picture follows. Gantry reads no text from a picture, so describe what you see only as far as it is on the page.' }, null, 2) },
        { type: 'image', data: image.dataBase64, mimeType: image.mimeType },
      ],
    }
  }
  return okResult(res.body)
}

async function uploadSourceDocument(args, context) {
  const { filename, contentBase64, title, uploadedBy, replaces } = args
  if (!filename) return errorResult('Provide "filename" for the Source document being uploaded.')
  if (!contentBase64) return errorResult('Provide "contentBase64" — the document\'s bytes, base64-encoded.')
  let dataBase64
  try {
    dataBase64 = cleanBase64(contentBase64)
  } catch {
    return errorResult('"contentBase64" is not valid base64.')
  }
  if (!dataBase64) return errorResult('"contentBase64" is empty or is not valid base64.')
  const { res, result } = await callInstanceRoute(args, context, {
    path: '/api/instance/sources',
    method: 'POST',
    body: {
      filename,
      dataBase64,
      // No browser here to read the document, so gantry serve runs the same extractors on it.
      extractText: true,
      ...(title !== undefined ? { title } : {}),
      ...(uploadedBy !== undefined ? { uploadedBy } : {}),
      ...(replaces !== undefined ? { replaces } : {}),
    },
  })
  if (result) return result
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// Source documents from a web address (#318, docs/adr/0071)
// ---------------------------------------------------------------------------

// Whether gantry serve offers adding by address (its operator's GANTRY_SOURCE_FETCH_DISABLED off switch), asked once per gantry client
// and kept briefly, like the workspace classification, so a burst of MCP requests asks once. Anything but a clear "on" leaves the tools
// out: a server that can't say has nothing to fetch with.
const FETCH_STATUS_TTL_MS = 30_000
const fetchStatusCache = new WeakMap()

export async function sourceFetchOffered({ gantryClient }) {
  const cached = fetchStatusCache.get(gantryClient)
  if (cached && Date.now() - cached.at < FETCH_STATUS_TTL_MS) return cached.enabled
  let enabled = false
  try {
    const res = await gantryClient.request({ path: '/api/sources/fetch' })
    enabled = res.ok && res.body?.enabled === true
  } catch {
    enabled = false
  }
  fetchStatusCache.set(gantryClient, { at: Date.now(), enabled })
  return enabled
}

// gantry serve fetches the address (every redirect hop checked, 25 MB, the same types); nothing is stored by this call. `{ fetched }` or
// `{ result }` — a refusal already shaped for return, carrying gantry serve's own sentence for what to do.
async function fetchAddress(address, { gantryClient }) {
  const res = await gantryClient.request({ path: '/api/sources/fetch', method: 'POST', body: { address } })
  if (!res.ok) return { result: errorResult(res.body?.error ?? `gantry serve responded ${res.status}`, { status: res.status, code: res.body?.code }) }
  if (typeof res.body?.dataBase64 !== 'string') return { result: errorResult('gantry serve returned an unexpected shape fetching that address', res.body) }
  return { fetched: res.body }
}

const originOf = (fetched) => ({ address: fetched.address, finalAddress: fetched.finalAddress, fetchedAt: fetched.fetchedAt })

async function addSourceDocumentFromAddress(args, context) {
  const { address, title, uploadedBy, replaces, slug, ref } = args
  if (!slug && !ref) return errorResult('Provide "slug" or "ref" to identify the instance.')
  if (!address) return errorResult('Provide "address" — the web address of the page or document, starting https://.')
  const { fetched, result: refused } = await fetchAddress(address, context)
  if (refused) return refused
  const { res, result } = await callInstanceRoute(args, context, {
    path: '/api/instance/sources',
    method: 'POST',
    body: {
      filename: fetched.filename,
      dataBase64: fetched.dataBase64,
      // As for an upload: gantry serve reads the text with the browser's own extractors (an HTML page with Pandoc).
      extractText: true,
      title: title ?? fetched.title,
      origin: originOf(fetched),
      ...(uploadedBy !== undefined ? { uploadedBy } : {}),
      ...(replaces !== undefined ? { replaces } : {}),
    },
  })
  if (result) return result
  return okResult(res.body)
}

async function fetchSourceDocumentAgain(args, context) {
  const { id, uploadedBy, slug, ref } = args
  if (!slug && !ref) return errorResult('Provide "slug" or "ref" to identify the instance.')
  if (!id) return errorResult('Provide "id" — a Source document id from list_source_documents.')
  const { res: listed, result: listRefused } = await callInstanceRoute(args, context, { path: '/api/instance/sources' })
  if (listRefused) return listRefused
  const entry = (listed.body?.entries ?? []).find((candidate) => candidate.id === id)
  if (!entry) return errorResult(`No Source document "${id}" in this instance.`)
  if (entry.removedAt) return errorResult(`"${entry.title}" has been removed.`)
  if (!entry.origin?.address) return errorResult(`"${entry.title}" was uploaded, not fetched from a web address, so there is nothing to fetch again.`)
  // As in the panel: only the newest copy is fetched again, so one page keeps one line of replacements. Asked before fetching, so a refused
  // call costs no fetch; gantry serve's fetch-again route refuses it too (web/lib/sourceDocuments.js fetchAgainRefusal), whoever calls it.
  const newer = (listed.body?.entries ?? []).filter((candidate) => candidate.replaces === id).sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))[0]
  if (newer) {
    return errorResult(`"${entry.title}" (${entry.id}) has already been replaced by "${newer.title}" (${newer.id}). Fetch again the newest copy instead, so the page keeps one line of replacements.`, { code: 'replaced' })
  }
  const { fetched, result: refused } = await fetchAddress(entry.origin.address, context)
  if (refused) return refused
  const { res, result } = await callInstanceRoute(args, context, {
    path: `/api/instance/sources/${encodeURIComponent(id)}/fetch-again`,
    method: 'POST',
    body: { filename: fetched.filename, dataBase64: fetched.dataBase64, extractText: true, origin: originOf(fetched), ...(uploadedBy !== undefined ? { uploadedBy } : {}) },
  })
  if (result) return result
  if (res.body?.unchanged) return okResult({ ...res.body, note: `Unchanged since ${entry.origin.fetchedAt}: nothing was added and no Field is flagged.` })
  return okResult({ ...res.body, note: `The page changed since ${entry.origin.fetchedAt}. The new copy was added as "${res.body?.entry?.id}", which replaces "${id}"; the Fields that drew on "${id}" are now flagged Out of date (see get_instance).` })
}

// ---------------------------------------------------------------------------
// Decisions logs
// ---------------------------------------------------------------------------

async function readDecisionsLog(args, context) {
  const { stage, allStages } = args
  if (!allStages) {
    const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/decisions', query: { stage } })
    if (result) return result
    return okResult(res.body)
  }
  // Every Stage's log: the Stage ids come from the instance itself.
  const { res: instanceRes, result: instanceResult } = await callInstanceRoute(args, context, { path: '/api/instance' })
  if (instanceResult) return instanceResult
  const stages = Array.isArray(instanceRes.body?.stages) ? instanceRes.body.stages : []
  const logs = []
  for (const candidate of stages) {
    const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/decisions', query: { stage: candidate.id } })
    if (result) return result
    logs.push({ stage: candidate.id, title: candidate.title, log: res.body?.log })
  }
  return okResult({ logs })
}

// ---------------------------------------------------------------------------
// Reviewed copies
// ---------------------------------------------------------------------------

async function listReviewedCopies(args, context) {
  const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/reviews' })
  if (result) return result
  if (!Array.isArray(res.body?.reviews)) return errorResult('gantry serve returned an unexpected shape listing Reviewed copies', res.body)
  return okResult({ reviewedCopies: res.body.reviews })
}

async function readReviewedCopy(args, context) {
  const { id } = args
  if (!id) return errorResult('Provide "id" — a Reviewed copy id from list_reviewed_copies.')
  const { res, result } = await callInstanceRoute(args, context, { path: `/api/instance/reviews/${encodeURIComponent(id)}` })
  if (result) return result
  return okResult(res.body)
}

async function uploadReviewedCopy(args, context) {
  const { files } = args
  if (!Array.isArray(files) || files.length === 0) return errorResult('Provide "files" — at least one { filename, contentBase64 } Reviewed copy (.docx).')
  const sent = []
  for (const file of files) {
    if (!file?.filename || !file?.contentBase64) return errorResult('Every entry in "files" needs a "filename" and "contentBase64".')
    let dataBase64
    try {
      dataBase64 = cleanBase64(file.contentBase64)
    } catch {
      dataBase64 = null
    }
    if (!dataBase64) return errorResult(`"contentBase64" for "${file.filename}" is empty or is not valid base64.`)
    sent.push({ filename: file.filename, dataBase64 })
  }
  const { res, result } = await callInstanceRoute(args, context, { path: '/api/instance/reviews', method: 'POST', body: { files: sent } })
  if (result) return result
  return okResult({ reviewedCopies: res.body?.reviews ?? [] })
}

export const tools = [
  {
    name: 'list_source_documents',
    description:
      '1. Lists an instance\'s Source documents — the evidence (client briefs, standards, spreadsheets, PDFs, pictures) the architect uploaded for the AI interview to draw on. Read them before you draft, so a figure or a name comes from a document and not from you. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Each document carries its "id" (cite it in content as [Title, p. 4](source:<id>)), "title", "filename", "size", "uploadedBy", "uploadedAt" and "hasText" (false for a picture and for a scanned PDF). One added from a web address also carries its "origin": { address, finalAddress, fetchedAt }. A document a newer one replaces carries "replacedBy"; the newer one carries "replaces". The older one stays citable. A "removed" document is kept in the list so a citation of it still shows its title, but it can no longer be read. ' +
      '4. Also returns "totalBytes", a "warning" once the live documents are past about 100 MB, and the "limits" (25 MB per document). ' +
      '5. Works on server, Azure DevOps and GitHub workspaces; a local workspace\'s files are on the architect\'s computer and are not reachable here. GitLab and Atlassian workspaces take Source documents later.',
    inputSchema: { ...slugRefShape },
    handler: listSourceDocuments,
  },
  {
    name: 'read_source_document',
    description:
      '1. Reads one Source document\'s committed extracted text — exactly the text Gantry\'s own AI reads — one page at a time. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "id" is required (from list_source_documents). ' +
      '3. "page" counts from 1 (default 1). A PDF\'s pages are its own, so "page 4" is page 4 of the PDF — cite it as [Title, p. 4](source:<id>). Any other document is cut into sections of about 20,000 characters. The response carries "page", "pageCount" and "by" ("pdf-page" or "section"): keep calling with the next "page" until you have read "pageCount" pages. ' +
      '4. A picture comes back as a picture (an image block after the JSON). A document with no text (a scanned PDF, an unreadable file) comes back with "text": null and a "note" saying why; ask the architect about it rather than guessing. ' +
      '5. A removed document is refused (409); its title stays in list_source_documents.',
    inputSchema: {
      ...slugRefShape,
      id: z.string().describe('The Source document id, from list_source_documents.'),
      page: z.number().int().positive().optional().describe('Which page to read, from 1. Defaults to 1.'),
    },
    handler: readSourceDocument,
  },
  {
    name: 'upload_source_document',
    description:
      '1. Uploads a Source document to an instance, under the same rules as the web app: a Word (.docx), PowerPoint (.pptx), spreadsheet (.xlsx, .csv, .tsv), PDF, Markdown or text file, or a picture (.png, .jpg, .gif, .webp), at most 25 MB. Any other type is refused with the reason. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "filename" and "contentBase64" (the file\'s bytes, base64-encoded) are required. ' +
      '3. gantry serve reads the text out of the document with the same extractors the browser uses, so the manifest entry and the extracted text are what a browser upload of the same file would produce. The response carries the "entry" (with its "id") and "extraction": { read, note } — "read": false says why there is no text (a picture, a scanned PDF, an unreadable file). The document is kept either way. ' +
      '4. "replaces" is the id of an older Source document this one supersedes: the older one stays, citable and marked "replaced by", and the Fields that drew on it are flagged Out of date (see get_instance). Leave it out for an additional document. "title" defaults to the file name; "uploadedBy" is optional. ' +
      '5. On an Azure DevOps or GitHub workspace this is one commit on the current stage\'s branch, never part of a stage Save; on a server workspace it is written to the instance\'s sources folder. A local workspace cannot be reached. ' +
      '6. This is a real write — treat it as final once called.',
    inputSchema: {
      ...slugRefShape,
      filename: z.string().min(1).describe('The file name including its extension, e.g. "Client brief.docx".'),
      contentBase64: z.string().min(1).describe('The document\'s raw bytes, base64-encoded. A "data:...;base64," prefix is stripped if present.'),
      title: z.string().optional().describe('Display title; defaults to the file name without its extension.'),
      uploadedBy: z.string().optional().describe('Who is uploading it, recorded in the manifest.'),
      replaces: z.string().optional().describe('The id of an older Source document this one replaces.'),
    },
    handler: uploadSourceDocument,
  },
  {
    name: 'add_source_document_from_address',
    description:
      '1. Adds a Source document to an instance from a web address, under the same rules as the web app\'s "Add from address": gantry serve fetches the page or document (a public web page, PDF, Word, PowerPoint, spreadsheet, Markdown or text file, or picture, at most 25 MB) and keeps a snapshot of it, never a live link. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "address" is required. ' +
      '3. Private, loopback and cloud-metadata addresses are refused, at every redirect, unless the operator allows private addresses for Source documents. A page behind a sign-in, a paywall or a VPN can\'t be fetched: Gantry never takes cookies or passwords for other sites. Each failure (unreachable, a 4xx or 5xx, a time-out, over 25 MB, an unsupported type, a sign-in page) comes back with what to do; pass it on to the architect. ' +
      '4. The text is read as for upload_source_document (an HTML page to Markdown; its images and scripts are not captured). The entry records its "origin": { address, finalAddress, fetchedAt }. "title" defaults to the page\'s own title; "replaces" and "uploadedBy" work as for upload_source_document. ' +
      '5. One commit on the current stage\'s branch on an Azure DevOps or GitHub workspace, as for an upload. This is a real write — treat it as final once called. ' +
      '6. Only listed when the operator has not switched adding by address off.',
    inputSchema: {
      ...slugRefShape,
      address: z.string().min(1).describe('The web address, starting http:// or https://.'),
      title: z.string().optional().describe("Display title; defaults to the page's own title, or the file name."),
      uploadedBy: z.string().optional().describe('Who is adding it, recorded in the manifest.'),
      replaces: z.string().optional().describe('The id of an older Source document this one replaces.'),
    },
    available: sourceFetchOffered,
    handler: addSourceDocumentFromAddress,
  },
  {
    name: 'fetch_source_document_again',
    description:
      '1. Fetches a Source document that was added from a web address (it has an "origin") again, from the address it was added from. Nothing ever refetches on its own: this is the only way. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "id" is required (from list_source_documents). ' +
      '3. If the fetched bytes are identical, nothing is added or flagged and the response says "unchanged": true. If they differ, the new copy is added as a new document that replaces the old one (the old one stays, citable and marked "replaced by"), and the Fields that drew on the old one are flagged Out of date — bring them up to date with the architect. ' +
      '4. Only the newest copy of a page is fetched again, as in the app: a document that has already been replaced (another document\'s "replaces" names it) is refused. ' +
      '5. The same address check, limits and failures as add_source_document_from_address. A real write when the page changed — treat it as final once called. ' +
      '6. Only listed when the operator has not switched adding by address off.',
    inputSchema: {
      ...slugRefShape,
      id: z.string().describe('The Source document id, from list_source_documents. It must have an "origin" and be the newest copy: one another document "replaces" is refused, so fetch that newer one again instead.'),
      uploadedBy: z.string().optional().describe('Who is fetching it again, recorded on the new document if the page changed.'),
    },
    available: sourceFetchOffered,
    handler: fetchSourceDocumentAgain,
  },
  {
    name: 'read_decisions_log',
    description:
      '1. Reads a stage\'s decisions log — the committed record of the AI interview for that stage: what the architect decided, their open questions, which Fields were drafted from which inputs, and the interview session status. Read it before you draft or resume, so you do not ask again what is already settled. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". "stage" (a stage id) reads a stage other than the instance\'s current one; "allStages": true returns every stage\'s log, in stage order. ' +
      '3. The log is append-only: entries are never changed. Each entry says who recorded it — the architect\'s own words, Gantry\'s AI, or an outside agent. An empty log (no entries, no Fields) means no interview has been saved for that stage yet. ' +
      '4. Server, Azure DevOps and GitHub workspaces (a Provider workspace\'s log is read from the stage\'s own branch). GitLab and Atlassian workspaces answer 400 until their module Save lands.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to read instead of the instance\'s current stage.'),
      allStages: z.boolean().optional().describe('Read every stage\'s log instead of one.'),
    },
    handler: readDecisionsLog,
  },
  {
    name: 'list_reviewed_copies',
    description:
      '1. Lists the Reviewed copies brought in to an instance — Word documents Gantry rendered that came back with reviewers\' comments and tracked changes. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Each carries its "id", "name", the "artefact" and "stage" it was rendered from, the "commenters", the "date" it was brought in, and "comments" / "commentsAnswered" counts. Read one with read_reviewed_copy.',
    inputSchema: { ...slugRefShape },
    handler: listReviewedCopies,
  },
  {
    name: 'read_reviewed_copy',
    description:
      '1. Reads one Reviewed copy\'s comment threads and tracked changes, each placed on the Field it traces to — the same placing the web app shows. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "id" is required (from list_reviewed_copies). ' +
      '3. The response is "groups": one per Field ({ kind: "field", field: { key: "moduleId.fieldId", moduleTitle, fieldTitle } }), then "document" for comments on the cover, Document Control or table of contents Gantry supplies, then "unplaced" for what could not be matched. Each group has "threads" (author, date, text, "resolved", "replies", the "anchor" words it sits on and its "placement") and "changes" (tracked insertions and deletions). ' +
      '4. "mode" says how they were placed; when the Field bookmarks were lost (Google Docs renames them) items are placed by matching text, and "notice" says so — treat a "best guess" placement as one to confirm with the architect. ' +
      '5. Gantry never writes into the document or replies to its commenters: take what a thread asks for to the architect, and change the Field with update_instance_modules only on their word.',
    inputSchema: {
      ...slugRefShape,
      id: z.string().describe('The Reviewed copy id, from list_reviewed_copies.'),
    },
    handler: readReviewedCopy,
  },
  {
    name: 'upload_reviewed_copy',
    description:
      '1. Brings one or more Reviewed copies (Word .docx files Gantry rendered that came back with comments) in to an instance, under the same rules as the web app: 25 MB for the upload in all, one commit on the current stage\'s branch on an Azure DevOps or GitHub workspace, and the same check that the document is one of this instance\'s own renders. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "files" is required: [{ filename, contentBase64 }]. ' +
      '3. A document with none of the gantry-* properties a Gantry render carries is refused (422) with "This document wasn\'t rendered by Gantry..." — upload it with upload_source_document instead. A document rendered from another instance or artefact is refused with the reason. One refused file means none are kept. ' +
      '4. Returns "reviewedCopies": the manifest entries added. Read their threads with read_reviewed_copy. ' +
      '5. This is a real write — treat it as final once called.',
    inputSchema: {
      ...slugRefShape,
      files: z
        .array(z.object({ filename: z.string().min(1).describe('The file name, ending .docx.'), contentBase64: z.string().min(1).describe('The document\'s bytes, base64-encoded.') }))
        .min(1)
        .describe('The Reviewed copies to bring in.'),
    },
    handler: uploadReviewedCopy,
  },
]
