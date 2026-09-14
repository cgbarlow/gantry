import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDefinition, listDefinitions, loadDefinitionChangelog, writeDefinitionVersion, definitionVersionProjection, createDraftVersion, cloneDefinition, createBlankDefinition, publishDefinitionVersion, isDefinitionArchived, archiveDefinition, restoreDefinition, readDefinitionTemplate, writeDefinitionTemplate, readDefinitionReferenceDocx, writeDefinitionReferenceDocx, findDefinitionProblemsInStructure, TEMPLATE_NAME_RE } from './definition.js'
import { readInstance, readModule, writeModule, writeModules, createInstance, importInstanceToAzureDevOps, updateInstanceAssignee, updateInstanceRequiredReviewer, recordInstanceWorkItemLink, instanceDefinitionVersion, AZURE_DEVOPS_WORKSPACE_ROOT } from './instance.js'
import { getStatus } from './status.js'
import { checkGate, resolveCheckStage } from './check.js'
import { renderArtefact, prepareAzureDevOpsWasmRender, finishAzureDevOpsWasmRender, externaliseImagesForWasm } from './render.js'
import { findStageBranch, resolveStageBranch, stageBranchName, getStageSyncStatus, syncStageBranch } from './stageBranch.js'
import { buildImportMap } from './importmap.js'
import { listRegistry } from './registry.js'
import {
  registerInstance,
  resolveInstanceLocation,
  resolveInstanceWorkspaceId,
  listRegisteredInstances,
  archiveInstance,
  restoreInstance,
  isInstanceArchived,
  scopeIdForDirectoryFolder,
  MIGRATED_DEFAULT_WORKSPACE_FOLDER,
} from './instanceRegistry.js'
import { migrateLegacyWorkspaceDirectory } from './workspaceMigration.js'
import { resolveInstanceDataDir, ensureDefaultWorkspace } from './instanceDataDir.js'
import {
  registerWorkspace,
  listWorkspaces,
  updateWorkspace,
  resolveWorkspace,
  archiveWorkspace,
  restoreWorkspace,
  isWorkspaceArchived,
  assertValidTicketingSystem,
  DEFAULT_TICKETING_SYSTEM,
  getOrCreateWorkspace,
  findWorkspaceByLocation,
} from './workspaceRegistry.js'
import {
  instanceNumbersFor,
  getOrAssignWorkspaceNumber,
  formatInstanceRef,
  parseInstanceRef,
  resolveScopeAndSlugForRef,
  stageNumberForStageId,
  stageIdForNumber,
} from './numberRegistry.js'
import { createAsset, getAsset, listAssets } from './assets.js'
import { getCredential } from './credential.js'
import { AzureDevOpsAuthenticationError, AzureDevOpsNotFoundError, AzureDevOpsRepoNotFoundError, AzureDevOpsRequestError, createAzureDevOpsClient } from './azureDevOpsClient.js'
import { checkAzureDevOpsRepo } from './repoCheck.js'
import {
  linkInstanceToWorkItem,
  syncGatePassToWorkItem,
  tagAllLinkedWorkItems,
  tagLinkedWorkItems,
} from './workItemLink.js'
import { advanceStage } from './stageAdvancement.js'
import { requestStageApproval } from './stageApproval.js'
import { checkStageApprovalStatus, summarizePullRequest } from './stageStatus.js'
import { reopenStage } from './stageReopen.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { getStageSyncedFields, saveStageSyncedFieldOverrides } from './syncedFields.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { requestStageReview, checkStageReviewStatus } from './stageReview.js'
import { isValidSlug, parseInstanceAddress } from './slug.js'
import { artefactFileUrl, commitUrl } from './azureDevOpsFileUrl.js'
import { renderUserGuide } from './userGuide.js'
import { REVIEW_STATUS } from './reviewStatus.js'
import { runLocalWorkspaceCompute, LocalWorkspaceRequestError, LOCAL_WORKSPACE_LIMITS } from './localWorkspace.js'

/**
 * reviewSummary shape — see lib/render.js's documented single source of truth.
 * Built here in the server render routes from instance reviewRequests /
 * pullRequests + work-item/PR data and passed into renderArtefact via
 * `options.reviewSummary`; compileArtefact stays pure with no new network
 * calls.
 */
function buildReviewSummaryForArtefact(definition, artefact, instance, azureDevOpsLocation, commitInfo = null) {
  const stage = definition.stages.find((s) => s.gate === artefact.gate) ?? null
  const version = `${definition.id} v${definition.version} · ${stage ? stage.title : artefact.title}`
  const stageTitle = stage ? stage.title : artefact.title
  // Date is the commit date when known (same value the old footer used);
  // left blank when the commit hasn't been allocated yet (the two-push
  // Azure-DevOps flow) — compileArtefact merges it from options.commit later.
  const date = commitInfo?.date ?? ''
  const commit = commitInfo
    ? {
        hash: commitInfo.hash,
        url: azureDevOpsLocation && commitInfo.fullHash ? commitUrl(azureDevOpsLocation, commitInfo.fullHash) : undefined,
        date: commitInfo.date,
      }
    : { hash: '', url: undefined, date: '' }

  const rows = []

  // Reviews for this artefact's own gate only — no cross-stage history.
  const reviewRequests = instance.reviewRequests?.[stage?.id ?? ''] ?? []
  for (const review of reviewRequests) {
    const name = review.reviewerDisplayName || review.reviewer || ''
    const role = '' // gantry does not capture Role/Title for reviews
    const reviewDate = '' // gantry does not capture a dedicated review date
    const process = '' // gantry does not capture Review process
    // Map gantry's five-value vocab to the table's display values; Pending
    // is the draft/empty row below, not a stored status.
    let status = review.status ?? 'Pending'
    if (status === REVIEW_STATUS.REQUESTED) status = 'In review'
    const referenceUrl =
      instance.workItem
        ? `${(instance.workItem.baseUrl ?? 'https://dev.azure.com')}/${encodeURIComponent(instance.workItem.organization)}/${encodeURIComponent(instance.workItem.project)}/_workitems/edit/${review.workItemId}`
        : undefined
    const referenceText = review.workItemId ? `#${review.workItemId}` : ''
    rows.push({
      name,
      role,
      date: reviewDate,
      process,
      status,
      reference: { text: referenceText, url: referenceText ? referenceUrl : undefined },
    })
  }

  // Sign-off for this artefact's own gate only — one row per PR.
  const stageId = stage?.id
  if (stageId && instance.pullRequests?.[stageId]) {
    const pullRequestId = instance.pullRequests[stageId]
    const approvalState = instance.approvalStates?.[stageId] ?? null
    const prStatus = instance.pullRequestStatuses?.[stageId] ?? null
    let status = 'In review'
    if (approvalState?.state === 'invalidated') status = 'In review'
    else if (prStatus === 'completed') status = REVIEW_STATUS.APPROVED
    else if (prStatus === 'abandoned') status = 'In review'
    else status = 'In review'
    // If the stored PR was never checked but approvalStates already says
    // invalidated, keep In review; otherwise default stays In review.

    const pullRequestUrl = azureDevOpsLocation
      ? `${(azureDevOpsLocation.baseUrl ?? 'https://dev.azure.com')}/${encodeURIComponent(azureDevOpsLocation.organization)}/${encodeURIComponent(azureDevOpsLocation.project)}/_git/${encodeURIComponent(azureDevOpsLocation.repository)}/pullrequest/${pullRequestId}`
      : undefined
    // Name for sign-off — prefer the recorded approver display name if we have
    // it via approvalStates, else blank (gantry does not always capture it).
    const name = approvalState?.reviewerDisplayName ?? ''
    rows.push({
      name,
      role: '',
      date: approvalState?.approvedAt ? String(approvalState.approvedAt).slice(0, 10) : '',
      process: '',
      status,
      reference: { text: `PR #${pullRequestId}`, url: pullRequestUrl },
    })
  }

  // Draft / local instance with no review/sign-off data yet — still renders
  // with a Pending row; the block is never omitted.
  if (rows.length === 0) {
    rows.push({ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } })
  }

  // Gate status for the Document Control table — Draft / In review / Approved / Passed
  let gateStatus = 'Draft'
  if (rows.some((r) => r.status === REVIEW_STATUS.APPROVED)) gateStatus = 'Approved'
  else if (rows.some((r) => r.status === 'Pending' && rows.length === 1 && !instance.pullRequests?.[stageId] && !reviewRequests.length)) gateStatus = 'Draft'
  else if (rows.length > 0) gateStatus = 'In review'
  // If this gate's PR is completed and the instance has advanced beyond it,
  // treat as Passed — keep simple: completed PR maps to Passed only when
  // instance's current stage is no longer this one.
  if (stageId && instance.pullRequestStatuses?.[stageId] === 'completed' && instance.stage !== stageId) {
    gateStatus = 'Passed'
  }

  return { version, stageTitle, date, commit, gateStatus, rows }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  // WI314 — pandoc-wasm's own binary, served straight out of node_modules (see
  // FRONT_END_SPECIFIERS below); fetch()/arrayBuffer() doesn't care about Content-Type,
  // but the correct MIME is cheap to send and keeps the door open for
  // WebAssembly.instantiateStreaming later.
  '.wasm': 'application/wasm',
}

// WI #385 — reference-docx Replace/Download.
const REFERENCE_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
// Cap on the raw (base64-encoded JSON) PUT body for a reference .docx upload, enforced by
// readBodyWithLimit before any of it is parsed or decoded — generous for a Word styling template
// (which carries little beyond styles/headers/footers, no document content) while still bounding
// the memory a single request can force the server to hold. The decoded .docx itself ends up
// smaller than this, base64 inflating bytes by roughly a third.
const MAX_REFERENCE_DOCX_BODY_BYTES = 15 * 1024 * 1024

// The bare specifiers the web form imports directly; buildImportMap walks their `dependencies` to resolve the rest of the tree.
//
// 'preact/hooks' and 'htm/preact' are subpath specifiers, not separate npm packages — both ship their own nested package.json (preact/hooks/, htm/preact/) precisely so tools like buildImportMap (which resolves each specifier as a directory under node_modules) can address them directly, per docs/adr/0006-preact-frontend-framework.md.
const FRONT_END_SPECIFIERS = [
  'codemirror',
  '@codemirror/state',
  '@codemirror/lang-markdown',
  'markdown-it',
  'dompurify',
  'preact',
  'preact/hooks',
  'preact-iso',
  '@preact/signals',
  'htm',
  'htm/preact',
  // ADR-0029 local workspaces: the "+ New Workspace" wizard writes a new
  // local instance's `instance.yaml` / `modules/*.md` in the browser
  // (web/lib/localInstanceFiles.js) and needs the same YAML serializer
  // `lib/instance.js` uses server-side. `yaml` ships a browser ESM build.
  'yaml',
  // WI314 — web/lib/pandocWasm.js's own dependency, not pandoc-wasm itself: that
  // package's "exports" field resolves (via resolveEntry's `dot.default` fallback,
  // lib/importmap.js) to its top-level `index.js`, which environment-sniffs at
  // runtime and, in a real browser, dynamically imports its `src/index.browser.js` —
  // which does a raw top-level `import("./pandoc.wasm")` of the *binary itself* as
  // an ES module. No bundler here to turn that into an asset-URL import (pandoc-wasm's
  // own README says as much: bundler config is required for exactly this), and no
  // browser ships WASM/ESM-integration by default — confirmed by hand (a scratch
  // Playwright page hit "Failed to load module script: Expected a JavaScript-or-Wasm
  // module script but the server responded with a MIME type of application/wasm").
  // pandocWasm.js sidesteps this entirely: it imports pandoc-wasm's environment-agnostic
  // `src/core.js` directly (a fixed `/node_modules/...` path, never pandoc-wasm's own
  // broken browser entry) and fetches the `.wasm` binary itself as raw bytes. `core.js`
  // only bare-imports this one dependency, so it's the only extra front-end specifier
  // pandoc-wasm needs — confirmed working end-to-end (init + a real markdown→docx
  // conversion) in the same scratch Playwright page.
  '@bjorn3/browser_wasi_shim',
]

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// WI #368 — every static response carries a validator and `Cache-Control: no-cache`.
//
// The server previously sent no `Cache-Control`, `ETag` or `Last-Modified` on anything, which does
// not mean "don't cache" — with no validator and no freshness information a browser falls back to
// *heuristic* caching and may reuse a stored response without asking. That is how a tab open across
// an upgrade keeps running the previous `app.js` against a newly restarted server: the front end and
// the back end silently disagree about what the API accepts, and the only cure is a manual hard
// reload nobody knows to perform.
//
// `no-cache` is the accurate directive here, and is not `no-store`: the browser may keep the
// response, it just has to revalidate before reusing it. A revalidation that matches costs one 304
// with no body, so an unchanged `app.js` is still effectively free, while a changed one is picked up
// on the very next navigation.
//
// The validator is a weak ETag over size and mtime rather than a content hash — the same shape most
// static servers use, and enough to change whenever a `git pull` rewrites a file.
function staticEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

function notModified(req, etag) {
  return req.headers['if-none-match'] === etag
}

function serveStaticFile(req, res, rootDir, relativePath) {
  const root = normalize(rootDir)
  const filePath = normalize(join(root, relativePath))
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const etag = staticEtag(statSync(filePath))
  if (notModified(req, etag)) {
    // A 304 must still carry the validator, or the next request has nothing to revalidate with.
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    ETag: etag,
    'Cache-Control': 'no-cache',
  })
  res.end(readFileSync(filePath))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// Like readBody, but rejects as soon as the accumulated byte count crosses
// `maxBytes` rather than after buffering the whole body — used only by
// /api/local/* (WI #299 security review, docs/adr/0029). Those routes accept
// a caller-supplied file tree with no PAT/credential requirement, so an
// unbounded readBody() would let an unauthenticated caller force the server
// to buffer an arbitrarily large body into memory before the existing
// LOCAL_WORKSPACE_LIMITS.maxBodyBytes check ever ran — a real memory-
// exhaustion vector the previous `Buffer.byteLength(rawBody) > maxBodyBytes`
// post-check (still kept below, now unreachable in the oversized case but
// left as defense-in-depth) never actually prevented. This stops adding
// chunks to the buffer the moment the limit is crossed instead; the socket
// itself is left alone (not destroyed) so `res` can still carry the 413
// response back to the caller.
function readBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let settled = false
    function cleanup() {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }
    function onData(chunk) {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        cleanup()
        const err = new Error('Request body too large')
        err.tooLarge = true
        reject(err)
        return
      }
      chunks.push(chunk)
    }
    function onEnd() {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    function onError(err) {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

// Resolves the slug for a single-instance route (WI200, docs/adr/0024): `?ref=<numeric ref>` (the new canonical form — `w<workspaceNumber>i<instanceNumber>`, or a workspace-only `w<workspaceNumber>` defaulting to that workspace's instance 1) takes priority when present; otherwise falls back to the pre-existing `?slug=` query param, then the server's own default slug (`options.slug`) — the exact resolution every one of these routes already used before this ticket, kept working indefinitely (ADR-0024 decision #3). Returns `{ error }` (never throws) for an unparseable/unknown `ref`, a missing slug, or a slug that fails the single-path-segment check, so callers can respond with a 400 instead of letting an invalid value reach the filesystem.
function resolveSlugParam(url, defaultSlug, instancesDir) {
  const ref = url.searchParams.get('ref')
  if (ref) {
    // WI #366: `resolveScopeAndSlugForRef`, not `resolveSlugForRef` — a ref's workspace number has
    // already pinned down exactly one scope, and discarding it here was what sent the canonical URL
    // form back through the deprecated whole-registry slug search on every subsequent lookup.
    const resolved = resolveScopeAndSlugForRef(ref, { instancesDir })
    if (!resolved) {
      return { error: `Unknown reference "${ref}"` }
    }
    return { slug: resolved.slug, scopeId: resolved.scopeKey }
  }

  const address = url.searchParams.get('slug') ?? defaultSlug
  if (!address) {
    return { error: 'No instance slug given — pass ?ref=<numeric reference>, ?slug=<slug>, or a default at server startup' }
  }
  // WI #366: `?slug=` accepts the workspace-qualified "<workspace>/<slug>" form the registry's own
  // deprecation notice recommends, as well as a bare slug. `?scope=` carries the opaque scope token
  // GET /api/instance/workspace hands out — the form the web client uses, since it covers an Azure
  // DevOps workspace (keyed by uuid) as well as a directory one, and takes precedence when both are
  // present. With neither, the lookup falls back to the deprecated bare-slug search, which still
  // resolves a slug unique across every workspace and still warns (ADR-0031's compatibility rule).
  const parsed = parseInstanceAddress(address)
  if (!parsed) {
    return { error: `Invalid instance slug "${address}"` }
  }
  const scopeParam = url.searchParams.get('scope')
  const scopeId = scopeParam || (parsed.workspace ? scopeIdForDirectoryFolder(parsed.workspace) : undefined)
  return { slug: parsed.slug, scopeId }
}

// Resolves the stage id for a single-instance route (WI200, docs/adr/0024): an explicit `?stage=` query param (the pre-existing behavior, always wins) takes priority; otherwise a numeric stage number — either `?stageNumber=<N>` directly, or embedded in a `?ref=w<N>i<M>s<K>` this same request's `resolveSlugParam` call already consumed for its slug — resolves via `stageIdForNumber`. A numeric `ref` present with *no* stage number defaults to that instance's stage 1 (ADR-0024's "instance-only resolves to stage 1" decision) — distinct from a plain legacy `?slug=`-only request with no stage at all, which keeps defaulting to `defaultStageId` (the instance's own persisted *current* stage) exactly as it always has, unaffected by this ticket.
function resolveStageIdParam(url, definition, defaultStageId) {
  const explicitStage = url.searchParams.get('stage')
  if (explicitStage) return explicitStage

  const ref = url.searchParams.get('ref')
  const parsedRef = ref ? parseInstanceRef(ref) : null
  const stageNumberParam = url.searchParams.get('stageNumber')
  const stageNumber = stageNumberParam ? Number(stageNumberParam) : parsedRef?.stageNumber

  if (stageNumber) {
    return stageIdForNumber(definition, stageNumber) ?? defaultStageId
  }
  if (ref) {
    return stageIdForNumber(definition, 1) ?? defaultStageId
  }
  return defaultStageId
}

function fieldValue(field, data) {
  const raw = data.fields[field.id]
  if (raw !== undefined) return raw
  return field.type === 'list' ? [] : ''
}

// The structured "authentication required" response (#82's spec, built out here per #86). Missing credentials keep the original response shape; a supplied credential rejected by Azure DevOps carries safe diagnostic metadata so the frontend can explain the failure without ever echoing the PAT.
function sendAuthenticationRequired(res, { credentialRejected = false, operation } = {}) {
  const body = {
    error: 'authentication_required',
    message:
      'A valid Azure DevOps Personal Access Token is required for this instance. ' +
      'Provide it via HTTP Basic auth (empty username, PAT as password).',
  }
  if (credentialRejected) {
    body.credentialRejected = true
    body.credentialStatus = 'rejected'
    body.operation = operation
    const identityOperation = operation === 'identity search' || operation?.includes('required reviewer')
    body.message = operation
      ? `The Azure DevOps PAT already provided was rejected while ${operation}. ` +
        (identityOperation
          ? 'It may need the Identity (Read) scope in addition to the scopes already configured.'
          : 'Check that it is valid and has the scopes required for this operation.')
      : 'The Azure DevOps PAT already provided was rejected for this request. It may be expired, invalid, or missing a required scope.'
  }
  sendJSON(res, 401, body)
}

// Resolves `slug`'s storage location via the instance registry (#89): `{ organization, project, repository, baseUrl }` for a slug the registry says is Azure-DevOps-backed, or `null` for everything else — a `{ kind: 'local' }` entry, or a slug the registry has never seen at all (resolved locally exactly as an unregistered slug always has been, surfacing readInstance's own "no instance" error rather than this layer inventing one). This is what lets a single running server serve any mix of local and Azure-DevOps-backed instances at once: the routes below ask this per request instead of trusting one location fixed at server startup.
function resolveAzureDevOpsLocation(slug, instancesDir, scopeId) {
  const location = resolveInstanceLocation(slug, { instancesDir, scopeId })
  if (location?.kind !== 'azureDevOps') return null
  const { organization, project, repository, baseUrl } = location
  return { organization, project, repository, baseUrl }
}

// WI #356/#358: resolves any slug's concrete directory-backed instancesDir dynamically via the
// registry, rather than assuming every local instance lives in the one reserved `default` server
// workspace (`localInstancesDir`, below — still correct for an instance this server *creates* over
// HTTP, per createServer's own doc comment, but not for reading one that already lives in some
// other named server workspace, e.g. the bundled `examples` workspace WI #358 ships). Every
// single-instance local route (read, status, check, render, assets, synced fields, work-item
// linking, ...) calls this per request instead of using a single fixed directory, so a slug is
// found wherever its own registry entry actually says it lives.
//
// WI #370: the resolution itself now lives in lib/instanceDataDir.js, shared with the CLI. It used to
// be private to this file, which is precisely how `gantry instances` ended up reporting "No instances
// found." against a workspaces root this server listed two instances from — the CLI had no equivalent
// and nowhere to get one. Behaviour here is unchanged: without `strict`, resolution never throws on an
// ambiguous or unknown slug, so callers still see whatever readInstance itself reports for a directory
// that doesn't exist rather than a resolution error invented at this layer.
function resolveLocalDataDir(slug, instancesDir, scopeId) {
  return resolveInstanceDataDir(slug, instancesDir, { scopeId })
}

function instanceStageUrl(req, slug, stageId) {
  const forwardedProtocol = req.headers['x-forwarded-proto']?.split(',')[0]?.trim()
  const protocol = forwardedProtocol || 'http'
  const host = req.headers.host || 'localhost'
  const stageQuery = stageId ? `?stage=${encodeURIComponent(stageId)}` : ''
  return `${protocol}://${host}/instance/${encodeURIComponent(slug)}${stageQuery}`
}

// Gates an Azure-DevOps-backed instance-data route behind the credential-provider seam (lib/credential.js): with no PAT on the request, responds with the structured "authentication required" response and never calls `fn` at all; with one, calls `fn({ ...azureDevOpsLocation, pat })` and — if Azure DevOps itself rejects that PAT (`AzureDevOpsAuthenticationError`, surfaced from lib/instance.js/lib/status.js/lib/render.js's Azure-DevOps-backed paths) — responds with that exact same structured response rather than letting it fall through as a generic error. Any other error `fn` throws propagates to the server's own top-level catch (a 500), unchanged.
async function withAzureDevOpsCredential(req, res, azureDevOpsLocation, fn) {
  const pat = getCredential(req)
  if (!pat) {
    sendAuthenticationRequired(res)
    return
  }
  try {
    await fn({ ...azureDevOpsLocation, pat })
  } catch (err) {
    if (err instanceof AzureDevOpsAuthenticationError) {
      sendAuthenticationRequired(res)
      return
    }
    throw err
  }
}

// The single module-entry shape `GET /api/instance` returns, built from already-fetched module/example data — shared by the local and Azure-DevOps-backed branches of that route so they can never drift in what they hand the module editor, only in how `data`/`exampleData` were read.
//
// When the parsed data carries a `layout` (#132), its fields array follows that document order exactly: defined fields and preserved custom fields interleaved as the author arranged them (each custom field rendered as a markdown field with `custom: true`, so the editor gives it its own Insert ▾). Defined fields missing from the file are appended in definition order, as before.
function buildModuleEntry(definition, stage, moduleId, data, exampleData) {
  const moduleSpec = definition.modules.get(moduleId)
  const definedById = new Map(moduleSpec.fields.map((field) => [field.id, field]))
  const entryForDefined = (field) => ({
    id: field.id,
    title: field.title,
    type: field.type,
    required: Boolean(field.required) || Boolean(field.requiredAt?.includes(stage.gate)),
    guidance: field.guidance,
    value: fieldValue(field, data),
    example: exampleData ? fieldValue(field, exampleData) : null,
  })

  const entries = []
  const emitted = new Set()
  for (const layoutEntry of data.layout ?? []) {
    if (layoutEntry.field !== undefined) {
      const field = definedById.get(layoutEntry.field)
      if (!field) continue
      entries.push(entryForDefined(field))
      emitted.add(field.id)
    } else if (layoutEntry.custom) {
      entries.push({
        id: layoutEntry.custom.id,
        title: layoutEntry.custom.title,
        type: layoutEntry.custom.type === 'list' ? 'list' : 'markdown',
        required: false,
        guidance: null,
        value: layoutEntry.custom.value ?? (layoutEntry.custom.type === 'list' ? [] : ''),
        example: null,
        custom: true,
      })
    }
  }
  for (const field of moduleSpec.fields) {
    if (!emitted.has(field.id)) entries.push(entryForDefined(field))
  }

  return {
    id: moduleId,
    title: moduleSpec.title,
    purpose: moduleSpec.purpose,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
    fields: entries,
  }
}

// The `GET /api/instance` response shape, built from an already-loaded definition/stage/instance and the per-module entries above — shared by the local and Azure-DevOps-backed branches of that route for the same reason `buildModuleEntry` is. `isWorkspaceBacked` is the same "does the instance registry resolve this slug's storage as Azure DevOps" check every other single-instance route already makes (`resolveAzureDevOpsLocation`) — surfaced here (as `workspaceBacked`) so the web form's Stage advancement panel (#115) knows to hide its self-serve "Advance to next stage" action entirely for a Workspace-backed instance, which only ever advances via its own Pull Request flow instead (ADR-0014, #122-#125).
async function readPullRequestSummary(instance, stage, azureDevOps) {
  const pullRequestId = instance.pullRequests?.[stage.id]
  if (!pullRequestId || !azureDevOps) return null

  const client = createAzureDevOpsPullRequestsClient(azureDevOps)
  try {
    const pullRequest = await client.getPullRequest(pullRequestId)
    const commits = await client.getPullRequestCommits(pullRequestId)
    return summarizePullRequest(pullRequest, commits, instance.approvalStates?.[stage.id])
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) return null
    throw err
  }
}

function buildInstanceResponse(
  slug,
  definitionsDir,
  definition,
  stage,
  instance,
  modules,
  isWorkspaceBacked,
  workspace = null,
  pullRequest = null,
  instancesDir = 'instances',
  scopeId = undefined,
) {
  // WI200/docs/adr/0024's numeric references — assigned lazily (on first read of this instance, if it doesn't have one yet) rather than only at creation time, so an instance created before this feature shipped, or via a path that doesn't yet know about numeric refs, still gets numbered the first time anything asks.
  // WI #366: `scopeId` pins the numbering lookup to the workspace this request already resolved
  // within — without it, numbering re-searches every workspace for the slug and throws on a slug two
  // workspaces share, failing the whole response over a field that is only its numeric reference.
  const { workspaceNumber, instanceNumber } = instanceNumbersFor(slug, { instancesDir, scopeId })
  const ref = formatInstanceRef({ workspaceNumber, instanceNumber })
  return {
    slug,
    definition: definition.id,
    // The definition version this instance is pinned to (#231) — absent
    // from every response shape until now (Instance Settings' read-only
    // "Instance info" card had a "Definition" row but nothing naming
    // *which* version of it).
    definitionVersion: instanceDefinitionVersion(instance),
    stage: { id: stage.id, title: stage.title, gate: stage.gate, number: stageNumberForStageId(definition, stage.id) },
    // The instance's actual persisted stage — distinct from `stage` above once the form is browsing a different stage's modules.
    currentStageId: instance.stage,
    hasExample: Boolean(stage.example),
    stages: definition.stages.map((s, i) => ({ id: s.id, title: s.title, gate: s.gate, number: i + 1 })),
    // Numeric references (WI200, docs/adr/0024) — the canonical form Gantry now generates for URLs, layered over (never replacing) this instance's own slug/stage id above. `workspaceNumber` is 0 for a local instance (no real Workspace, lib/workspaceRegistry.js, of its own) — see lib/numberRegistry.js's LOCAL_WORKSPACE_NUMBER.
    workspaceNumber,
    instanceNumber,
    ref,
    // Only offer artefacts for the viewed stage's own gate, and only once their template actually exists — the design definition declares hld/sad/ssad/as-built ahead of their templates being written.
    artefacts: definition.artefacts
      .filter((a) => a.gate === stage.gate)
      .filter((a) => existsSync(join(definition.definitionDir ?? join(definitionsDir, instance.definition), a.template)))
      .map((a) => ({ id: a.id, title: a.title, requires: a.requires })),
    modules,
    // The instance-level Azure DevOps work-item link (#103) — `null` for an (the default) unlinked instance, or `{ organization, project, workItemType, parentId, stages: { [stageId]: childWorkItemId } }` once linked. Never includes a PAT or anything credential-shaped; this is the same purely-descriptive shape `instance.yaml`'s own `azureDevOps` field already follows.
    workItem: instance.workItem ?? null,
    // Which stages already have an open "request approval" Pull Request (#124, ADR-0014) — `{ [stageId]: pullRequestId }`, `{}` for an instance with none yet. Lets the web form's Request-approval panel know not to offer requesting approval again for a stage that's already mid-review, even across a page reload, without a second round-trip to Azure DevOps itself.
    pullRequests: instance.pullRequests ?? {},
    approvalStates: instance.approvalStates ?? {},
    reviewRequests: isWorkspaceBacked ? instance.reviewRequests ?? {} : {},
    // Review requests are deliberately narrowed to the stage being viewed;
    // the instance record may contain requests for other stages, but the
    // screen's status card is current-stage-only.
    reviews: isWorkspaceBacked ? instance.reviewRequests?.[stage.id] ?? [] : [],
    pullRequest,
    // The instance record's own stored `assignee` (#97) — previously only
    // surfaced via `GET /api/instances`' registry row, never on this
    // single-instance route. The new Instance Settings screen (#107) needs
    // it alongside the rest of this response (definition/stage/workItem),
    // rather than making a second request against the multi-instance
    // registry route just to read one instance's own field.
    assignee: instance.assignee ?? '',
    requiredReviewer: instance.requiredReviewer ?? '',
    reopened: instance.reopened ?? {},
    workspaceBacked: Boolean(isWorkspaceBacked),
    // Workspace location for building persistent hyperlinks (WI155) — the persisted instance PR record's org/project/repo + baseUrl, not derived from the workItem's org. Only present when workspaceBacked is true; null otherwise so the client can build URLs without a second registry round-trip.
    workspace: workspace ?? null,
  }
}

/**
 * `gantry serve [slug]`: a static-file + minimal JSON API server behind the vanilla-JS/ESM web form. Serves `web/`, serves `node_modules/` (so the browser can `import` CodeMirror 6 / markdown-it / DOMPurify via a generated import map, with no bundler), and reads/writes the identical instance module files the CLI path does — no second store.
 *
 * `options.slug` is an optional default, not a requirement: `GET /api/instances` lists every instance regardless, and the single-instance routes below resolve their slug per-request (`?slug=<slug>`, falling back to `options.slug` when the query param is absent) — so a server can be started with no slug at all and still serve instance data, once the caller supplies one per request.
 *
 * Each single-instance route (`GET /api/instance`, `PUT /api/instance/modules/:id`, `POST /api/instance/render/:artefact`, per #86/#92, plus `PUT /api/instance/assignee`, #97) resolves its own slug against the shared instance registry (lib/instanceRegistry.js, #89) *per request* to decide whether it's local or Azure-DevOps-backed — there is no per-process Azure DevOps location configured at server startup any more. A slug the registry says is Azure-DevOps-backed (`{ organization, project, repository, baseUrl? }` — a *location*, never a credential) is gated behind the credential-provider seam (lib/credential.js's `getCredential(req)`), extracting the caller's own Azure DevOps PAT from its Authorization header and passing it — never stored beyond that one request — into lib/instance.js/lib/status.js/lib/render.js's Azure-DevOps-backed paths (#85) alongside that location. A request with no PAT, or one Azure DevOps itself rejects, gets the same structured "authentication required" response either way. A slug the registry says is local (or has never seen at all) is completely unaffected: no credential is ever required or even looked for. Because this resolution happens per request rather than once at startup, a single running server can serve any mix of local and Azure-DevOps-backed instances at once — e.g. `examples`/`demo-cli`/`demo-web` alongside any number of registered remote instances.
 *
 * The multi-instance registry routes (`GET`/`POST /api/instances`, #93) always operate on the local `instancesDir` for *reading the registry itself*, but — unlike before #93 — aren't limited to local instances: `POST /api/instances` can carry its own `azureDevOps` field to register a *new* Azure-DevOps-backed instance (gated behind the same credential-provider seam as the single-instance routes above, but resolved per-call rather than fixed at server startup) alongside — not instead of — the local-instance path these routes have always served, and `GET /api/instances` lists both kinds together in one unified list. `POST /api/instances/adopt` (#94) is that same route's companion for the opposite case — a location the caller already knows (from its own prior `GET /api/azure-devops/repo-check`) already holds instance data — and only ever registers that location, never writing anything.
 *
 * `options.allowedAzureDevOpsBaseUrls` (default `[]`, an exact-match allow-list — never a blanket on/off switch) gates whether `GET /api/azure-devops/repo-check` (#90) — the one route whose Azure DevOps *location* is entirely caller-supplied per-request, not fixed at server startup — will honour a caller-supplied `?baseUrl=`. Left empty (the default, and what `gantry serve` uses), every request to that route talks to the real `https://dev.azure.com` regardless of what `baseUrl` a caller asks for, so a request can never direct this server to make an outbound HTTP call to a host of the caller's choosing (an SSRF vector `organization`/`project`/`repository` don't share, since those only ever become path segments under whichever host is actually used). A real on-premises-Azure-DevOps-Server deployment that needs callers to be able to name that server explicitly lists its exact base URL(s) here — this deliberately isn't a single boolean "trust callers with any host" flag: enabling support for one specific, known on-prem location must not also reopen the door to an arbitrary caller-chosen one.
 *
 * `options.allowAzureDevOpsBaseUrlOverride` (default `false`) is the same kind of guard, specifically for `POST /api/instances`'s own caller-supplied `azureDevOps.baseUrl` when *registering a new instance* — kept separate from `allowedAzureDevOpsBaseUrls` above (an allow-list, since `repo-check` might reasonably need to support more than one self-hosted Azure DevOps Server) rather than folded into it, since the two routes' trust models differ. Left `false` (the default), any `baseUrl` a caller supplies is rejected outright (400) rather than acted on: honoring an unvalidated, caller-chosen `baseUrl` here would let any HTTP caller register an Azure-DevOps-backed instance pointing at a server *they* control — and since `GET /api/instances` forwards *whatever PAT the current request carries* to every registered Azure-DevOps-backed entry in order to build the unified listing (see lib/registry.js's buildAzureDevOpsRow), that would let one caller register a location that silently exfiltrates every *other* caller's real Azure DevOps PAT to that attacker-controlled host the next time anyone loads the dashboard. Tests exercising the fake Azure DevOps server pass this flag explicitly; no real deployment should.
 */
export function createServer(options = {}) {
  // Package assets (web shell, bundled node_modules for the browser import map, the
  // built-in `definitions/`, the user-guide `docs/`) ship with the gantry install and
  // must resolve relative to it — not to `process.cwd()` — so `gantry serve` works from
  // any directory (WI #278). `lib/` sits one level under the package root.
  const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
  // `instances` is deployment *data*, not a package asset: it stays cwd-relative
  // (--instances-dir / GANTRY_INSTANCES_DIR, per WI #255). Do not make it pkgRoot-relative.
  //
  // WI #356: this is now the **workspaces root** — every server workspace (a `workspace.json`
  // folder, `lib/workspaceDirectory.js`, #355) lives directly under it, and so do the three JSON
  // registries. It is never any *one* instance's own directory any more.
  const instancesDir = options.instancesDir ?? 'instances'
  // WI #356: every locally-*created*-through-this-server instance lives under the one reserved
  // `default` server workspace (`lib/instanceRegistry.js`'s `MIGRATED_DEFAULT_WORKSPACE_FOLDER`) —
  // the same scope a pre-#356 bare local instance always implicitly used (`LOCAL_SCOPE`). Creating
  // (or addressing-for-creation) an instance directly into some other named server workspace over
  // HTTP is still a follow-on, not wired into `POST /api/instances` — but *reading* one that already
  // exists in any server workspace works today (WI #358): every single-instance route below resolves
  // its slug's actual directory per request via `resolveLocalDataDir`, not this fixed constant.
  const localInstancesDir = join(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER)
  // WI #356 acceptance criterion 2: a pre-#356 flat workspaces root (bare instance directories
  // directly under it) migrates into the `default` server workspace the first time a real server
  // starts against it. Opt-in (`options.migrateWorkspacesOnStart`, wired to `true` only by `gantry
  // serve` itself, bin/gantry.js) rather than automatic on every `createServer` call — many tests and
  // other CLI commands construct a server (or call registry functions) against this repo's own real
  // `instances/` directory, which must never be silently rewritten by running the test suite.
  if (options.migrateWorkspacesOnStart) {
    migrateLegacyWorkspaceDirectory(instancesDir)
    // The migration above only creates `default/workspace.json` when it actually has something to
    // move there — a server started against an already-empty or already-migrated workspaces root
    // still needs `default` to exist as a real, discoverable server workspace (its own marker file),
    // or an instance later created directly on disk under it (bypassing `POST /api/instances`'s own
    // explicit `registerInstance` call) would never be picked up by the registry's auto-backfill scan
    // (`lib/instanceRegistry.js`'s `scanDirectoryWorkspacesForInstances`, which only looks inside a
    // real `workspace.json` folder). Idempotent — never overwrites an existing marker.
    // WI #370: shared with `gantry new`, which has to create the same workspace for the same reason —
    // an instance placed in a folder with no `workspace.json` is invisible to every listing.
    ensureDefaultWorkspace(instancesDir)
  }
  const definitionsDir = options.definitionsDir ?? join(pkgRoot, 'definitions')
  const webDir = options.webDir ?? join(pkgRoot, 'web')
  const nodeModulesDir = options.nodeModulesDir ?? join(pkgRoot, 'node_modules')
  const docsDir = options.docsDir ?? join(pkgRoot, 'docs')
  const defaultSlug = options.slug
  // `Array.isArray` (not `?? []`) so a plausible misconfiguration — passing a bare string instead of a single-element array — can't silently degrade the exact-match allow-list check below into a *substring* check (`String.prototype.includes` rather than `Array.prototype.includes`). Anything other than a real array falls back to the same empty, fail-closed default as leaving the option off entirely.
  const allowedAzureDevOpsBaseUrls = Array.isArray(options.allowedAzureDevOpsBaseUrls)
    ? options.allowedAzureDevOpsBaseUrls
    : []
  // See this option's own note above, next to createServer's doc comment.
  const allowAzureDevOpsBaseUrlOverride = options.allowAzureDevOpsBaseUrlOverride ?? false

  const importMap = buildImportMap(FRONT_END_SPECIFIERS, { nodeModulesDir })

  function serveIndexHtml(req, res) {
    const html = readFileSync(join(webDir, 'index.html'), 'utf8').replace(
      '"__IMPORT_MAP__"',
      JSON.stringify(importMap)
    )
    // WI #368: the app shell is assembled per request (the import map is injected into it), so its
    // validator has to come from the bytes actually served rather than the file's own stat.
    const etag = `"${createHash('sha1').update(html).digest('hex')}"`
    if (notModified(req, etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' })
    res.end(html)
  }

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveIndexHtml(req, res)
        return
      }

      if (url.pathname.startsWith('/node_modules/')) {
        serveStaticFile(req, res, nodeModulesDir, url.pathname.slice('/node_modules/'.length))
        return
      }

      if (url.pathname === '/api/definitions' && req.method === 'GET') {
        const includeArchived = url.searchParams.get('archived') === '1'
        sendJSON(res, 200, listDefinitions({ definitionsDir, includeArchived }))
        return
      }

      // New definition: POST /api/definitions { sourceId, newId } clones; { newId, title } (no
      // sourceId) starts blank — the editor's New definition "Blank or Clone" choice (WI #381).
      if (url.pathname === '/api/definitions' && req.method === 'POST') {
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const sourceId = body?.sourceId
        const newId = body?.newId
        if (!newId || typeof newId !== 'string') {
          sendJSON(res, 400, { error: 'newId is required' })
          return
        }
        if (sourceId !== undefined && typeof sourceId !== 'string') {
          sendJSON(res, 400, { error: 'sourceId must be a string' })
          return
        }
        try {
          const result = sourceId
            ? cloneDefinition(sourceId, newId, { definitionsDir })
            : createBlankDefinition(newId, { definitionsDir, title: body?.title })
          sendJSON(res, 201, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // New draft version: POST /api/definitions/:id/versions
      const newDraftMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions$/)
      if (newDraftMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(newDraftMatch[1])
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (isDefinitionArchived(rawId, { definitionsDir })) {
          sendJSON(res, 400, { error: `Definition "${rawId}" is archived` })
          return
        }
        try {
          const result = createDraftVersion(rawId, { definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Archive / restore a definition (#237): marker file definitions/<id>/.archived
      const archiveMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/archive$/)
      if (archiveMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(archiveMatch[1])
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 404, { error: `Unknown definition "${rawId}"` })
          return
        }
        try {
          const result = archiveDefinition(rawId, { definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }
      const restoreMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/restore$/)
      if (restoreMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(restoreMatch[1])
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 404, { error: `Unknown definition "${rawId}"` })
          return
        }
        try {
          const result = restoreDefinition(rawId, { definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Publish a draft: POST /api/definitions/:id/versions/:n/publish
      // invoked post-merge in production; gantry does not open that PR.
      const publishMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/publish$/)
      if (publishMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(publishMatch[1])
        const rawVersion = decodeURIComponent(publishMatch[2])
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        try {
          const result = publishDefinitionVersion(rawId, vNum, { definitionsDir })
          if (result && result.problems) {
            sendJSON(res, 422, { problems: result.problems })
            return
          }
          sendJSON(res, 200, { ok: true, ...result })
        } catch (err) {
          if (err.problems) {
            sendJSON(res, 422, { problems: err.problems })
            return
          }
          const msg = err.message ?? ''
          if (/not a draft/i.test(msg)) {
            sendJSON(res, 409, { error: msg })
            return
          }
          if (/has no version|not found/i.test(msg)) {
            sendJSON(res, 404, { error: msg })
            return
          }
          if (/Unknown definition|Invalid definition version|Invalid version/i.test(msg)) {
            sendJSON(res, 400, { error: msg })
            return
          }
          sendJSON(res, 400, { error: msg })
        }
        return
      }

      // Templates: GET / PUT /api/definitions/:id/versions/:n/templates/:name (must precede changelog and generic version matcher)
      const templateMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/templates\/([^/]+)$/)
      if (templateMatch) {
        const rawId = decodeURIComponent(templateMatch[1])
        const rawVersion = decodeURIComponent(templateMatch[2])
        let rawName
        try {
          rawName = decodeURIComponent(templateMatch[3])
        } catch {
          sendJSON(res, 400, { error: `Invalid template name "${templateMatch[3]}"` })
          return
        }
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        if (!TEMPLATE_NAME_RE.test(rawName)) {
          sendJSON(res, 400, { error: `Invalid template name "${rawName}"` })
          return
        }
        const vNum = Number(rawVersion)
        if (req.method === 'GET') {
          try {
            const source = readDefinitionTemplate(rawId, vNum, rawName, { definitionsDir })
            if (source === null) {
              sendJSON(res, 404, { error: `Template "${rawName}" not found` })
              return
            }
            sendJSON(res, 200, { name: rawName, source })
          } catch (err) {
            const msg = err.message ?? ''
            if (/Invalid template name/i.test(msg)) {
              sendJSON(res, 400, { error: msg })
            } else if (/has no version|not found|Unknown definition|Invalid definition version/i.test(msg)) {
              // readDefinitionTemplate throws via resolveDefinitionDir; treat missing version as 404 like other version routes, but spec says 400 for bad version; however readDefinitionTemplate already validated version numeric; has no version => 404?
              // For consistency with existing version routes, missing version is 404 after known id check; but spec says GET with bad version =>400. The initial check above already handled non-numeric; this handles version not existing.
              if (/has no version/i.test(msg)) sendJSON(res, 404, { error: msg })
              else sendJSON(res, 400, { error: msg })
            } else {
              sendJSON(res, 400, { error: msg })
            }
          }
          return
        }
        if (req.method === 'PUT') {
          const rawBody = await readBody(req)
          if (rawBody.length > 512 * 1024) {
            sendJSON(res, 413, { error: 'Request body too large' })
            return
          }
          let body
          try {
            body = rawBody ? JSON.parse(rawBody) : null
          } catch {
            sendJSON(res, 400, { error: 'Invalid JSON body' })
            return
          }
          if (!body || typeof body.source !== 'string') {
            sendJSON(res, 400, { error: 'Body must include source string' })
            return
          }
          // Draft-only check via reading definition.yaml before writing; distinguish 409 vs 400 vs 404
          // Use loadDefinition to check draft status for existing version dir; if version doesn't exist treat as 404
          try {
            const existing = loadDefinition(rawId, { version: vNum, definitionsDir })
            if (existing.status !== 'draft') {
              sendJSON(res, 409, { error: `Version ${vNum} of "${rawId}" is not a draft (status: ${existing.status})` })
              return
            }
          } catch (err) {
            const msg = err.message ?? ''
            if (/has no version|not found/i.test(msg)) {
              sendJSON(res, 404, { error: msg })
            } else {
              sendJSON(res, 400, { error: msg })
            }
            return
          }
          try {
            const result = writeDefinitionTemplate(rawId, vNum, rawName, body.source, { definitionsDir })
            sendJSON(res, 200, { ok: true, name: result.name })
          } catch (err) {
            if (err.compileError) {
              sendJSON(res, 422, { error: err.compileError })
              return
            }
            const msg = err.message ?? ''
            if (/not a draft/i.test(msg)) {
              sendJSON(res, 409, { error: msg })
              return
            }
            if (/Invalid template name/i.test(msg)) {
              sendJSON(res, 400, { error: msg })
              return
            }
            if (/Invalid definition version|Unknown definition/i.test(msg)) {
              sendJSON(res, 400, { error: msg })
              return
            }
            sendJSON(res, 400, { error: msg })
          }
          return
        }
      }

      // Reference docx: GET / PUT /api/definitions/:id/versions/:n/artefacts/:artefactId/reference-docx
      // (WI #385, must precede changelog and generic version matcher, same as templates above).
      // Replace (upload)/Download for an artefact's reference `.docx` — the Word styling template
      // pandoc merges into its rendered output (lib/render.js's `renderArtefactBody`, which already
      // resolves `templates/reference-<artefactId>.docx`; see lib/definition.js's
      // readDefinitionReferenceDocx/writeDefinitionReferenceDocx for why that exact path is reused
      // here rather than inventing a second one). Modelled on the template route directly above:
      // same known-id/version checks, same draft-only/published-immutable guard on PUT, same error
      // shape. Only the storage differs — binary, not JSON `source` text, so PUT accepts a
      // `docxBase64` field (matching the base64-over-JSON convention this server already uses for
      // binary payloads — see the render-wasm-finish route's `docxBase64`) and GET streams the raw
      // bytes back with a download-triggering Content-Disposition instead of wrapping them in JSON.
      const referenceDocxMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/artefacts\/([^/]+)\/reference-docx$/)
      if (referenceDocxMatch) {
        const rawId = decodeURIComponent(referenceDocxMatch[1])
        const rawVersion = decodeURIComponent(referenceDocxMatch[2])
        let artefactId
        try {
          artefactId = decodeURIComponent(referenceDocxMatch[3])
        } catch {
          sendJSON(res, 400, { error: `Invalid artefact id "${referenceDocxMatch[3]}"` })
          return
        }
        const knownIds = new Set(listDefinitions({ definitionsDir, includeArchived: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        if (!isValidSlug(artefactId)) {
          sendJSON(res, 400, { error: `Invalid artefact id "${artefactId}"` })
          return
        }
        const vNum = Number(rawVersion)
        if (req.method === 'GET') {
          try {
            const bytes = readDefinitionReferenceDocx(rawId, vNum, artefactId, { definitionsDir })
            if (bytes === null) {
              sendJSON(res, 404, { error: `No reference .docx uploaded for artefact "${artefactId}"` })
              return
            }
            res.writeHead(200, {
              'Content-Type': REFERENCE_DOCX_MIME,
              'Content-Disposition': `attachment; filename="reference-${artefactId}.docx"`,
              'Content-Length': String(bytes.length),
              'Cache-Control': 'no-cache',
            })
            res.end(bytes)
          } catch (err) {
            const msg = err.message ?? ''
            if (/has no version/i.test(msg)) {
              sendJSON(res, 404, { error: msg })
            } else {
              sendJSON(res, 400, { error: msg })
            }
          }
          return
        }
        if (req.method === 'PUT') {
          let rawBody
          try {
            rawBody = await readBodyWithLimit(req, MAX_REFERENCE_DOCX_BODY_BYTES)
          } catch (err) {
            if (err.tooLarge) {
              sendJSON(res, 413, { error: `Request body exceeds the ${MAX_REFERENCE_DOCX_BODY_BYTES}-byte limit` })
              return
            }
            sendJSON(res, 400, { error: 'Failed to read request body' })
            return
          }
          let body
          try {
            body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null
          } catch {
            sendJSON(res, 400, { error: 'Invalid JSON body' })
            return
          }
          if (!body || typeof body.docxBase64 !== 'string') {
            sendJSON(res, 400, { error: 'Body must include docxBase64' })
            return
          }
          let buffer
          try {
            buffer = Buffer.from(body.docxBase64, 'base64')
          } catch {
            sendJSON(res, 400, { error: 'Invalid base64 in docxBase64' })
            return
          }
          try {
            const result = writeDefinitionReferenceDocx(rawId, vNum, artefactId, buffer, { definitionsDir })
            sendJSON(res, 200, { ok: true, name: result.name })
          } catch (err) {
            const msg = err.message ?? ''
            if (/not a draft/i.test(msg)) {
              sendJSON(res, 409, { error: msg })
              return
            }
            if (err.invalidDocx) {
              sendJSON(res, 422, { error: msg })
              return
            }
            sendJSON(res, 400, { error: msg })
          }
          return
        }
      }

      const changelogMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/changelog$/)
      if (changelogMatch && req.method === 'GET') {
        const rawId = decodeURIComponent(changelogMatch[1])
        const rawVersion = decodeURIComponent(changelogMatch[2])
        const knownIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        const vNum = Number(rawVersion)
        if (!Number.isInteger(vNum) || vNum < 1 || !/^\d+$/.test(rawVersion)) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        try {
          const changelog = loadDefinitionChangelog(rawId, vNum, { definitionsDir })
          sendJSON(res, 200, { version: vNum, changelog })
        } catch (err) {
          const msg = err.message ?? ''
          if (/has no version|not found/i.test(msg)) {
            sendJSON(res, 404, { error: msg })
          } else if (/Unknown definition|Invalid definition version|Invalid version/i.test(msg)) {
            sendJSON(res, 400, { error: msg })
          } else {
            sendJSON(res, 404, { error: msg })
          }
        }
        return
      }

      // Live validation for the definition editor's unsaved draft (WI #381): the same structural
      // rules Save/Publish enforce (`findDefinitionProblemsInStructure`, shared with
      // `findDefinitionProblems`'s disk-based rule set), run directly against the posted draft with
      // no disk read/write — so the editor can call this on every change for its outline/map markers
      // and toolbar problems count without the cost of a real validate-then-write temp directory.
      // Must precede the generic `definitionVersionMatch` PUT/GET below, same as templateMatch/changelogMatch.
      const validateMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/validate$/)
      if (validateMatch && req.method === 'POST') {
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : {}
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const problems = findDefinitionProblemsInStructure(body ?? {})
        sendJSON(res, 200, { problems })
        return
      }

      const definitionVersionMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)$/)
      if (definitionVersionMatch && req.method === 'GET') {
        const rawId = decodeURIComponent(definitionVersionMatch[1])
        const rawVersion = decodeURIComponent(definitionVersionMatch[2])
        const knownIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        try {
          const def = loadDefinition(rawId, { version: vNum, definitionsDir })
          sendJSON(res, 200, definitionVersionProjection(def))
        } catch (err) {
          const msg = err.message ?? ''
          if (/has no version|not found/i.test(msg)) {
            sendJSON(res, 404, { error: msg })
          } else if (/Unknown definition|Invalid definition version|Invalid version/i.test(msg)) {
            sendJSON(res, 400, { error: msg })
          } else {
            sendJSON(res, 404, { error: msg })
          }
        }
        return
      }

      if (definitionVersionMatch && req.method === 'PUT') {
        const rawId = decodeURIComponent(definitionVersionMatch[1])
        const rawVersion = decodeURIComponent(definitionVersionMatch[2])
        const knownIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        // Size-capped body read (follow existing PUT pattern)
        const rawBody = await readBody(req)
        if (rawBody.length > 512 * 1024) {
          sendJSON(res, 413, { error: 'Request body too large' })
          return
        }
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        if (!body || typeof body !== 'object' || !Array.isArray(body.stages) || !Array.isArray(body.artefacts) || !Array.isArray(body.modules)) {
          sendJSON(res, 400, { error: 'Body must include stages, artefacts, and modules arrays' })
          return
        }
        // Draft-only guard: published versions are immutable
        try {
          const existing = loadDefinition(rawId, { version: vNum, definitionsDir })
          if (existing.status !== 'draft') {
            sendJSON(res, 409, { error: `Version ${vNum} of "${rawId}" is not a draft (status: ${existing.status})` })
            return
          }
        } catch (err) {
          const msg = err.message ?? ''
          if (/has no version|not found/i.test(msg)) {
            sendJSON(res, 404, { error: msg })
          } else {
            sendJSON(res, 400, { error: msg })
          }
          return
        }
        try {
          const result = writeDefinitionVersion(rawId, vNum, body, { definitionsDir })
          // writeDefinitionVersion returns { problems } on validation failure (validate-then-write)
          if (result && result.problems) {
            sendJSON(res, 422, { problems: result.problems })
            return
          }
          sendJSON(res, 200, { ok: true, ...result })
        } catch (err) {
          if (err.problems) {
            sendJSON(res, 422, { problems: err.problems })
            return
          }
          const msg = err.message ?? ''
          if (/not a draft/i.test(msg)) {
            sendJSON(res, 409, { error: msg })
            return
          }
          if (/Invalid module id|Invalid slug/i.test(msg)) {
            sendJSON(res, 400, { error: msg })
            return
          }
          // Well-formed-but-invalid structural problems surfaced as problems array already handled; fallback 400
          if (/Unknown|Invalid/i.test(msg)) {
            sendJSON(res, 400, { error: msg })
            return
          }
          sendJSON(res, 400, { error: msg })
        }
        return
      }

      if (url.pathname === '/api/user-guide' && req.method === 'GET') {
        const markdownPath = join(docsDir, 'user-guide', 'index.md')
        if (!existsSync(markdownPath)) {
          sendJSON(res, 404, { error: 'User Guide not found' })
          return
        }
        const guide = renderUserGuide(readFileSync(markdownPath, 'utf8'), loadDefinition('design', { definitionsDir }))
        sendJSON(res, 200, { markdown: guide })
        return
      }

      // The workspace registry (#96): every workspace gantry knows about — each one an Azure DevOps organization/project/repository tuple, with its own owner and ticketing-system setting. Read-only listing; no PAT is required or consulted (no PAT is ever stored here — see lib/workspaceRegistry.js's own doc comment).
      if (url.pathname === '/api/workspaces' && req.method === 'GET') {
        // `?archived=1` (#223) — the "show archived / restore" view: includes archived workspaces
        // too (each carrying `archived: true`). Without it, archived workspaces are absent, so the
        // dashboard's workspace grouping is unchanged from before #223.
        const includeArchived = url.searchParams.get('archived') === '1'
        // `number` (WI200, docs/adr/0024) — assigned lazily, same as an instance's own numeric ref, so a workspace registered before this feature shipped still gets numbered the first time anything lists workspaces.
        sendJSON(
          res,
          200,
          listWorkspaces({ instancesDir, includeArchived }).map((workspace) => ({
            ...workspace,
            number: getOrAssignWorkspaceNumber(workspace.id, { instancesDir }),
          }))
        )
        return
      }

      // Registers a new workspace directly — the primitive the future Settings screen (#101/#104) will build on. Structural validation errors (missing organization/project/repository, or an unsupported `ticketingSystem` such as `jira`) are checked first and reported as 400 with no network cost, exactly like every other validating route in this file. Unlike a plain metadata store, though, this route *establishes* an Azure DevOps location the same way `POST /api/instances`/`POST /api/instances/adopt` already do — so it requires the caller's own PAT (the same credential-provider seam, #86) and actually proves that PAT against this exact organization/project/repository via `checkAzureDevOpsRepo` (the same check `/api/instances/adopt` already performs) before persisting anything. Without this, any caller with mere network access to this server — no credential needed at all — could register a workspace (or, since organization/project/repository aren't unique here, have it silently reused by a later legitimate registration for the exact same repo via `getOrCreateWorkspace`'s tuple matching) carrying a spoofed `owner`/`baseUrl` for a repo it has no real access to. `baseUrl` is gated behind the same `allowAzureDevOpsBaseUrlOverride` flag every other caller-supplied `baseUrl` in this file already requires, for the same SSRF-prevention reason documented on that option above.
      if (url.pathname === '/api/workspaces' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const { organization, project, repository, baseUrl, owner, ticketingSystem } = body ?? {}

        const missingFields = ['organization', 'project', 'repository'].filter(
          (key) => !{ organization, project, repository }[key]
        )
        if (missingFields.length) {
          sendJSON(res, 400, { error: `A workspace is missing: ${missingFields.join(', ')}` })
          return
        }

        try {
          assertValidTicketingSystem(ticketingSystem ?? DEFAULT_TICKETING_SYSTEM)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
          return
        }

        // See createServer's own doc comment on allowAzureDevOpsBaseUrlOverride.
        if (baseUrl !== undefined && !allowAzureDevOpsBaseUrlOverride) {
          sendJSON(res, 400, { error: 'azureDevOps.baseUrl overrides are not permitted on this server' })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          // A location check, not an instance check — whether this repo already holds instance data ('found') or not ('empty') is irrelevant here; only a rejected PAT changes this route's response.
          await checkAzureDevOpsRepo({ organization, project, repository, baseUrl, pat, definitionsDir })
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          if (err instanceof AzureDevOpsRepoNotFoundError) {
            sendJSON(res, 400, { error: err.message })
            return
          }
          throw err
        }

        try {
          const existing = findWorkspaceByLocation({ organization, project, repository, baseUrl }, { instancesDir })
          const workspace = getOrCreateWorkspace({ organization, project, repository, baseUrl, owner, ticketingSystem }, { instancesDir })
          // Assigned at creation time (WI200, docs/adr/0024), not just lazily on next read — a freshly-registered workspace's own number is immediately known to this response's caller.
          const number = getOrAssignWorkspaceNumber(workspace.id, { instancesDir })
          if (existing) {
            sendJSON(res, 200, { ...workspace, number, reused: true })
          } else {
            sendJSON(res, 201, { ...workspace, number })
          }
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Updates a workspace's `owner` and/or `ticketingSystem` — the Settings screen's Workspace tab (#104): owner can be viewed/edited there, and a workspace's ticketing system can be overridden away from whatever the global default was at the moment the workspace was created. Deliberately narrower than `registerWorkspace`'s own field set — `organization`/`project`/`repository`/`baseUrl` are not accepted here, since changing *those* would re-point an already-established workspace at a different Azure DevOps location, which (unlike a plain metadata edit) would need the same real-access proof `POST /api/workspaces` requires; that's out of this ticket's scope, so it's simply not an accepted field on this route rather than a security hole. No PAT is required or consulted, for the same reason `GET /api/workspaces` doesn't: neither `owner` nor `ticketingSystem` is used to establish or prove Azure DevOps access, only to record metadata this server already trusts itself to serve.
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
      if (workspaceMatch && req.method === 'PATCH') {
        const id = decodeURIComponent(workspaceMatch[1])
        const body = JSON.parse(await readBody(req))
        const updates = {}
        if (body && typeof body === 'object') {
          // `owner` must be a string (or omitted) — `workspaceRegistry.js`'s own "optional, blank until set" convention is `''`, never `null`/a number/an object; guarding the type here (rather than letting a non-string value straight through to `updateWorkspace`) avoids silently persisting a value that diverges from that convention, e.g. an explicit `owner: null` being stored as `null` instead of normalizing to `''` the way an *omitted* `owner` already does.
          if (body.owner !== undefined) {
            if (typeof body.owner !== 'string') {
              sendJSON(res, 400, { error: 'owner must be a string' })
              return
            }
            updates.owner = body.owner
          }
          if (body.ticketingSystem !== undefined) updates.ticketingSystem = body.ticketingSystem
        }

        try {
          const workspace = updateWorkspace(id, updates, { instancesDir })
          sendJSON(res, 200, workspace)
        } catch (err) {
          if (/^Unknown workspace/.test(err.message)) {
            sendJSON(res, 404, { error: err.message })
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Archive / restore a workspace (#223): archiving only removes the workspace from the
      // default dashboard listing — nothing on disk is deleted, and `restore` brings it back to
      // exactly its prior state. No PAT is required or consulted, for the same reason
      // `PATCH /api/workspaces/:id` doesn't: archived-ness is registry metadata this server
      // already trusts itself to serve, never used to establish or prove Azure DevOps access.
      //
      // Decision (#223): archiving a workspace does NOT cascade-archive its instances, and is
      // BLOCKED (409) while the workspace still has any active (non-archived) instance — archive
      // or restore those first. This keeps "archived" meaning the same thing at both levels (an
      // item deliberately set aside) rather than letting a workspace vanish from the dashboard
      // while instances it owns are still live. `restore` has no such guard.
      if (url.pathname === '/api/workspace/archive' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const workspaceId = body?.workspaceId
        if (!workspaceId || typeof workspaceId !== 'string') {
          sendJSON(res, 400, { error: 'workspaceId is required' })
          return
        }
        if (!resolveWorkspace(workspaceId, { instancesDir })) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        // Idempotent — an already-archived workspace is a success, not a conflict (and the
        // active-instance guard below is irrelevant once it's already archived).
        if (isWorkspaceArchived(workspaceId, { instancesDir })) {
          sendJSON(res, 200, { ...resolveWorkspace(workspaceId, { instancesDir }), archived: true })
          return
        }
        // The "block archiving a workspace with active instances" rule (#223): every registered
        // instance — including archived ones, so they don't count against this — mapped back to
        // its workspace id; any that resolves to this workspace and is not itself archived blocks.
        const activeInstances = listRegisteredInstances({ instancesDir, includeArchived: true })
          .filter((entry) => !entry.archived)
          .filter((entry) => entry.scopeId === workspaceId)
          .map((entry) => entry.slug)
        if (activeInstances.length) {
          sendJSON(res, 409, {
            error:
              `Cannot archive workspace "${workspaceId}" — it still has ${activeInstances.length} active ` +
              `instance${activeInstances.length === 1 ? '' : 's'} (${activeInstances.join(', ')}). ` +
              'Archive or restore those first.',
          })
          return
        }
        try {
          sendJSON(res, 200, archiveWorkspace(workspaceId, { instancesDir }))
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      if (url.pathname === '/api/workspace/restore' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const workspaceId = body?.workspaceId
        if (!workspaceId || typeof workspaceId !== 'string') {
          sendJSON(res, 400, { error: 'workspaceId is required' })
          return
        }
        if (!resolveWorkspace(workspaceId, { instancesDir })) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        try {
          // Idempotent — restoring a workspace that isn't archived is a no-op success.
          sendJSON(res, 200, restoreWorkspace(workspaceId, { instancesDir }))
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Archive / restore an instance (#223): same contract as the workspace pair above — archiving
      // only removes it from the default dashboard listing, its data (local files, or its Azure
      // DevOps repo) is retained untouched, and `restore` brings it back to exactly its prior
      // state. No PAT is required or consulted: archived-ness is instance-registry metadata, not
      // an Azure DevOps operation, so this works identically for a local and a Workspace-backed
      // instance. `slug` goes through the same single-path-segment check every other slug from
      // request input does.
      if (url.pathname === '/api/instance/archive' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const slug = body?.slug
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        if (!resolveInstanceLocation(slug, { instancesDir })) {
          sendJSON(res, 404, { error: `Unknown instance "${slug}"` })
          return
        }
        try {
          // Idempotent — an already-archived instance is a success, not a conflict.
          sendJSON(res, 200, archiveInstance(slug, { instancesDir }))
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      if (url.pathname === '/api/instance/restore' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const slug = body?.slug
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        if (!resolveInstanceLocation(slug, { instancesDir })) {
          sendJSON(res, 404, { error: `Unknown instance "${slug}"` })
          return
        }
        try {
          // Idempotent — restoring an instance that isn't archived is a no-op success.
          sendJSON(res, 200, restoreInstance(slug, { instancesDir }))
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      if (url.pathname === '/api/instances' && req.method === 'GET') {
        // A PAT is optional here, not required: this route has never gated on a credential the way the single-instance routes do (#86), so a request with none simply sees every local instance plus any Azure-DevOps-backed one it happens to already be able to authenticate to — see lib/registry.js's buildAzureDevOpsRow for why an entry it can't read is left out rather than failing the whole listing.
        const pat = getCredential(req)
        // `?archived=1` (#223) — the "show archived / restore" view: includes archived instances
        // too, each row then carrying an `archived` boolean. Without it, archived instances are
        // absent and no row has that key, so the default listing is unchanged from before #223.
        const includeArchived = url.searchParams.get('archived') === '1'
        sendJSON(res, 200, await listRegistry({ instancesDir, definitionsDir, pat, includeArchived }))
        return
      }

      // Registers a new instance — the instance-setup wizard's (#78) "empty repo" path, extended by #93 to optionally register a new Azure-DevOps-backed instance instead of a local one: given an `azureDevOps: { organization, project, repository, baseUrl? }` location alongside the usual `definition`/`slug`/`owner`, this delegates to `createInstance`'s already-existing Azure DevOps branch (#85) — writing a real instance.yaml + first-stage module files to that repo — instead of local `instancesDir`, then registers that location in the instance registry (#89) so it's immediately resolvable and shows up in this same route's own GET listing afterward. Without `azureDevOps` in the body, behavior is byte-for-byte unchanged from before #93: a local instance, left for the registry's own auto-backfill to pick up the next time anything reads it (never registered directly here — createInstance's local path doesn't know about the registry at all, by design; see lib/instanceRegistry.js).
      //
      // `slug` goes through the same single-path-segment check as every other slug arriving from request input (see isValidSlug's own comment). `definition` gets an equivalent guard of its own: it must exactly match one of `listDefinitions()`'s real, known ids — never passed through to `createInstance`/`loadDefinition` unchecked. Without this, `definition` (unlike `slug`) had no path-traversal guard at all: `loadDefinition` resolves it as `join(definitionsDir, definitionId)`, so a value like `../../../../tmp/evil` would read (and, paired with a crafted `definition.yaml` whose own `id` field echoes the same traversal string back, fully register an instance against) an arbitrary directory outside `definitionsDir` — the same class of bug `isValidSlug` exists to prevent for `slug`, just not yet applied to this second request-controlled input.
      //
      // An `azureDevOps` location missing `organization`/`project`/`repository` is a 400, same as an invalid slug/definition. Writing to Azure DevOps needs the caller's own PAT (lib/credential.js's `getCredential(req)`, the same seam every other Azure-DevOps-backed route already uses) — absent, or rejected by Azure DevOps itself, this returns the same structured "authentication required" response as those routes, never a generic error.
      //
      // `createInstance` itself still rejects a slug that already has an instance on disk/in that Azure DevOps repo, reported as 409 rather than the 500 the outer catch would otherwise give.
      if (url.pathname === '/api/instances' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        // `owner` seeds each first-stage module file's own frontmatter `owner` (the separate Design Authority sign-off convention, untouched by #97); `assignee` sets the instance record's own stored assignee (#97) — a caller may supply either, both, or neither.
        // `definitionVersion` pins the instance to a specific definition version (#231); absent defaults to latest published, "latest" string also maps to latest published.
        const { definition: definitionId, slug, owner, assignee, azureDevOps, definitionVersion: rawDefinitionVersion, version: rawVersion } = body ?? {}
        let requestedVersion = rawDefinitionVersion ?? rawVersion ?? null
        // Accept "latest" string as latest published
        if (requestedVersion === 'latest') requestedVersion = null
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        if (definitionId && isDefinitionArchived(definitionId, { definitionsDir })) {
          sendJSON(res, 409, { error: `Definition "${definitionId}" is archived` })
          return
        }
        const defs = listDefinitions({ definitionsDir })
        const knownDefinitionIds = new Set(defs.map((d) => d.id))
        if (!knownDefinitionIds.has(definitionId)) {
          sendJSON(res, 400, { error: `Unknown definition "${definitionId}"` })
          return
        }

        // Resolve requested definition version (#231): explicit integer (draft allowed) or latest published when absent/"latest"
        let definitionVersionToUse = null
        if (requestedVersion !== null && requestedVersion !== undefined && requestedVersion !== '') {
          const parsed = Number(requestedVersion)
          if (!Number.isInteger(parsed) || parsed < 1) {
            sendJSON(res, 400, { error: `Invalid definitionVersion "${requestedVersion}"` })
            return
          }
          const defRow = defs.find((d) => d.id === definitionId)
          if (!defRow.versions.some((v) => v.version === parsed)) {
            sendJSON(res, 400, { error: `Definition "${definitionId}" has no version ${parsed}` })
            return
          }
          definitionVersionToUse = parsed
        } else {
          const defRow = defs.find((d) => d.id === definitionId)
          definitionVersionToUse = defRow.latestPublished ?? defRow.versions[defRow.versions.length - 1]?.version ?? 1
        }

        // A slug already known to the instance registry — whether local (on disk, or auto-backfilled from it) or Azure-DevOps-backed, and regardless of which kind *this* request is trying to create — is a 409, checked before either branch below ever calls createInstance. Without this, a slug collision across backends (e.g. registering an azureDevOps location under a slug some local instance already uses, or vice versa) wasn't caught at all: createInstance's own "already exists" check only ever looks at the *one* backend the current request is writing to, so it silently overwrote the registry's existing entry for that slug — orphaning whichever instance's data the registry no longer pointed at.
        if (resolveInstanceLocation(slug, { instancesDir })) {
          sendJSON(res, 409, { error: `Instance "${slug}" already exists` })
          return
        }

        if (azureDevOps !== undefined) {
          if (typeof azureDevOps !== 'object' || azureDevOps === null) {
            sendJSON(res, 400, { error: 'azureDevOps must be an object with organization, project, and repository' })
            return
          }
          const missingFields = ['organization', 'project', 'repository'].filter((key) => !azureDevOps[key])
          if (missingFields.length) {
            sendJSON(res, 400, { error: `azureDevOps location is missing: ${missingFields.join(', ')}` })
            return
          }
          // See createServer's own doc comment on allowAzureDevOpsBaseUrlOverride: an unvalidated, caller-chosen baseUrl must never be honored on a real deployment — only tests (against the fake Azure DevOps server) opt into this.
          if (azureDevOps.baseUrl !== undefined && !allowAzureDevOpsBaseUrlOverride) {
            sendJSON(res, 400, { error: 'azureDevOps.baseUrl overrides are not permitted on this server' })
            return
          }

          const pat = getCredential(req)
          if (!pat) {
            sendAuthenticationRequired(res)
            return
          }

          const location = {
            organization: azureDevOps.organization,
            project: azureDevOps.project,
            repository: azureDevOps.repository,
            ...(allowAzureDevOpsBaseUrlOverride && azureDevOps.baseUrl ? { baseUrl: azureDevOps.baseUrl } : {}),
          }
          try {
            await createInstance(definitionId, slug, { definitionsDir, owner, assignee, definitionVersion: definitionVersionToUse, azureDevOps: { ...location, pat } })
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              sendAuthenticationRequired(res)
              return
            }
            if (err instanceof AzureDevOpsRepoNotFoundError) {
              sendJSON(res, 400, { error: err.message })
              return
            }
            const status = /already exists/.test(err.message) ? 409 : 400
            sendJSON(res, status, { error: err.message })
            return
          }
          registerInstance(slug, { kind: 'azureDevOps', ...location }, { instancesDir })
          const created = (await listRegistry({ instancesDir, definitionsDir, pat })).find((i) => i.slug === slug)
          sendJSON(res, 201, created)
          return
        }

        try {
          createInstance(definitionId, slug, { instancesDir: localInstancesDir, definitionsDir, owner, assignee, definitionVersion: definitionVersionToUse })
        } catch (err) {
          const status = /already exists/.test(err.message) ? 409 : 400
          sendJSON(res, status, { error: err.message })
          return
        }
        // WI #356: a local instance's registry entry is no longer auto-backfilled from a bare
        // directory scan (the registry only auto-discovers instances already inside a real server
        // workspace folder) — it must be registered explicitly, exactly like an Azure-DevOps-backed
        // one a few lines above.
        registerInstance(slug, { kind: 'directory', workspace: MIGRATED_DEFAULT_WORKSPACE_FOLDER }, { instancesDir })
        const created = (await listRegistry({ instancesDir, definitionsDir })).find((i) => i.slug === slug)
        sendJSON(res, 201, created)
        return
      }

      // WI #305 — imports a local-workspace instance's real content into a
      // Server-hosted (Azure DevOps) workspace: same slug/definition/version
      // validation and slug-conflict 409 as POST /api/instances above, but
      // always Azure-DevOps-backed (a local workspace is addressed
      // client-side only, ADR-0029 — there is no server route to import
      // *into* one) and writes the caller-supplied stage/modules/assets
      // verbatim via lib/instance.js's importInstanceToAzureDevOps instead
      // of a blank first-stage template. The wizard (web/pages/new-workspace-
      // wizard.js) is the only caller: it reads the source local instance's
      // instance.yaml/modules/assets through the File System Access API
      // client-side, then POSTs the real content here.
      if (url.pathname === '/api/instances/import' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const {
          definition: definitionId,
          slug,
          assignee,
          azureDevOps,
          definitionVersion: rawDefinitionVersion,
          stage,
          modules,
          assets,
        } = body ?? {}
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        if (definitionId && isDefinitionArchived(definitionId, { definitionsDir })) {
          sendJSON(res, 409, { error: `Definition "${definitionId}" is archived` })
          return
        }
        const defs = listDefinitions({ definitionsDir })
        const knownDefinitionIds = new Set(defs.map((d) => d.id))
        if (!knownDefinitionIds.has(definitionId)) {
          sendJSON(res, 400, { error: `Unknown definition "${definitionId}"` })
          return
        }

        let requestedVersion = rawDefinitionVersion ?? null
        if (requestedVersion === 'latest') requestedVersion = null
        let definitionVersionToUse
        if (requestedVersion !== null && requestedVersion !== undefined && requestedVersion !== '') {
          const parsed = Number(requestedVersion)
          if (!Number.isInteger(parsed) || parsed < 1) {
            sendJSON(res, 400, { error: `Invalid definitionVersion "${requestedVersion}"` })
            return
          }
          const defRow = defs.find((d) => d.id === definitionId)
          if (!defRow.versions.some((v) => v.version === parsed)) {
            sendJSON(res, 400, { error: `Definition "${definitionId}" has no version ${parsed}` })
            return
          }
          definitionVersionToUse = parsed
        } else {
          const defRow = defs.find((d) => d.id === definitionId)
          definitionVersionToUse = defRow.latestPublished ?? defRow.versions[defRow.versions.length - 1]?.version ?? 1
        }

        // Same cross-backend slug-conflict guard as POST /api/instances — checked before any write, so an import can never silently overwrite an existing instance (local or Azure-DevOps-backed) at the destination slug.
        if (resolveInstanceLocation(slug, { instancesDir })) {
          sendJSON(res, 409, { error: `Instance "${slug}" already exists` })
          return
        }

        if (typeof azureDevOps !== 'object' || azureDevOps === null) {
          sendJSON(res, 400, { error: 'azureDevOps must be an object with organization, project, and repository' })
          return
        }
        const missingFields = ['organization', 'project', 'repository'].filter((key) => !azureDevOps[key])
        if (missingFields.length) {
          sendJSON(res, 400, { error: `azureDevOps location is missing: ${missingFields.join(', ')}` })
          return
        }
        // See createServer's own doc comment on allowAzureDevOpsBaseUrlOverride.
        if (azureDevOps.baseUrl !== undefined && !allowAzureDevOpsBaseUrlOverride) {
          sendJSON(res, 400, { error: 'azureDevOps.baseUrl overrides are not permitted on this server' })
          return
        }
        if (!Array.isArray(modules) || modules.some((m) => typeof m?.id !== 'string' || typeof m?.text !== 'string')) {
          sendJSON(res, 400, { error: 'modules must be an array of { id, text }' })
          return
        }
        if (
          assets !== undefined &&
          (!Array.isArray(assets) || assets.some((a) => typeof a?.filename !== 'string' || typeof a?.base64 !== 'string'))
        ) {
          sendJSON(res, 400, { error: 'assets must be an array of { filename, base64 }' })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        const location = {
          organization: azureDevOps.organization,
          project: azureDevOps.project,
          repository: azureDevOps.repository,
          ...(allowAzureDevOpsBaseUrlOverride && azureDevOps.baseUrl ? { baseUrl: azureDevOps.baseUrl } : {}),
        }
        try {
          await importInstanceToAzureDevOps(definitionId, slug, {
            definitionsDir,
            assignee,
            definitionVersion: definitionVersionToUse,
            stage,
            modules,
            assets: assets ?? [],
            azureDevOps: { ...location, pat },
          })
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          if (err instanceof AzureDevOpsRepoNotFoundError) {
            sendJSON(res, 400, { error: err.message })
            return
          }
          const status = /already exists/.test(err.message) ? 409 : 400
          sendJSON(res, status, { error: err.message })
          return
        }
        registerInstance(slug, { kind: 'azureDevOps', ...location }, { instancesDir })
        const created = (await listRegistry({ instancesDir, definitionsDir, pat })).find((i) => i.slug === slug)
        sendJSON(res, 201, created)
        return
      }

      // The instance-setup wizard's (#78) "live repo check" — given an Azure DevOps location (never a gantry slug: this is answering "what's in this specific remote repo", not "is this already known to gantry", so it deliberately never touches instancesDir or lib/registry.js, #89) and the caller's own PAT, reports whether that location already holds instance data (#90, under #88). Read-only, no side effects. Gated behind the same credential-provider seam (#86) as the single-instance Azure-DevOps-backed routes below — a missing PAT, or one Azure DevOps itself rejects, gets the identical structured "authentication required" response.
      if (url.pathname === '/api/azure-devops/repo-check' && req.method === 'GET') {
        const organization = url.searchParams.get('organization')
        const project = url.searchParams.get('project')
        const repository = url.searchParams.get('repository')
        const missing = ['organization', 'project', 'repository'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        // `|| undefined` (not `?? undefined`) so an explicit-but-empty `?baseUrl=` is treated the same as an absent one, rather than being passed through as `''` and bypassing createAzureDevOpsClient's own `= DEFAULT_BASE_URL` default parameter (which only applies to `undefined`).
        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(requestedBaseUrl)) {
          // Unlike `organization`/`project`/`repository` (which only ever become path segments under whatever host is used), `baseUrl` picks the outbound request's actual network destination. With no matching entry in the server's own `allowedAzureDevOpsBaseUrls` allow-list, honouring an arbitrary caller-supplied `baseUrl` here would let any request direct this server to make outbound HTTP calls to a host of the caller's own choosing (internal services included) — an SSRF vector unique to this route, since every other Azure-DevOps-backed route only ever uses a `baseUrl` the server operator fixed at startup. Rejected outright rather than silently ignored: silently checking the real dev.azure.com instead would misreport an on-premises caller's own location as empty/unreachable rather than telling them the check they asked for wasn't the one that ran.
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a self-hosted Azure DevOps Server instance.',
          })
          return
        }

        await withAzureDevOpsCredential(
          req,
          res,
          { organization, project, repository, baseUrl: requestedBaseUrl },
          async (azureDevOps) => {
            const result = await checkAzureDevOpsRepo({ ...azureDevOps, definitionsDir })
            sendJSON(res, 200, result)
          }
        )
        return
      }

      // Adopts an Azure-DevOps-backed instance the setup wizard's (#78) own repo-check (#90) already found data at — registering that location in the instance registry (#89) so it becomes resolvable the same way a freshly-created one is, without writing anything. A companion to `POST /api/instances`'s create-and-register path (#93), but for the opposite intent: that route's own "instance.yaml already exists at this Azure DevOps location" case is a genuine conflict when the caller asked to *create* a new instance there (#93's locked-in 409 contract — tests/server.test.js) and must stay that way; this route is for a caller who already knows (from its own prior repo-check) that data exists and wants to adopt it, not create anything (#94, under #88's "Open instance ... actually works" acceptance criterion for the wizard's "existing instance found" outcome).
      //
      // Re-runs `checkAzureDevOpsRepo` itself (rather than trusting a slug/definition the caller supplies) so the slug registered is always the real one currently in that repo's instance.yaml, not whatever a possibly-stale client-side check result claims.
      //
      // Idempotent for a slug already registered to this *exact* location (re-opening a previously-adopted instance from the wizard must not fail) — but a 409 conflict, same as POST /api/instances, when the slug is already registered to a *different* location (local or a different Azure DevOps repo), so this can never silently repoint an existing registry entry.
      if (url.pathname === '/api/instances/adopt' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const azureDevOps = body?.azureDevOps
        if (typeof azureDevOps !== 'object' || azureDevOps === null) {
          sendJSON(res, 400, { error: 'azureDevOps must be an object with organization, project, and repository' })
          return
        }
        const missingFields = ['organization', 'project', 'repository'].filter((key) => !azureDevOps[key])
        if (missingFields.length) {
          sendJSON(res, 400, { error: `azureDevOps location is missing: ${missingFields.join(', ')}` })
          return
        }
        // See createServer's own doc comment on allowAzureDevOpsBaseUrlOverride.
        if (azureDevOps.baseUrl !== undefined && !allowAzureDevOpsBaseUrlOverride) {
          sendJSON(res, 400, { error: 'azureDevOps.baseUrl overrides are not permitted on this server' })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        const location = {
          organization: azureDevOps.organization,
          project: azureDevOps.project,
          repository: azureDevOps.repository,
          ...(allowAzureDevOpsBaseUrlOverride && azureDevOps.baseUrl ? { baseUrl: azureDevOps.baseUrl } : {}),
        }

        let checkResult
        try {
          checkResult = await checkAzureDevOpsRepo({ ...location, pat, definitionsDir })
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          throw err
        }

        // `'multiple'` (#100: one Azure DevOps repo can now hold more than one instance under gantry-workspace/<slug>/) is reported distinctly from `'empty'` — data *was* found here, it's just ambiguous which instance to adopt, and this route has no slug input to disambiguate with (left for the multi-instance/settings UI work, #101/#104) — reporting it as "nothing to adopt" would be actively misleading.
        if (checkResult.result === 'multiple') {
          sendJSON(res, 400, {
            error: `This Azure DevOps location already holds more than one instance (${checkResult.slugs.join(', ')}) — adopting a specific one isn't supported yet.`,
          })
          return
        }
        if (checkResult.result !== 'found') {
          sendJSON(res, 400, { error: 'No instance data found at this Azure DevOps location yet — nothing to adopt.' })
          return
        }
        if (!checkResult.slug) {
          sendJSON(res, 400, { error: 'Instance data at this Azure DevOps location has no slug set.' })
          return
        }
        // `checkResult.slug` comes from the *target repo's own* instance.yaml — unsanitized third-party content, unlike every other registration path's slug (always client-supplied and already run through this exact check, e.g. POST /api/instances' create path above). Without this, a malformed or adversarial instance.yaml (e.g. `slug: ../evil` or `slug: foo/bar`) would still register successfully — becoming a permanent, unremovable (no unregister route exists) entry in the shared dashboard listing that can never actually be opened, since every single-instance route's own `resolveSlugParam` rejects such a slug the moment anyone tries.
        if (!isValidSlug(checkResult.slug)) {
          sendJSON(res, 400, { error: `Instance data at this Azure DevOps location has an invalid slug "${checkResult.slug}".` })
          return
        }

        const slug = checkResult.slug
        const existingLocation = resolveInstanceLocation(slug, { instancesDir })
        const sameLocation =
          existingLocation?.kind === 'azureDevOps' &&
          existingLocation.organization === location.organization &&
          existingLocation.project === location.project &&
          existingLocation.repository === location.repository &&
          (existingLocation.baseUrl ?? undefined) === (location.baseUrl ?? undefined)

        if (existingLocation && !sameLocation) {
          sendJSON(res, 409, { error: `Instance "${slug}" already exists` })
          return
        }
        if (!existingLocation) {
          registerInstance(slug, { kind: 'azureDevOps', ...location }, { instancesDir })
        }

        const row = (await listRegistry({ instancesDir, definitionsDir, pat })).find((i) => i.slug === slug)
        sendJSON(res, 200, row)
        return
      }

      // The dashboard's (#77) stage-swimlane view needs a definition's full stage list (id/title/gate, in order) to lay out lanes — including empty ones — before any instance of that definition necessarily exists to read it off of. A thin projection of `loadDefinition`, not a general definitions API.
      const definitionStagesMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/stages$/)
      if (definitionStagesMatch && req.method === 'GET') {
        const definition = loadDefinition(definitionStagesMatch[1], { definitionsDir })
        sendJSON(res, 200, definition.stages.map((s) => ({ id: s.id, title: s.title, gate: s.gate })))
        return
      }

      if (url.pathname === '/api/instance/check' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // Mirrors `gantry check <slug> [--gate <id>]` — the dashboard's (#77) "Check" action, run against the instance's current stage unless a specific gate is requested.
        const gate = url.searchParams.get('gate') ?? undefined

        // Dual local/Azure-DevOps-backed dispatch (#103) — this route previously only ever checked the local `instancesDir`, silently ignoring the registry entirely: an Azure-DevOps-backed instance's "Check" action always evaluated a local directory that instance's data never actually lived in. Fixed here as part of #103's own gate-pass-then-sync flow, which needs a working check for Azure-DevOps-backed instances too, following the exact same resolve-then-gate pattern every other single-instance route uses.
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            // Read-only — a "Check" click must never itself start a stage's branch lifecycle (#122): resolveCheckStage picks the exact same stage checkGate itself will use, and findStageBranch only reports a branch that already exists, falling back to 'main' (this stage's own approved content, if it hasn't started, or its last-merged content, if it has already merged) otherwise.
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate })
            const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
            const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
            sendJSON(res, 200, await checkGate(slug, { azureDevOps, definitionsDir, gate }))
          })
          return
        }

        sendJSON(res, 200, checkGate(slug, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId), definitionsDir, gate }))
        return
      }

      // Links an instance to an Azure DevOps parent work item, auto-creating one child work item per stage in its definition underneath it (#95/#103). `organization`/`project` name where the *work item* lives — independent of, and not required to match, wherever this instance's own module data is stored (local or a different Azure DevOps repo entirely). `workItemType` is optional, defaulting to `DEFAULT_WORK_ITEM_TYPE` ("Task") — the configurable-with-a-sensible-default acceptance criterion. Requires the caller's own PAT (Work Items scope), via the same credential-provider seam as every other Azure-DevOps-backed route; if this instance's own data also happens to be Azure-DevOps-backed, the same PAT is reused for both calls rather than asking twice.
      if (url.pathname === '/api/instance/work-items/link' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const body = JSON.parse(await readBody(req))
        const { organization, project, parentId, workItemType } = body ?? {}
        const missing = ['organization', 'project', 'parentId'].filter((key) => !body?.[key])
        if (missing.length) {
          sendJSON(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` })
          return
        }
        // Same SSRF guard as POST /api/instances'/adopt's own azureDevOps.baseUrl (see createServer's own doc comment on allowAzureDevOpsBaseUrlOverride): an unvalidated, caller-chosen baseUrl must never be honored on a real deployment — only tests (against the fake Azure DevOps server) opt in.
        if (body?.baseUrl !== undefined && !allowAzureDevOpsBaseUrlOverride) {
          sendJSON(res, 400, { error: 'A work item baseUrl override is not permitted on this server' })
          return
        }
        const workItemBaseUrl = allowAzureDevOpsBaseUrlOverride ? body?.baseUrl : undefined

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        let instanceOptions = { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }
        let azureDevOpsBase
        if (azureDevOpsLocation) {
          azureDevOpsBase = { ...azureDevOpsLocation, pat }
          // Recording the link touches this instance's own instance.yaml (#122) — a genuine write, on whichever stage's branch is currently in progress, creating/stacking it if this is the first write to reach that stage.
          try {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
            if (!stage) {
              throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            instanceOptions = { azureDevOps: { ...azureDevOpsBase, branch } }
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              sendAuthenticationRequired(res)
              return
            }
            throw err
          }
        }

        try {
          const workItem = await linkInstanceToWorkItem(
            slug,
            { organization, project, parentId: Number(parentId), workItemType, pat, baseUrl: workItemBaseUrl },
            { ...instanceOptions, definitionsDir }
          )
          if (azureDevOpsBase) {
            await recordInstanceWorkItemLink(slug, workItem, { azureDevOps: azureDevOpsBase, definitionsDir })
          }
          sendJSON(res, 200, workItem)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          const status = /already linked/.test(err.message) ? 409 : 400
          sendJSON(res, status, { error: err.message })
        }
        return
      }

      // Repairs tags on the stage work items already recorded by Gantry. The
      // persisted child IDs, rather than the selected parent's hierarchy,
      // define the scope so an operator's other board items are untouched.
      if (url.pathname === '/api/instance/work-items/tag' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        let instanceOptions = { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }
        if (azureDevOpsLocation) {
          const azureDevOpsBase = { ...azureDevOpsLocation, pat }
          try {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const branch = await findStageBranch(azureDevOpsBase, slug, bootstrapInstance.stage)
            instanceOptions = { azureDevOps: branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase }
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              sendAuthenticationRequired(res)
              return
            }
            throw err
          }
        }

        try {
          const result = await tagLinkedWorkItems(slug, { ...instanceOptions, pat })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Backfills all Gantry-linked instances in the local registry. The
      // work-item IDs remain scoped by each instance's persisted metadata.
      if (url.pathname === '/api/work-items/tag' && req.method === 'POST') {
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const patsBySlug = body?.patsBySlug
        if (
          patsBySlug !== undefined &&
          (typeof patsBySlug !== 'object' || patsBySlug === null || Array.isArray(patsBySlug) ||
            Object.values(patsBySlug).some((value) => typeof value !== 'string' || value.length === 0))
        ) {
          sendJSON(res, 400, { error: 'patsBySlug must be an object of non-empty PAT strings' })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          sendJSON(res, 200, await tagAllLinkedWorkItems({ instancesDir, pat, patsBySlug }))
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // The confirmed half of #95/#103's read-write sync: re-checks the gate server-side (never trusting an earlier client-side check — the same instance the confirmation dialog checked a moment earlier may since have changed) and, only if it genuinely passes, pushes a new state to that stage's linked work item. The confirmation itself already happened client-side before this request was ever sent — declining it means this route is simply never called, leaving the work item's state genuinely untouched.
      if (url.pathname === '/api/instance/work-items/sync' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const gate = body?.gate ?? url.searchParams.get('gate') ?? undefined

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        let instanceOptions = { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }
        if (azureDevOpsLocation) {
          const azureDevOpsBase = { ...azureDevOpsLocation, pat }
          try {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate })
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            instanceOptions = { azureDevOps: { ...azureDevOpsBase, branch } }
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              sendAuthenticationRequired(res)
              return
            }
            throw err
          }
        }

        try {
          const result = await syncGatePassToWorkItem(slug, { gate }, { ...instanceOptions, definitionsDir, pat })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // The self-serve "Advance to next stage" action for a *local* instance (ADR-0012's local-instance mode, unaffected by ADR-0014's ticketing-mode pivot; #115): moves the instance's own persisted stage pointer forward by one, gated on its current stage's gate having genuinely passed (re-checked server-side by `advanceStage`, lib/stageAdvancement.js — never trusted from the confirm dialog's own earlier client-side check, mirroring every other gated write in this file). A Workspace-backed instance never reaches `advanceStage` at all: it always advances via its own Pull Request flow instead (ADR-0014, #122-#125), so this route rejects it outright here — before ever calling `advanceStage` — rather than leaving that distinction enforced only by the web form hiding the button (`buildInstanceResponse`'s `workspaceBacked` flag above). No PAT is required or consulted: this only ever writes to the local filesystem.
      if (url.pathname === '/api/instance/advance-stage' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          sendJSON(res, 400, {
            error:
              `Instance "${slug}" is Workspace-backed — it advances to its next stage only once that stage's ` +
              'own Pull Request is merged, not through this self-serve action.',
          })
          return
        }

        try {
          const result = advanceStage(slug, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId), definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Request Review is an ungated, advisory action. Each request creates
      // its own Azure DevOps Task and is tracked against the stage being
      // viewed; unlike Request Sign-off, it never opens or changes a Pull
      // Request and is not available for local instances.
      if (url.pathname === '/api/instance/request-review' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const stageId = body?.stage ?? url.searchParams.get('stage') ?? undefined
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — review requests are only supported for Workspace-backed instances.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const result = await requestStageReview(slug, {
            reviewer: body?.reviewer,
            stageId,
            instanceUrl: instanceStageUrl(req, slug, stageId),
          }, {
            azureDevOps: { ...azureDevOpsLocation, pat },
            definitionsDir,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Request Review' })
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Review Task state is read only on this explicit action. The result is
      // persisted so the status card remains useful across reloads without
      // introducing polling on GET /api/instance.
      if (url.pathname === '/api/instance/review-status' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const stageId = body?.stage ?? url.searchParams.get('stage') ?? undefined
        const reviewId = body?.reviewId ?? url.searchParams.get('reviewId')
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — review statuses are only supported for Workspace-backed instances.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const result = await checkStageReviewStatus(slug, { reviewId, stageId }, {
            azureDevOps: { ...azureDevOpsLocation, pat },
            definitionsDir,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Check Review status' })
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // The Assignee's "Request approval" action for a Workspace-backed instance (#124, ADR-0014): opens the actual approval gate — a Pull Request from that stage's own branch into `main` — but only once the stage's gate has genuinely passed (re-checked server-side by `requestStageApproval`, lib/stageApproval.js — never trusted from the confirm dialog's own earlier client-side check, mirroring every other gated write in this file). Rejects a *local* instance outright, before ever calling `requestStageApproval` or requiring a PAT — a local instance has no Pull Request to open at all; it advances only via `POST /api/instance/advance-stage` instead (ADR-0012), the same "reject before any Azure DevOps involvement" shape `POST /api/instance/advance-stage` itself uses for the opposite (Workspace-backed) case.
      if (url.pathname === '/api/instance/request-approval' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const gate = body?.gate ?? url.searchParams.get('gate') ?? undefined

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — there is no stage branch or Pull Request to open for it.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const result = await requestStageApproval(slug, {
            azureDevOps: { ...azureDevOpsLocation, pat },
            definitionsDir,
            gate,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Request Approval' })
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // The explicitly-triggered "Check status" action for a Workspace-backed instance (#125, ADR-0014): reads the stage's open Pull Request's reviewer votes from Azure DevOps — distinguishing an explicit rejection/changes-requested vote from a merely-still-pending review — and, on detecting the Owner's approval, completes (merges) the Pull Request itself, advances the stage pointer and pushes the linked work item's state (`checkStageApprovalStatus`, lib/stageStatus.js). Rejects a *local* instance outright before any Azure DevOps involvement, exactly as `POST /api/instance/request-approval` does above; requires a PAT for the same credential-seam reason.
      if (url.pathname === '/api/instance/check-status' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const gate = body?.gate ?? url.searchParams.get('gate') ?? undefined

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error:
              `Instance "${slug}" is not Workspace-backed — it has no Pull Request to check. Local instances ` +
              'advance through their own self-serve action instead.',
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const result = await checkStageApprovalStatus(slug, {
            azureDevOps: { ...azureDevOpsLocation, pat },
            definitionsDir,
            gate,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // The instance screen's synced-fields panel (#111): everything the panel shows for one stage — work item type (default Task), the auto-populated/overridden "{instance name} — {stage title}" title, the linked stage work item's own current state, the stage's Pull Request state, and the assignee (per-stage override or inherited instance assignee) — in one read (`getStageSyncedFields`, lib/syncedFields.js). Read-only. Resolves local vs. Azure-DevOps-backed per request like every other single-instance route; a Workspace-backed instance is gated behind the usual credential seam (its own instance.yaml lives there), while a *local* instance only needs a PAT when it's actually linked to a work item — an unlinked local instance gets its "Link to a work item" prompt with no credential at all.
      // Branch-scoped commit history (WI198): commits on a stage branch vs.
      // main, before a Pull Request exists.
      if (url.pathname === '/api/instance/commits' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const stageParam = url.searchParams.get('stage') ?? undefined

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — there is no stage branch to read commits from.`,
          })
          return
        }

        await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
          try {
            const instance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
            const stageId = stageParam ?? instance.stage
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              sendJSON(res, 400, { error: `Definition "${definition.id}" has no stage "${stageId}"` })
              return
            }

            const branch = stageBranchName(slug, stage.id)
            const client = createAzureDevOpsClient(azureDevOpsBase)
            if (!(await client.branchExists(branch))) {
              sendJSON(res, 200, { branch, ref: `refs/heads/${branch}`, commits: [] })
              return
            }

            const commits = await client.listBranchCommits(branch, { compareTo: 'main' })
            const summarized = commits.map((commit) => ({
              commitId: commit.commitId,
              message: commit.comment ?? commit.message ?? '',
              timestamp: commit.committer?.date ?? commit.author?.date ?? commit.date ?? null,
            }))
            sendJSON(res, 200, { branch, ref: `refs/heads/${branch}`, commits: summarized })
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              throw err
            }
            if (err instanceof AzureDevOpsNotFoundError) {
              sendJSON(res, 404, { error: err.message })
              return
            }
            sendJSON(res, 400, { error: err.message })
          }
        })
        return
      }

      if (url.pathname === '/api/instance/synced-fields' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const stageId = url.searchParams.get('stage') ?? undefined

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            sendJSON(res, 200, await getStageSyncedFields(slug, { azureDevOps: azureDevOpsBase, definitionsDir, stageId }))
          })
          return
        }

        // Local: a PAT matters only for the linked case's Work Items read — require it up front there so the panel gets a structured 401 (and the client its PAT prompt) rather than silently showing "—" forever.
        const resolvedSyncedFieldsDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        if (readInstance(slug, { instancesDir: resolvedSyncedFieldsDir }).workItem) {
          const pat = getCredential(req)
          if (!pat) {
            sendAuthenticationRequired(res)
            return
          }
        }
        try {
          sendJSON(res, 200, await getStageSyncedFields(slug, { instancesDir: resolvedSyncedFieldsDir, definitionsDir, stageId, pat: getCredential(req) }))
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          throw err
        }
        return
      }

      // The synced-fields panel's save action (#111): persists this stage's own title and/or assignee overrides onto the instance record (`saveStageSyncedFieldOverrides`, lib/syncedFields.js). An explicit empty string clears that override (title reverts to "{instance name} — {stage title}", assignee to the inherited instance assignee); absent keys are left untouched. Responds with the freshly-read synced-fields payload, so the client renders exactly what the server now has.
      if (url.pathname === '/api/instance/synced-fields' && req.method === 'PUT') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        // An empty body (rather than a JSON parse failure on it) falls through to the "nothing to save" 400 below, the same guard the other POST routes in this file use.
        const body = rawBody ? JSON.parse(rawBody) : {}
        const updates = {}
        for (const key of ['title', 'assignee']) {
          if (body?.[key] === undefined) continue
          if (typeof body[key] !== 'string') {
            sendJSON(res, 400, { error: `${key} must be a string` })
            return
          }
          updates[key] = body[key]
        }
        if (Object.keys(updates).length === 0) {
          sendJSON(res, 400, { error: 'Nothing to save — pass title and/or assignee' })
          return
        }
        const stageId = url.searchParams.get('stage') ?? undefined

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            sendJSON(
              res,
              200,
              await saveStageSyncedFieldOverrides(slug, { ...updates, stageId }, { azureDevOps: azureDevOpsBase, definitionsDir })
            )
          })
          return
        }

        try {
          sendJSON(
            res,
            200,
            await saveStageSyncedFieldOverrides(slug, { ...updates, stageId }, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId), definitionsDir })
          )
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Lists the work item types available in an Azure DevOps
      // organization/project (#121's `listWorkItemTypes`) — the "+ New
      // Workspace" wizard's Work Item Type lookup for its parent-work-item
      // link step (#126), so a caller picks a real type from this project's
      // own process template rather than typing one freetext. Read-only;
      // gated behind the same credential-provider seam (#86) as every other
      // Azure-DevOps-backed route, and the same `allowedAzureDevOpsBaseUrls`
      // SSRF allow-list as `GET /api/azure-devops/repo-check` above, since
      // `organization`/`project`/`baseUrl` are entirely caller-supplied here
      // too — this route establishes nothing in gantry's own registries,
      // it only ever reads from Azure DevOps.
      if (url.pathname === '/api/azure-devops/work-item-types' && req.method === 'GET') {
        const organization = url.searchParams.get('organization')
        const project = url.searchParams.get('project')
        const missing = ['organization', 'project'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        // See `GET /api/azure-devops/repo-check`'s own comment on
        // `requestedBaseUrl`/`allowedAzureDevOpsBaseUrls` — identical SSRF
        // guard, applied here for the same reason.
        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(requestedBaseUrl)) {
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a self-hosted Azure DevOps Server instance.',
          })
          return
        }

        await withAzureDevOpsCredential(
          req,
          res,
          { organization, project, baseUrl: requestedBaseUrl },
          async ({ organization: org, project: proj, pat, baseUrl }) => {
            const client = createAzureDevOpsWorkItemsClient({ organization: org, project: proj, pat, baseUrl })
            const types = await client.listWorkItemTypes()
            sendJSON(
              res,
              200,
              types.filter((t) => !t.isDisabled).map((t) => ({ name: t.name }))
            )
          }
        )
        return
      }

      if (url.pathname === '/api/azure-devops/work-items' && req.method === 'POST') {
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const organization = body?.organization ?? url.searchParams.get('organization')
        const project = body?.project ?? url.searchParams.get('project')
        const workItemType = body?.workItemType
        const title = body?.title
        const missing = []
        if (!organization) missing.push('organization')
        if (!project) missing.push('project')
        if (!workItemType) missing.push('workItemType')
        if (!title) missing.push('title')
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` })
          return
        }
        const requestedBaseUrl = body?.baseUrl ?? url.searchParams.get('baseUrl') ?? undefined
        const normalizedBaseUrl = requestedBaseUrl || undefined
        if (normalizedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(normalizedBaseUrl)) {
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a self-hosted Azure DevOps Server instance.',
          })
          return
        }
        await withAzureDevOpsCredential(
          req,
          res,
          { organization, project, baseUrl: normalizedBaseUrl },
          async ({ organization: org, project: proj, pat, baseUrl }) => {
            const client = createAzureDevOpsWorkItemsClient({ organization: org, project: proj, pat, baseUrl })
            const workItem = await client.createWorkItem(workItemType, { 'System.Title': title })
            sendJSON(res, 201, {
              id: workItem.id,
              title: workItem.fields?.['System.Title'] ?? title,
              workItemType: workItem.fields?.['System.WorkItemType'] ?? workItemType,
              state: workItem.fields?.['System.State'] ?? '',
            })
          }
        )
        return
      }

      // Fetches a single Azure DevOps work item's current title/type/state
      // by id (#121's `getWorkItem`) — the "+ New Workspace" wizard's
      // Parent work item id lookup for its parent-work-item link step
      // (#126), so a caller confirms a real work item exists (and sees its
      // own title/type) before linking an instance to it, rather than
      // typing an id freetext. Read-only; gated the same way as `GET
      // /api/azure-devops/work-item-types` immediately above (credential-
      // provider seam + the same base-URL SSRF allow-list) — this route
      // also establishes nothing in gantry's own registries.
      const workItemLookupMatch = url.pathname.match(/^\/api\/azure-devops\/work-items\/(\d+)$/)
      if (workItemLookupMatch && req.method === 'GET') {
        const id = Number(workItemLookupMatch[1])
        const organization = url.searchParams.get('organization')
        const project = url.searchParams.get('project')
        const missing = ['organization', 'project'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(requestedBaseUrl)) {
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a self-hosted Azure DevOps Server instance.',
          })
          return
        }

        await withAzureDevOpsCredential(
          req,
          res,
          { organization, project, baseUrl: requestedBaseUrl },
          async ({ organization: org, project: proj, pat, baseUrl }) => {
            const client = createAzureDevOpsWorkItemsClient({ organization: org, project: proj, pat, baseUrl })
            try {
              const workItem = await client.getWorkItem(id, {
                fields: ['System.Title', 'System.WorkItemType', 'System.State'],
              })
              sendJSON(res, 200, {
                id: workItem.id,
                title: workItem.fields?.['System.Title'] ?? '',
                workItemType: workItem.fields?.['System.WorkItemType'] ?? '',
                state: workItem.fields?.['System.State'] ?? '',
              })
            } catch (err) {
              if (err instanceof AzureDevOpsNotFoundError) {
                sendJSON(res, 404, { error: `No work item ${id} found in ${org}/${proj}` })
                return
              }
              throw err
            }
          }
        )
        return
      }

      // Which workspace (if any) a slug belongs to (#104) — a small,
      // read-only, registry-only lookup with no Azure DevOps call and no
      // PAT required (mirrors `GET /api/workspaces`'s own "no credential
      // needed" note). This is what the client-side request layer
      // (web/lib/apiFetch.js's `apiFetchForInstance`) asks *before* it
      // decides which PAT to attach to a request that actually does touch
      // Azure DevOps — resolving that from the response body alone would
      // be too late, since the very first Azure-DevOps-touching request
      // for a workspace-overridden instance needs the right credential
      // attached from the start, not just on a 401 retry. `workspaceId` is
      // `null` for a local instance, or one this registry has never seen.
      if (url.pathname === '/api/instance/workspace' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // `scope` (WI #366) is the opaque addressing token the web client echoes back as `?scope=` on
        // every subsequent request for this instance, so its lookups resolve within the one workspace
        // the instance actually lives in instead of the deprecated search across all of them. It is
        // the same scope id `workspaceId` carries, exposed under its own name because the two answer
        // different questions — `workspaceId` picks a PAT override (#104), `scope` picks a workspace —
        // and neither should quietly change shape because the other needed to.
        const scope = resolveInstanceWorkspaceId(slug, { instancesDir })
        sendJSON(res, 200, { workspaceId: scope, scope })
        return
      }

      if (url.pathname === '/api/instance' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            // Read-only bootstrap (against 'main', the client's own default) purely to learn which stage this request is actually browsing — never itself starts a stage's branch lifecycle (#122): opening the module editor to look must not create a branch, only saving something does (see PUT /api/instance/modules/:id below).
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }

            // Only report this stage's real content once work has actually begun on it (its branch exists) — otherwise the bootstrap read above (against 'main') already is that stage's real content, since nothing has diverged from it yet.
            // WI264: completed stage (free-browsing a stage the instance has already advanced past) must read from main, not its stale leftover branch — that branch is irrelevant once merged, and its stale snapshot would hide the merged content (e.g. ../assets/ images committed via the now-merged PR).
            let branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
            const viewedIdxForBranch = definition.stages.findIndex((s) => s.id === stage.id)
            const currentIdxForBranch = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
            if (viewedIdxForBranch !== -1 && currentIdxForBranch !== -1 && viewedIdxForBranch < currentIdxForBranch) {
              branch = undefined
            }
            const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
            const instance = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance

            const modules = await Promise.all(
              stage.modules.map(async (moduleId) => {
                let data = { status: 'draft', owner: '', fields: {} }
                try {
                  data = await readModule(definition, slug, moduleId, { azureDevOps })
                } catch (err) {
                  if (err instanceof AzureDevOpsAuthenticationError) throw err
                  // Only readModule's own "no saved data yet" miss (its Azure-DevOps-backed twin's stand-in for the local branch's existsSync-guarded skip below) defaults to the blank draft above — a genuine failure (a network error, an Azure DevOps outage, malformed module content, etc.) must propagate as a real error instead of silently rendering as an empty module.
                  if (!/has no saved data/.test(err.message)) throw err
                }
                // The "Populate example text" button's source — a curated example instance declared per-stage in the definition, always read from the local instancesDir: it's a shared fixture, not this Azure-DevOps-backed instance's own data.
                let exampleData = null
                if (stage.example) {
                  const exampleInstancesDir = resolveLocalDataDir(stage.example, instancesDir)
                  if (existsSync(join(exampleInstancesDir, stage.example, 'modules', `${moduleId}.md`))) {
                    exampleData = readModule(definition, stage.example, moduleId, { instancesDir: exampleInstancesDir })
                  }
                }
                return buildModuleEntry(definition, stage, moduleId, data, exampleData)
              })
            )

            const pullRequest = await readPullRequestSummary(instance, stage, azureDevOpsBase)
            // WI262: completed stages never show the sync banner — their leftover branch (if any) is irrelevant once the instance has advanced past them.
            // WI256: advisory stageSync detection — only when a stage branch already exists (respects "opening the editor must not create a branch")
            let stageSync = { behind: false, behindFiles: [], ahead: false }
            const viewedIdx = definition.stages.findIndex((s) => s.id === stage.id)
            const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
            if (viewedIdx !== -1 && currentIdx !== -1 && viewedIdx < currentIdx) {
              // already complete — skip compare entirely
            } else if (branch) {
              try {
                stageSync = await getStageSyncStatus(azureDevOpsBase, slug, stage.id)
              } catch {
                // Advisory only — a transient comparison failure must not break the instance read
                stageSync = { behind: false, behindFiles: [], ahead: false }
              }
            }
            sendJSON(res, 200, {
              ...buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, true, azureDevOpsLocation, pullRequest, instancesDir, scopeId),
              // #223 — this instance still resolves (read-only) at its direct URL when archived; the
              // web UI shows an "archived" banner and hides its mutating affordances off this flag.
              archived: isInstanceArchived(slug, { instancesDir, scopeId }),
              stageSync,
            })
          })
          return
        }

        const resolvedInstanceDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedInstanceDir })
        const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
        const stageId = resolveStageIdParam(url, definition, instance.stage)
        const stage = definition.stages.find((s) => s.id === stageId)
        if (!stage) {
          throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
        }

        const modules = stage.modules.map((moduleId) => {
          let data = { status: 'draft', owner: '', fields: {} }
          if (existsSync(join(resolvedInstanceDir, slug, 'modules', `${moduleId}.md`))) {
            data = readModule(definition, slug, moduleId, { instancesDir: resolvedInstanceDir })
          }
          // The "Populate example text" button's source — a curated example instance declared per-stage
          // in the definition, not fabricated placeholder text. Resolved dynamically via the registry
          // (WI #358: the bundled `examples`/Kiwi Cover Mutual fixture now lives inside the real
          // `examples` server workspace, same as any other directory-backed instance).
          let exampleData = null
          if (stage.example) {
            const exampleInstancesDir = resolveLocalDataDir(stage.example, instancesDir)
            if (existsSync(join(exampleInstancesDir, stage.example, 'modules', `${moduleId}.md`))) {
              exampleData = readModule(definition, stage.example, moduleId, { instancesDir: exampleInstancesDir })
            }
          }
          return buildModuleEntry(definition, stage, moduleId, data, exampleData)
        })

        sendJSON(res, 200, {
          ...buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, false, null, null, instancesDir, scopeId),
          // See the Azure-DevOps-backed branch above — #223's read-only-resolves-when-archived flag.
          archived: isInstanceArchived(slug, { instancesDir, scopeId }),
          stageSync: { behind: false, behindFiles: [], ahead: false },
        })
        return
      }

      // WI256: merge main into the stage branch
      if (url.pathname === '/api/instance/stage-branch/sync' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, { error: `Instance "${slug}" is not Workspace-backed — stage-branch sync is only for Workspace-backed instances` })
          return
        }
        await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
          const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
          const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
          const stageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
          const stage = definition.stages.find((s) => s.id === stageId)
          if (!stage) {
            throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
          }
          // WI262: completed stage — nothing to sync, and merging would diverge on instance.yaml after advancement
          const viewedIdx = definition.stages.findIndex((s) => s.id === stage.id)
          const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
          if (viewedIdx !== -1 && currentIdx !== -1 && viewedIdx < currentIdx) {
            sendJSON(res, 409, { error: `Stage "${stage.id}" is already complete — nothing to sync` })
            return
          }
          const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
          if (!branch) {
            sendJSON(res, 404, { error: `No stage branch for "${slug}" stage "${stage.id}" — nothing to sync` })
            return
          }
          try {
            const result = await syncStageBranch(azureDevOpsBase, slug, stage.id)
            if (result.conflict) {
              sendJSON(res, 409, { error: 'Merge conflict — resolve in the opened pull request', pullRequestUrl: result.pullRequestUrl, pullRequestId: result.pullRequestId })
              return
            }
            const client = createAzureDevOpsClient(azureDevOpsBase)
            const objectId = await client.getBranchObjectId(result.branch)
            sendJSON(res, 200, { branch: result.branch, objectId, fastForward: result.fastForward ?? false, pullRequestId: result.pullRequestId, pullRequestUrl: result.pullRequestUrl })
          } catch (err) {
            if (err instanceof AzureDevOpsNotFoundError) {
              sendJSON(res, 404, { error: err.message })
              return
            }
            if (err instanceof AzureDevOpsAuthenticationError) throw err
            if (err.status === 409) {
              sendJSON(res, 409, { error: 'Merge conflict — resolve in the opened pull request' })
              return
            }
            throw err
          }
        })
        return
      }

      // WI265: re-open a signed-off stage for late feedback (docs/adr/0026)
      if (url.pathname === '/api/instance/stage/reopen' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, { error: `Instance "${slug}" is not Workspace-backed — re-opening a stage is only supported for Workspace-backed instances.` })
          return
        }
        const rawBody = await readBody(req)
        let body = {}
        try {
          body = rawBody ? JSON.parse(rawBody) : {}
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const stageId = body?.stage ?? url.searchParams.get('stage')
        if (!stageId) {
          sendJSON(res, 400, { error: 'Missing required field: stage' })
          return
        }
        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }
        try {
          const result = await reopenStage(slug, stageId, { azureDevOps: { ...azureDevOpsLocation, pat }, definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: 'Re-open stage' })
            return
          }
          const status = err.status === 409 ? 409 : 400
          sendJSON(res, status, { error: err.message })
        }
        return
      }

      // Updates the instance record's own stored `assignee` (#97) — the instance detail UI's edit affordance for it. Distinct from `PUT /api/instance/modules/:id` below, which writes a *module's* own frontmatter `owner`/`status` (the separate Design Authority sign-off convention, untouched by #97). Resolves local vs. Azure-DevOps-backed the same way every other single-instance route does — per-request, via the shared instance registry.
      if (url.pathname === '/api/instance/assignee' && req.method === 'PUT') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const body = JSON.parse(await readBody(req))
        const assignee = typeof body?.assignee === 'string' ? body.assignee : ''

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            // A real write to instance.yaml (#122) — targets whichever stage is currently in progress, creating/stacking that stage's branch if this is the first write to reach it.
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
            if (!stage) {
              throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            const instance = await updateInstanceAssignee(slug, assignee, { azureDevOps: { ...azureDevOpsBase, branch } })
            sendJSON(res, 200, { slug, assignee: instance.assignee })
          })
          return
        }

        const instance = updateInstanceAssignee(slug, assignee, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) })
        sendJSON(res, 200, { slug, assignee: instance.assignee })
        return
      }

      // The stage-level Save (WI #376): every changed module on the browsed stage in one request, body `{ modules: { <moduleId>: { status, owner, fields, layout } } }`. On an Azure-DevOps-backed instance that is one commit on the stage branch; locally the files are written in turn. Nothing is rendered (ADR-0034).
      if (url.pathname === '/api/instance/modules' && req.method === 'PUT') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const body = JSON.parse(await readBody(req))
        const modules = body?.modules && typeof body.modules === 'object' ? body.modules : {}
        const moduleIds = Object.keys(modules)
        const invalidModules = (definition) => {
          if (moduleIds.length === 0) return 'Nothing to save — "modules" is empty.'
          const unknown = moduleIds.filter((id) => !definition.modules.has(id))
          return unknown.length ? `Definition "${definition.id}" has no module(s): ${unknown.join(', ')}` : null
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const invalid = invalidModules(definition)
            if (invalid) {
              sendJSON(res, 400, { error: invalid })
              return
            }
            const stageId = url.searchParams.get('stage') ?? bootstrapInstance.stage
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            const azureDevOps = { ...azureDevOpsBase, branch }
            const titles = moduleIds.map((id) => definition.modules.get(id).title)
            const saved = await writeModules(definition, slug, modules, { azureDevOps, message: `Save ${stage.title}: ${titles.join(', ')}` })
            const status = await getStatus(slug, { azureDevOps, definitionsDir, stageId })
            sendJSON(res, 200, { ...status, saved: saved.modules, commit: saved.commit })
          })
          return
        }

        const resolvedModuleDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedModuleDir })
        const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
        const invalid = invalidModules(definition)
        if (invalid) {
          sendJSON(res, 400, { error: invalid })
          return
        }
        const saved = writeModules(definition, slug, modules, { instancesDir: resolvedModuleDir })
        const stageId = url.searchParams.get('stage') ?? instance.stage
        sendJSON(res, 200, { ...getStatus(slug, { instancesDir: resolvedModuleDir, definitionsDir, stageId }), saved: saved.modules })
        return
      }

      const moduleMatch = url.pathname.match(/^\/api\/instance\/modules\/([^/]+)$/)
      if (moduleMatch && req.method === 'PUT') {
        const moduleId = moduleMatch[1]
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            // Report completeness for whichever stage the form is currently browsing, not always the instance's persisted stage — otherwise saving a module that belongs to a non-current stage reports against a status that doesn't include that module at all. Saving a module is a genuine write (#122) — the moment work begins on that stage, creating/stacking its branch if this is the first write to reach it.
            const stageId = url.searchParams.get('stage') ?? bootstrapInstance.stage
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            const azureDevOps = { ...azureDevOpsBase, branch }

            const body = JSON.parse(await readBody(req))
            await writeModule(definition, slug, moduleId, body, { azureDevOps })
            // No render-on-save (WI #376, ADR-0034): documents are rendered only when the author clicks Render.
            sendJSON(res, 200, await getStatus(slug, { azureDevOps, definitionsDir, stageId }))
          })
          return
        }

        const resolvedModuleDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedModuleDir })
        const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
        const body = JSON.parse(await readBody(req))
        writeModule(definition, slug, moduleId, body, { instancesDir: resolvedModuleDir })
        // Report completeness for whichever stage the form is currently browsing, not always the instance's persisted stage — otherwise saving a module that belongs to a non-current stage reports against a status that doesn't include that module at all.
        const stageId = url.searchParams.get('stage') ?? instance.stage
        sendJSON(res, 200, getStatus(slug, { instancesDir: resolvedModuleDir, definitionsDir, stageId }))
        return
      }

      const renderMatch = url.pathname.match(/^\/api\/instance\/render\/([^/]+)$/)
      if (renderMatch && req.method === 'POST') {
        const artefactId = renderMatch[1]
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
            // Rendering pushes the compiled artefact onto the repo (#122's own "the render pipeline" consumer, ADR-0014) — a genuine write, targeting whichever stage is currently in progress and creating/stacking its branch if this is the first write to reach it.
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
            if (!stage) {
              throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            const azureDevOps = { ...azureDevOpsBase, branch }

            const instanceForReview = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance
            const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
            const reviewSummary = artefactSpec
              ? buildReviewSummaryForArtefact(definition, artefactSpec, instanceForReview, azureDevOps)
              : undefined

            // WI #359 — `?format=md|docx` (default docx): which output the render actually
            // produces and persists. See lib/render.js's compileArtefact doc comment.
            const format = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
            const result = await renderArtefact(slug, artefactId, { azureDevOps, instancesDir, definitionsDir, reviewSummary, format })
            // `azureDevOpsPath` (not `docxPath`/`mdPath`, a scratch path on whichever machine `gantry serve` happens to run on) is what the browser should report back — the rendered artefact now lives in the same Azure DevOps repo as the rest of this instance's data.
            sendJSON(res, 200, {
              artefact: artefactId,
              format,
              azureDevOpsPath: result.azureDevOpsPath,
              azureDevOpsUrl: artefactFileUrl(azureDevOps, result.azureDevOpsPath, branch),
            })
          })
          return
        }

        // Local render — build a minimal reviewSummary so the Document Control
        // block still appears with a plain hash and Pending row.
        const resolvedRenderDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const localInstance = readInstance(slug, { instancesDir: resolvedRenderDir })
        const localDefinition = loadDefinition(localInstance.definition, { definitionsDir, version: instanceDefinitionVersion(localInstance) })
        const localArtefactSpec = localDefinition.artefacts.find((a) => a.id === artefactId)
        const localReviewSummary = localArtefactSpec
          ? buildReviewSummaryForArtefact(localDefinition, localArtefactSpec, localInstance, null)
          : undefined
        // WI #359 — `?format=md|docx` (default docx).
        const localFormat = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
        // WI #360 — a server-hosted (directory-backed) instance's render is delivered straight
        // to the browser as a download, never written into the instance's own `out/` directory.
        // `deliverToClient` is what makes lib/render.js's compileArtefact skip that persistence
        // entirely; the response below carries the rendered bytes (or, for `format: 'md'`, the
        // already-compiled markdown string) instead of a server-side path.
        const result = renderArtefact(slug, artefactId, {
          instancesDir: resolvedRenderDir,
          definitionsDir,
          reviewSummary: localReviewSummary,
          format: localFormat,
          deliverToClient: true,
        })
        sendJSON(res, 200, {
          artefact: artefactId,
          format: localFormat,
          basename: result.basename,
          markdown: localFormat === 'md' ? result.markdown : null,
          docxBase64: localFormat === 'docx' ? result.docxBytes.toString('base64') : null,
        })
        return
      }

      // WI314 — the Azure-DevOps-hosted half of the client-side WASM Pandoc render path,
      // split into two routes either side of the browser's own conversion step (see
      // lib/render.js's prepareAzureDevOpsWasmRender/finishAzureDevOpsWasmRender doc
      // comments for the full two-push rationale). Only reached when the browser's
      // web/lib/renderEngine.js selection is `'wasm'` — `'native'` keeps calling the
      // `/api/instance/render/:artefact` route above, unconditionally, exactly as before.
      const wasmPrepareMatch = url.pathname.match(/^\/api\/instance\/render-wasm-prepare\/([^/]+)$/)
      if (wasmPrepareMatch && req.method === 'POST') {
        const artefactId = wasmPrepareMatch[1]
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          // WI #349 — a plain local instance (under `instancesDir`, e.g. the bundled `examples`).
          // Compiles the artefact (dry run: no `pandoc` subprocess — a zip-release install has
          // none) and writes the .md alongside where the .docx will land, exactly as the native
          // `/api/instance/render/:artefact` route does; the browser converts the markdown with
          // pandoc-wasm and hands the bytes to render-wasm-finish below. The Document Control
          // block is already stamped here (git hash or .build-info.json, AB#345).
          const resolvedWasmPrepareDir = resolveLocalDataDir(slug, instancesDir, scopeId)
          const localInstance = readInstance(slug, { instancesDir: resolvedWasmPrepareDir })
          const localDefinition = loadDefinition(localInstance.definition, { definitionsDir, version: instanceDefinitionVersion(localInstance) })
          const localArtefactSpec = localDefinition.artefacts.find((a) => a.id === artefactId)
          const localReviewSummary = localArtefactSpec
            ? buildReviewSummaryForArtefact(localDefinition, localArtefactSpec, localInstance, null)
            : undefined
          // WI #359 — the WASM engine only ever reaches this route for a docx-format render
          // (the client skips straight to the plain /api/instance/render route for format:
          // 'md', since there's no browser-side conversion step to offload for markdown-only
          // output — see web/app.js's renderAzureArtefactViaEngine). No `.md` is written here:
          // persisting one eagerly for a docx-only render was exactly the kind of unwanted
          // markdown output this ticket's "docx-only must not persist md" requirement rules
          // out, and finish (below) doesn't need it on disk to land the docx bytes.
          const result = renderArtefact(slug, artefactId, { instancesDir: resolvedWasmPrepareDir, definitionsDir, reviewSummary: localReviewSummary, dryRun: true })
          // WI #367 — the compiled markdown points every image at an absolute path on this machine,
          // which the browser's pandoc-wasm filesystem knows nothing about. Ship the bytes with it.
          const wasmPrepared = externaliseImagesForWasm(result.markdown)
          sendJSON(res, 200, {
            artefact: artefactId,
            markdown: wasmPrepared.markdown,
            imageFilesBase64: wasmPrepared.files,
            basename: result.basename,
            referenceDocBase64: result.referenceDocPath ? readFileSync(result.referenceDocPath).toString('base64') : null,
            docxPath: resolve(result.docxPath),
          })
          return
        }
        await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
          const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
          const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
          const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
          if (!stage) {
            throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)
          }
          const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
          const azureDevOps = { ...azureDevOpsBase, branch }

          const instanceForReview = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance
          const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
          const reviewSummary = artefactSpec
            ? buildReviewSummaryForArtefact(definition, artefactSpec, instanceForReview, azureDevOps)
            : undefined

          const result = await prepareAzureDevOpsWasmRender(slug, artefactId, { azureDevOps, instancesDir, definitionsDir, reviewSummary })
          // WI #367 — same as the directory-backed leg above: the assets this materialises are real
          // files on this machine, so their bytes have to travel to the browser with the markdown.
          const wasmPrepared = externaliseImagesForWasm(result.markdown)
          sendJSON(res, 200, {
            artefact: artefactId,
            markdown: wasmPrepared.markdown,
            imageFilesBase64: wasmPrepared.files,
            basename: result.basename,
            referenceDocBase64: result.referenceDocPath ? readFileSync(result.referenceDocPath).toString('base64') : null,
            commit: result.commit,
            azureDevOpsPath: result.azureDevOpsPath,
            branch: result.branch,
          })
        })
        return
      }

      const wasmFinishMatch = url.pathname.match(/^\/api\/instance\/render-wasm-finish\/([^/]+)$/)
      if (wasmFinishMatch && req.method === 'POST') {
        const artefactId = wasmFinishMatch[1]
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        let body
        try {
          const raw = await readBodyWithLimit(req, LOCAL_WORKSPACE_LIMITS.maxBodyBytes)
          body = raw.length ? JSON.parse(raw.toString('utf8')) : null
        } catch (err) {
          if (err.tooLarge) {
            sendJSON(res, 413, { error: `Request body exceeds the ${LOCAL_WORKSPACE_LIMITS.maxBodyBytes}-byte limit` })
            return
          }
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        if (!azureDevOpsLocation) {
          // WI #360 — a server-hosted (directory-backed) instance's render is delivered
          // straight to the browser: the browser already produced these exact docx bytes
          // itself (via pandoc-wasm) before POSTing them here, so there is nothing left to do
          // server-side except hand back the artefact's basename for the download's filename —
          // no write to the instance's `out/` directory at all. Before WI #360 this route
          // landed the bytes at the .docx path the native route would have written; it no
          // longer touches disk for this instance kind.
          if (!body || typeof body.docxBase64 !== 'string') {
            sendJSON(res, 400, { error: 'Body must include docxBase64' })
            return
          }
          const result = renderArtefact(slug, artefactId, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId), definitionsDir, dryRun: true })
          sendJSON(res, 200, { artefact: artefactId, basename: result.basename, docxBase64: body.docxBase64 })
          return
        }
        if (!body || typeof body.docxBase64 !== 'string' || typeof body.azureDevOpsPath !== 'string' || !body.commit?.hash) {
          sendJSON(res, 400, { error: 'Body must include docxBase64, azureDevOpsPath, and commit' })
          return
        }
        await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
          const azureDevOps = { ...azureDevOpsBase, branch: body.branch }
          await finishAzureDevOpsWasmRender(Buffer.from(body.docxBase64, 'base64'), {
            azureDevOps,
            azureDevOpsPath: body.azureDevOpsPath,
            branch: body.branch,
            commit: body.commit,
            artefactId,
          })
          sendJSON(res, 200, {
            artefact: artefactId,
            azureDevOpsPath: body.azureDevOpsPath,
            azureDevOpsUrl: artefactFileUrl(azureDevOps, body.azureDevOpsPath, body.branch),
          })
        })
        return
      }

      if (url.pathname === '/api/instance/assets' && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // WI260 repo-as-asset-store: workspace-backed instances store assets as committed files in `gantry-workspace/<slug>/assets/` in the Azure DevOps repo, not as local `instancesDir/<slug>/assets` with a manifest. List that repo dir via the Azure DevOps client, credential-gated with the same withAzureDevOpsCredential seam as the other workspace-backed reads.
        const azureLoc = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureLoc) {
          await withAzureDevOpsCredential(req, res, azureLoc, async (azureDevOpsBase) => {
            // Read from the same ref the module content is read from (stage branch if one exists, else main) — mirrors lib/render.js's fetch for the pandoc render.
            // WI264: stage-aware — `?stage=` (free-browsing a completed stage) pins to that stage's ref, and a completed stage forces `main` so stale branch snapshots don't hide merged assets.
            let branch
            try {
              const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
              const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
              const viewedStageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
              const stage = definition.stages.find((s) => s.id === viewedStageId)
              if (stage) {
                branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
                const viewedIdx = definition.stages.findIndex((s) => s.id === stage.id)
                const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
                if (viewedIdx !== -1 && currentIdx !== -1 && viewedIdx < currentIdx) {
                  branch = undefined
                }
              }
            } catch {
              // If the instance can't be read yet, fall back to main — listing remains useful.
            }
            const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
            const client = createAzureDevOpsClient(azureDevOps)
            const assetsPath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets`
            const items = await client.listFolder(assetsPath, { branch: azureDevOps.branch ?? 'main' })
            // Also include assets on main not yet on the stage branch — prefer stage-branch version when both exist.
            let allItems = [...items]
            if (azureDevOps.branch && azureDevOps.branch !== 'main') {
              const mainItems = await client.listFolder(assetsPath, { branch: 'main' })
              const branchPaths = new Set(items.map((i) => i.path))
              for (const item of mainItems) {
                if (!branchPaths.has(item.path)) allItems.push(item)
              }
            }
            // listFolder returns the folder itself plus children; the client already filters the self-entry. Map each file to a listAssets-like entry.
            const assets = allItems
              .filter((item) => !item.isFolder)
              .map((item) => {
                const filename = item.path.split('/').pop()
                return {
                  id: filename,
                  filename,
                  name: filename,
                  source: '',
                  uploadedBy: '',
                  usedIn: [],
                }
              })
              .sort((a, b) => a.filename.localeCompare(b.filename))
            sendJSON(res, 200, assets)
          })
          return
        }
        // WI304: `slug` is neither Azure-DevOps-backed nor a local (instancesDir)
        // instance the server has ever heard of — the shape a local-workspace
        // instance (ADR-0029) always has here, since it carries no server-side
        // registry entry at all. Without this guard, readInstance's own "no
        // instance" throw fell through to the top-level catch as an
        // undifferentiated 500; a local-workspace instance's assets are served
        // entirely client-side (web/app.js's fetchAssets), so this route should
        // never be reached for one — this is defense-in-depth for whatever path
        // still reaches it, matching the clean-4xx pattern every other
        // Workspace-only route already uses (see e.g. /api/instance/request-review).
        let instance
        const resolvedAssetsDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        try {
          instance = readInstance(slug, { instancesDir: resolvedAssetsDir })
        } catch {
          sendJSON(res, 400, {
            error: `Instance "${slug}" has no server-side record. If this is a local-workspace instance, its assets are served entirely client-side and this route should not be called for it.`,
          })
          return
        }
        const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
        sendJSON(res, 200, listAssets(definition, slug, { instancesDir: resolvedAssetsDir }))
        return
      }

      if (url.pathname === '/api/instance/assets' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // WI260 scoped: repo-as-asset-store has no upload UI yet — committed repo assets only. Keep workspace-backed POST scoped out; a follow-up WI can add upload.
        const azureLocForPost = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureLocForPost) {
          sendJSON(res, 400, { error: 'Asset uploads are not supported for Workspace-backed instances — commit files to gantry-workspace/<slug>/assets/ in the Azure DevOps repo instead.' })
          return
        }
        const body = JSON.parse(await readBody(req))
        try {
          const asset = createAsset(
            slug,
            {
              filename: body.filename,
              buffer: Buffer.from(body.dataBase64 ?? '', 'base64'),
              name: body.name,
              source: body.source,
              uploadedBy: body.uploadedBy,
            },
            { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }
          )
          sendJSON(res, 201, asset)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      const assetFileMatch = url.pathname.match(/^\/api\/instance\/assets\/([^/]+)\/file$/)
      if (assetFileMatch && req.method === 'GET') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // WI260: workspace-backed instances serve files from the repo's `gantry-workspace/<slug>/assets/` dir via Azure DevOps, not local disk.
        const azureLoc = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (azureLoc) {
          const filename = decodeURIComponent(assetFileMatch[1])
          // Basic traversal guard — filename is a single segment, no slashes; mirrors isValidSlug's single-segment check.
          if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            sendJSON(res, 400, { error: `Invalid asset filename "${filename}"` })
            return
          }
          await withAzureDevOpsCredential(req, res, azureLoc, async (azureDevOpsBase) => {
            // WI264: stage-aware — `?stage=` (free-browsing a completed stage) pins to that stage's ref, and a completed stage forces `main`.
            let branch
            try {
              const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
              const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
              const viewedStageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
              const stage = definition.stages.find((s) => s.id === viewedStageId)
              if (stage) {
                branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
                const viewedIdx = definition.stages.findIndex((s) => s.id === stage.id)
                const currentIdx = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
                if (viewedIdx !== -1 && currentIdx !== -1 && viewedIdx < currentIdx) {
                  branch = undefined
                }
              }
            } catch {
              // fall back to main
            }
            const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
            const client = createAzureDevOpsClient(azureDevOps)
            const assetPath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets/${filename}`
            let content
            try {
              content = await client.getFileContent(assetPath, { branch: azureDevOps.branch ?? 'main' })
            } catch (err) {
              if (err instanceof AzureDevOpsNotFoundError) {
                // Fallback: if not on the stage branch, try main explicitly before 404 — covers assets committed before the branch was created.
                if (azureDevOps.branch && azureDevOps.branch !== 'main') {
                  try {
                    const mainClient = createAzureDevOpsClient({ ...azureDevOpsBase })
                    content = await mainClient.getFileContent(assetPath, { branch: 'main' })
                  } catch (fallbackErr) {
                    if (fallbackErr instanceof AzureDevOpsNotFoundError) {
                      sendJSON(res, 404, { error: `No asset "${filename}" for instance "${slug}"` })
                      return
                    }
                    throw fallbackErr
                  }
                } else {
                  sendJSON(res, 404, { error: `No asset "${filename}" for instance "${slug}"` })
                  return
                }
              } else {
                throw err
              }
            }
            // Detect base64-encoded binary (png/jpg) vs raw text: the fake server stores base64 strings for binary pushes, real Azure DevOps may also.
            const ext = extname(filename).toLowerCase()
            const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg'
            let buffer
            const cleaned = content.replace(/\s/g, '')
            const looksBase64 = cleaned.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(cleaned)
            if (isImage && looksBase64) {
              try {
                buffer = Buffer.from(content, 'base64')
              } catch {
                buffer = Buffer.from(content, 'utf8')
              }
            } else if (looksBase64 && isImage) {
              buffer = Buffer.from(content, 'base64')
            } else {
              // For images that were committed as raw binary via git, the Items API may return base64 anyway; try decode if it round-trips.
              if (isImage && looksBase64) {
                buffer = Buffer.from(content, 'base64')
              } else {
                buffer = Buffer.from(content, 'utf8')
              }
            }
            const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
            res.writeHead(200, { 'Content-Type': contentType })
            res.end(buffer)
          })
          return
        }
        try {
          const { path } = getAsset(slug, assetFileMatch[1], { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) })
          if (!existsSync(path)) {
            sendJSON(res, 404, { error: 'Asset file missing on disk' })
            return
          }
          res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(path)] ?? 'application/octet-stream' })
          res.end(readFileSync(path))
        } catch (err) {
          sendJSON(res, 404, { error: err.message })
        }
        return
      }

      // Identity search endpoint (#145 Part 2) — proxies Azure DevOps's
      // Identities API behind the standard PAT credential seam. Returns an
      // array of `{ uniqueName, displayName, emailAddress, id }` objects
      // for the front-end's identity picker component. Scoped to the same
      // organization/project the requesting PAT authenticates against.
      if (url.pathname === '/api/identities' && req.method === 'GET') {
        const query = url.searchParams.get('q') ?? ''
        if (!query.trim()) {
          sendJSON(res, 200, [])
          return
        }

        // We need *any* Azure DevOps location to know which org/project to
        // search. For the identity endpoint, we accept the `slug` param
        // (like every other single-instance route) to resolve the org/project,
        // or — new for WI253 — explicit `organization` + `project` query params
        // when no slug is given (mirroring GET /api/azure-devops/work-item-types),
        // or fall back to the first registered workspace if none of those are given.
        const { slug: identitySlug } = resolveSlugParam(url, defaultSlug, instancesDir)
        let orgProject = null
        if (identitySlug) {
          orgProject = resolveAzureDevOpsLocation(identitySlug, instancesDir)
        }
        if (!orgProject) {
          const orgParam = url.searchParams.get('organization')
          const projParam = url.searchParams.get('project')
          const hasOrgProj = orgParam || projParam
          if (hasOrgProj) {
            const missing = ['organization', 'project'].filter((name) => !url.searchParams.get(name))
            if (missing.length > 0) {
              sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
              return
            }
            const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
            if (requestedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(requestedBaseUrl)) {
              sendJSON(res, 400, {
                error:
                  'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
                  'need to check a location on a self-hosted Azure DevOps Server instance.',
              })
              return
            }
            orgProject = { organization: orgParam, project: projParam, baseUrl: requestedBaseUrl }
          }
        }
        if (!orgProject) {
          // Fall back to the first registered workspace
          const workspaces = listWorkspaces({ instancesDir })
          if (workspaces.length > 0) {
            orgProject = {
              organization: workspaces[0].organization,
              project: workspaces[0].project,
              baseUrl: workspaces[0].baseUrl,
            }
          }
        }
        if (!orgProject) {
          // No Azure DevOps context exists anywhere to search against (a
          // purely local instance, no registered workspace). This isn't a
          // caller error — free-text fields like Assignee route through this
          // same identity-search widget even when no ADO org/project is ever
          // going to be available — so it's reported as "no matches" (200),
          // not a 400. A 4xx here would make Chromium log a console error on
          // every keystroke into those fields, for a state the picker
          // already renders correctly as "no results".
          sendJSON(res, 200, [])
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const identityClient = createAzureDevOpsIdentityClient({
            organization: orgProject.organization,
            project: orgProject.project,
            baseUrl: orgProject.baseUrl,
            pat,
          })
          const identities = await identityClient.searchIdentities(query)
          sendJSON(res, 200, identities)
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: 'identity search' })
            return
          }
          sendJSON(res, 500, { error: err.message })
        }
        return
      }

      // PUT /api/instance/required-reviewer — updates the per-instance
      // required-reviewer override (#145 Part 2). Empty string clears the
      // override (falling back to the workspace Owner at request-approval
      // time); a non-empty string is a uniqueName resolved through the
      // identity picker.
      if (url.pathname === '/api/instance/required-reviewer' && req.method === 'PUT') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const requiredReviewer = (body.requiredReviewer ?? '').toString()

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — required-reviewer overrides are only supported for Workspace-backed instances.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res)
          return
        }

        try {
          const azureDevOpsBase = { ...azureDevOpsLocation, pat }
          const branch = await resolveStageBranch(azureDevOpsBase, null, slug, null)
          const azureDevOps = { ...azureDevOpsBase, ...(branch ? { branch } : {}) }
          const instance = updateInstanceRequiredReviewer(slug, requiredReviewer, { azureDevOps: azureDevOps })
          sendJSON(res, 200, { slug, requiredReviewer: instance.requiredReviewer ?? '' })
        } catch (err) {
          if (err instanceof AzureDevOpsAuthenticationError) {
            sendAuthenticationRequired(res)
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Stateless local-workspace compute (docs/adr/0029, WI #294): a browser
      // holding a local workspace's files on the user's own machine POSTs the
      // file contents here — `{ definitionId, definitionVersion?, instanceYaml,
      // moduleFiles, assets? }` (+ `gate` for check, `artefact` for render/compile) —
      // and this runs the same `lib/` compute the CLI does inside a throwaway
      // temp directory, returning the result. No PAT, no registry, nothing
      // persisted: see lib/localWorkspace.js. Additive to and entirely separate
      // from the `/api/instance*` routes above. `compile` (WI314) is `render`'s
      // dry-run sibling — compiled markdown + reference-doc bytes, no `pandoc`
      // subprocess — for the client-side WASM Pandoc render path.
      const localComputeMatch = url.pathname.match(/^\/api\/local\/(status|check|validate|render|compile)$/)
      if (localComputeMatch && req.method === 'POST') {
        const operation = localComputeMatch[1]
        let rawBody
        try {
          rawBody = await readBodyWithLimit(req, LOCAL_WORKSPACE_LIMITS.maxBodyBytes)
        } catch (err) {
          if (err.tooLarge) {
            sendJSON(res, 413, {
              error: `Request body exceeds the ${LOCAL_WORKSPACE_LIMITS.maxBodyBytes}-byte limit for /api/local/* requests`,
            })
            return
          }
          throw err
        }
        let body
        try {
          body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        try {
          const result = await runLocalWorkspaceCompute(operation, body, { definitionsDir, repoDir: pkgRoot })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof LocalWorkspaceRequestError) {
            sendJSON(res, err.status, { error: err.message })
            return
          }
          throw err
        }
        return
      }

      // preact-iso's client-side routes (e.g. /instance/<slug>, the module editor per instance; /setup, the instance-setup wizard, #78) have no corresponding file under web/ — a fresh navigation or reload at one of those URLs must still get the app shell so the router can take over, exactly as / does. Every real static asset this app serves (app.js, style.css, prototypes/*.html, etc.) has a file extension; a client route path never does, so that's what distinguishes the two here.
      const relativePath = url.pathname.slice(1)
      if (extname(relativePath) === '' && !existsSync(join(webDir, relativePath))) {
        serveIndexHtml(req, res)
        return
      }

      serveStaticFile(req, res, webDir, relativePath)
    } catch (err) {
      sendJSON(res, 500, { error: err.message })
    }
  })
}
