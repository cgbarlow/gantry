import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYAML } from 'yaml'
import { loadDefinition, listDefinitions, loadDefinitionChangelog, writeDefinitionVersion, definitionVersionProjection, createDraftVersion, cloneDefinition, createBlankDefinition, publishDefinitionVersion, isDefinitionArchived, archiveDefinition, restoreDefinition, readDefinitionTemplate, writeDefinitionTemplate, readDefinitionReferenceDocx, writeDefinitionReferenceDocx, findDefinitionProblemsInStructure, TEMPLATE_NAME_RE } from './definition.js'
import { readInstance, readModule, writeModule, writeModules, createInstance, importInstanceToAzureDevOps, updateInstanceAssignee, updateInstanceRequiredReviewer, recordInstanceWorkItemLink, instanceDefinitionVersion, AZURE_DEVOPS_WORKSPACE_ROOT, githubAssetsDir, githubAssetPath, gitlabAssetsDir, gitlabAssetPath } from './instance.js'
import { emptyFieldValue } from './fieldShape.js'
import { getStatus } from './status.js'
import { checkGate, resolveCheckStage } from './check.js'
import { renderArtefact, prepareAzureDevOpsWasmRender, finishAzureDevOpsWasmRender, prepareGitHubWasmRender, finishGitHubWasmRender, prepareGitLabWasmRender, finishGitLabWasmRender, externaliseImagesForWasm } from './render.js'
import { findStageBranch, resolveStageBranch, stageBranchName, getStageSyncStatus, syncStageBranch } from './stageBranch.js'
import { findGitHubStageBranch, resolveGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
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
import {
  listDefinitionsAcrossHomes,
  findDefinitionHomeDefinitionsDir,
  assertDefinitionIdAvailable,
  definitionIdExistsIn,
  DefinitionIdConflictError,
  serverWorkspaceDefinitionsDir,
  listServerWorkspaceHomes,
  isLibraryRepoSourcedId,
  cloneFromLibraryRepoMirror,
  libraryRepoProblems,
} from './definitionHome.js'
import { listLibraryRepos, addLibraryRepo, resolveLibraryRepo, updateLibraryRepoCodeOwner } from './librarySettings.js'
import { refreshAllLibraryRepos, readLibraryRepoCacheMeta, missingLibraryPatMessage } from './libraryCache.js'
import {
  readWorkspaceVersionFolderFiles,
  fanOutPromoteDefinitionVersion,
  readPromotions,
  upsertPromotion,
  checkPromotionStatus,
} from './definitionPromote.js'
import {
  listAzureDevOpsDefinitions,
  listAzureDevOpsDefinitionIds,
  loadAzureDevOpsDefinition,
  createBlankAzureDevOpsDefinition,
  createAzureDevOpsDraftVersion,
  writeAzureDevOpsDefinitionVersion,
  publishAzureDevOpsDefinitionVersion,
  archiveAzureDevOpsDefinition,
  restoreAzureDevOpsDefinition,
} from './definitionAzureDevOps.js'
import {
  listGitHubDefinitions,
  listGitHubDefinitionIds,
  loadGitHubDefinition,
  createBlankGitHubDefinition,
  createGitHubDraftVersion,
  writeGitHubDefinitionVersion,
  publishGitHubDefinitionVersion,
  archiveGitHubDefinition,
  restoreGitHubDefinition,
} from './definitionGitHub.js'
import {
  listGitLabDefinitions,
  listGitLabDefinitionIds,
  loadGitLabDefinition,
  createBlankGitLabDefinition,
  createGitLabDraftVersion,
  writeGitLabDefinitionVersion,
  publishGitLabDefinitionVersion,
  archiveGitLabDefinition,
  restoreGitLabDefinition,
} from './definitionGitLab.js'
import { migrateLegacyWorkspaceDirectory } from './workspaceMigration.js'
import { resolveInstanceDataDir, ensureDefaultWorkspace } from './instanceDataDir.js'
import {
  parseBootstrapWorkspaces,
  applyBootstrapWorkspaces,
  parseSharedWorkspacePats,
  discoverBootstrapPatInstances,
} from './workspaceBootstrap.js'
import {
  registerWorkspace,
  listWorkspaces,
  updateWorkspace,
  resolveWorkspace,
  archiveWorkspace,
  restoreWorkspace,
  isWorkspaceArchived,
  getOrCreateWorkspace,
  findWorkspaceByLocation,
} from './workspaceRegistry.js'
import { assertValidProvider, normalizeProviderLocation, describeProviderLocation, DEFAULT_PROVIDER } from './provider.js'
import {
  instanceNumbersFor,
  getOrAssignWorkspaceNumber,
  formatInstanceRef,
  parseInstanceRef,
  resolveScopeAndSlugForRef,
  stageNumberForStageId,
  stageIdForNumber,
} from './numberRegistry.js'
import { createAsset, getAsset, listAssets, ALLOWED_EXTENSIONS } from './assets.js'
import { resolveContentStore, resolveWorkItems } from './providerRegistry.js'
import { getCredential, getSecondaryCredential } from './credential.js'
import { AuthenticationError, NotFoundError, RepoNotFoundError, providerDisplayName } from './providerErrors.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'
import { checkAzureDevOpsRepo, checkGitHubRepo, checkGitLabRepo, checkAtlassianRepo } from './repoCheck.js'
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
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { resolveIdentity as resolveIdentityCapability } from './providerRegistry.js'
import { requestStageReview, checkStageReviewStatus } from './stageReview.js'
import { isValidSlug, parseInstanceAddress } from './slug.js'
import { artefactFileUrl, commitUrl } from './azureDevOpsFileUrl.js'
import { artefactFileUrl as githubArtefactFileUrl, commitUrl as githubCommitUrl, issueUrl as githubIssueUrl } from './githubFileUrl.js'
import { artefactFileUrl as gitlabArtefactFileUrl, commitUrl as gitlabCommitUrl } from './gitlabFileUrl.js'
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
function buildReviewSummaryForArtefact(definition, artefact, instance, azureDevOpsLocation, commitInfo = null, provider = 'azure-devops') {
  const stage = definition.stages.find((s) => s.gate === artefact.gate) ?? null
  const version = `${definition.id} v${definition.version} · ${stage ? stage.title : artefact.title}`
  const stageTitle = stage ? stage.title : artefact.title
  // Date is the commit date when known (same value the old footer used);
  // left blank when the commit hasn't been allocated yet (the two-push
  // Azure-DevOps/GitHub flow) — compileArtefact merges it from options.commit later.
  const date = commitInfo?.date ?? ''
  // #16/#24: `azureDevOpsLocation` doubles as "whichever provider's location this render is against"
  // — `provider` picks which provider's own commitUrl builder reads it, since the shapes
  // (`{organization,project,repository}` vs `{owner,repository}`) aren't interchangeable. Explicit
  // per-provider checks, not a `provider === 'github' ? ... : <assume azure-devops>` ternary — a
  // third provider's own commit-URL builder plugs in as its own branch here (ADR-0039), rather than
  // silently having Azure DevOps's builder run against a shape it doesn't understand.
  const commitUrlBuilders = { github: githubCommitUrl, 'azure-devops': commitUrl, gitlab: gitlabCommitUrl }
  const commit = commitInfo
    ? {
        hash: commitInfo.hash,
        url:
          azureDevOpsLocation && commitInfo.fullHash
            ? commitUrlBuilders[provider]?.(azureDevOpsLocation, commitInfo.fullHash)
            : undefined,
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
    // #15/#24: a GitHub-linked instance's review.workItemId is an issue number, reached through the
    // web (not API) root — never Azure DevOps' own `_workitems/edit` convention. Explicit per-provider
    // branches (github vs. an absent-or-azure-devops workItem) rather than a `=== 'github' ? ... :
    // <assume azure-devops>` ternary — a work item linked under any other declared provider (#24's own
    // linkInstanceToWorkItem guard means none exist yet) falls through to `undefined` instead of being
    // rendered as a broken Azure DevOps URL.
    const referenceUrl =
      instance.workItem?.provider === 'github'
        ? githubIssueUrl(instance.workItem, review.workItemId)
        : instance.workItem && (instance.workItem.provider === undefined || instance.workItem.provider === 'azure-devops')
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

/**
 * The version of the gantry install rooted at `pkgRoot`, or `null` when it can't be read — an
 * install shipped without its `package.json`, or one whose `package.json` is unparseable or carries
 * no `version`. Never guesses and never substitutes a placeholder: a wrong version is worse than no
 * version at all here, since the only reason to report it is to confirm which build is actually
 * live (#117).
 *
 * Read from disk on every call rather than captured once, for the same reason bin/gantry.js's own
 * `gantryVersion` reads it rather than hardcoding a literal (WI #369): the answer has to be the
 * running install's own, so a release bump can never leave this reporting a version it isn't.
 */
export function readPackageVersion(pkgRoot) {
  try {
    const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
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

// A year, the longest `max-age` the spec gives any meaning to. Paired with `immutable` so a browser
// that supports it skips even the conditional request on a reload.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

function serveStaticFile(req, res, rootDir, relativePath, options = {}) {
  // `immutable` is opt-in per call and only ever granted to a URL that carries its own version token
  // (see the `/node_modules/` route). WI #368's `no-cache` stays the default for everything else,
  // because a URL that cannot change cannot be allowed to cache past an upgrade.
  const cacheControl = options.immutable ? IMMUTABLE_CACHE_CONTROL : 'no-cache'
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
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    ETag: etag,
    'Cache-Control': cacheControl,
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
  return emptyFieldValue(field)
}

// The structured "authentication required" response (#82's spec, built out here per #86). Missing credentials keep the original response shape; a supplied credential rejected by Azure DevOps carries safe diagnostic metadata so the frontend can explain the failure without ever echoing the PAT.
// `provider` names which system the PAT is for (docs/adr/0039, #7: "every authentication error surfaced
// to the user names the provider it came from") — every call site that's reacting to a caught
// `AuthenticationError` passes `err.provider` through; a call site rejecting an outright-missing
// credential (no error to read a tag from) has nothing more specific to name than the one provider
// every such route is currently gated on, so it falls back to 'azure-devops'.
function sendAuthenticationRequired(res, { credentialRejected = false, operation, provider = 'azure-devops' } = {}) {
  const providerName = providerDisplayName(provider)
  const body = {
    error: 'authentication_required',
    message:
      `A valid ${providerName} Personal Access Token is required for this instance. ` +
      'Provide it via HTTP Basic auth (empty username, PAT as password).',
  }
  if (credentialRejected) {
    body.credentialRejected = true
    body.credentialStatus = 'rejected'
    body.operation = operation
    const identityOperation = operation === 'identity search' || operation?.includes('required reviewer')
    body.message = operation
      ? `The ${providerName} PAT already provided was rejected while ${operation}. ` +
        (identityOperation
          ? 'It may need the Identity (Read) scope in addition to the scopes already configured.'
          : 'Check that it is valid and has the scopes required for this operation.')
      : `The ${providerName} PAT already provided was rejected for this request. It may be expired, invalid, or missing a required scope.`
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

// The GitHub twin of resolveAzureDevOpsLocation above (#11) — `{ owner, repository, baseUrl }` for a
// slug the registry says is GitHub-backed, `null` for everything else.
function resolveGitHubLocation(slug, instancesDir, scopeId) {
  const location = resolveInstanceLocation(slug, { instancesDir, scopeId })
  if (location?.kind !== 'github') return null
  const { owner, repository, baseUrl } = location
  return { owner, repository, baseUrl }
}

// #31 — the GitLab twin of resolveGitHubLocation above: `{ namespace, repository, baseUrl }` for a
// slug the registry says is GitLab-backed, `null` for everything else.
function resolveGitLabLocation(slug, instancesDir, scopeId) {
  const location = resolveInstanceLocation(slug, { instancesDir, scopeId })
  if (location?.kind !== 'gitlab') return null
  const { namespace, repository, baseUrl } = location
  return { namespace, repository, baseUrl }
}

// #24: genuine N-way dispatch over which provider backs an instance's location — the seam a good
// dozen routes below used to duplicate as their own `const azureDevOpsLocation = ...; const
// githubLocation = ...` pair, then pick between them with a ternary that assumed "not GitHub ⇒ must
// be Azure DevOps" (`githubLocation ? 'github' : 'azure-devops'`, `azureDevOpsLocation ? {azureDevOps:
// ...} : {github: ...}`). That assumption is exactly the anti-pattern ADR-0039 already rejected —
// harmless while only two providers existed, but silently wrong the moment a third (GitLab, ADR-0041)
// location existed, since it would be swept into whichever branch's resolver came first here. Tried
// in a fixed order; the first resolver that finds a location wins — a slug can only ever be
// registered against one provider (ADR-0037), so at most one ever matches in practice.
const INSTANCE_PROVIDER_LOCATION_RESOLVERS = {
  'azure-devops': resolveAzureDevOpsLocation,
  github: resolveGitHubLocation,
  gitlab: resolveGitLabLocation,
}

// Resolves `slug`'s provider-backed location generically — `{ provider, location }` for whichever
// registered provider resolver matches, or `null` when this instance isn't provider-backed at all (a
// local/server-workspace instance, the only case every resolver above returns `null` for).
function resolveInstanceProviderLocation(slug, instancesDir, scopeId) {
  for (const [provider, resolve] of Object.entries(INSTANCE_PROVIDER_LOCATION_RESOLVERS)) {
    const location = resolve(slug, instancesDir, scopeId)
    if (location) return { provider, location }
  }
  return null
}

// The options key each provider's own read/write functions (lib/instance.js, lib/status.js, ...)
// expect their location nested under — `azureDevOps`/`github` today, extended by one entry per
// provider as each one's own capability lands (mirrors lib/providerRegistry.js's own provider-keyed
// shape, one layer up).
const PROVIDER_OPTION_KEY = {
  'azure-devops': 'azureDevOps',
  github: 'github',
  gitlab: 'gitlab',
}

// Builds `{ [providerOptionKey]: { ...location, pat } }` for whichever provider `resolved` names —
// the one payload shape every downstream call below already expects, without the call site itself
// needing an explicit per-provider branch to build it.
function providerCredentialOptions(resolved, pat) {
  return { [PROVIDER_OPTION_KEY[resolved.provider] ?? resolved.provider]: { ...resolved.location, pat } }
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

// WI #383 (ADR-0036) — "instance loading resolves the pinned definition/definitionVersion from the
// workspace first, then falls back to the library". Deliberately resolves through `resolveLocalDataDir`
// (the *same* slug/scopeId resolution every instance-serving route already uses to find the instance's
// own data directory) rather than mapping `scopeId` to a folder name directly
// (`lib/definitionHome.js`'s `definitionsDirForInstanceScope`, still exported for a caller that already
// knows its workspace folder — see `lib/registry.js`'s `localRowDefinitionsDir`): a request that
// addresses its instance by a bare, unqualified slug (ADR-0031's still-supported deprecated form) has
// `scopeId` unset at this point, so mapping it directly would miss the workspace entirely, exactly the
// gap `resolveLocalDataDir`'s own deprecated-bare-slug search already closes for the instance itself.
// A `scopeId`/slug combination that isn't a directory-backed server workspace (an Azure DevOps
// workspace's own instance, or a slug this server has never heard of) never names a real folder under
// `instancesDir`, so the existence check below naturally falls through to the library for both — no
// special-casing needed for the Azure-DevOps-backed or unscoped cases.
// WI #386: falls through to `findDefinitionHomeDefinitionsDir` (packaged library, every server
// workspace, and every cached library repo) when `definitionId` isn't this instance's own
// workspace's `definitions/` folder, rather than assuming it's always the plain packaged
// `definitionsDir` — every call site below reads a *running instance's* definition, so this is what
// makes "an instance already pinned to a library-repo definition keeps working from the cache, even
// if that repo is currently unreachable" true everywhere an instance is read, not only in the
// definitions editor's own routes. Falls back to the caller's own `definitionsDir` (the pre-existing
// behavior) if the id genuinely isn't found anywhere.
function definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, definitionId) {
  const resolvedInstanceDir = resolveLocalDataDir(slug, instancesDir, scopeId)
  const workspaceDefinitionsDir = join(resolvedInstanceDir, 'definitions')
  if (existsSync(join(workspaceDefinitionsDir, definitionId))) return workspaceDefinitionsDir
  return findDefinitionHomeDefinitionsDir(definitionId, { definitionsDir, instancesDir }) ?? definitionsDir
}

// WI #383: every `:id`-keyed definitions route below (versions, templates, reference-docx, changelog,
// archive/restore, publish) already validated `rawId` against a `knownIds` set before reaching here —
// once that set includes server-workspace rows too (`listDefinitionsAcrossHomes`'s `includeWorkspaces`),
// this is the one extra step each route needs: which physical `definitionsDir` actually holds it. An id
// can only ever live in one place (ADR-0036's uniqueness guarantee), so no route needs to know or care
// which home `rawId` came from beyond this.
function resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) {
  return findDefinitionHomeDefinitionsDir(rawId, { definitionsDir, instancesDir }) ?? definitionsDir
}

// WI #386: "library-repo definitions are read-only in the editor ... no direct edit". A
// library-repo-sourced id resolves (via `findDefinitionHomeDefinitionsDir`) to
// lib/libraryCache.js's own mirrored, wholly-derived `definitions/` directory, never one this
// server should accept a write against — every mutating `:id`-keyed route below calls this first
// (right after its own pre-existing `knownIds.has(rawId)` check) and returns early with a clear 403
// instead of reaching a write. Returns `true` (and has already sent the response) when `rawId` is
// library-repo-sourced; `false` otherwise, so a caller writes
// `if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return`.
function rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir) {
  if (!isLibraryRepoSourcedId(rawId, { definitionsDir, instancesDir })) return false
  sendJSON(res, 403, {
    error: `Definition "${rawId}" is read-only — it comes from a library repo. Clone it into a workspace to edit.`,
  })
  return true
}

function instanceStageUrl(req, slug, stageId) {
  const forwardedProtocol = req.headers['x-forwarded-proto']?.split(',')[0]?.trim()
  const protocol = forwardedProtocol || 'http'
  const host = req.headers.host || 'localhost'
  const stageQuery = stageId ? `?stage=${encodeURIComponent(stageId)}` : ''
  return `${protocol}://${host}/instance/${encodeURIComponent(slug)}${stageQuery}`
}

// Gates an Azure-DevOps-backed instance-data route behind the credential-provider seam (lib/credential.js): with no PAT on the request, responds with the structured "authentication required" response and never calls `fn` at all; with one, calls `fn({ ...azureDevOpsLocation, pat })` and — if Azure DevOps itself rejects that PAT (`AuthenticationError`, surfaced from lib/instance.js/lib/status.js/lib/render.js's Azure-DevOps-backed paths) — responds with that exact same structured response rather than letting it fall through as a generic error. Any other error `fn` throws propagates to the server's own top-level catch (a 500), unchanged.
async function withAzureDevOpsCredential(req, res, azureDevOpsLocation, fn) {
  const pat = getCredential(req)
  if (!pat) {
    sendAuthenticationRequired(res)
    return
  }
  try {
    await fn({ ...azureDevOpsLocation, pat })
  } catch (err) {
    if (err instanceof AuthenticationError) {
      sendAuthenticationRequired(res, { provider: err.provider })
      return
    }
    throw err
  }
}

// The GitHub twin of withAzureDevOpsCredential above (#11) — identical shape, defaulting the missing-
// PAT response to name 'github' rather than that function's 'azure-devops' default, so a GitHub-backed
// route with no PAT at all still prompts for the right provider (docs/adr/0039's "every authentication
// error names the provider it came from").
async function withGitHubCredential(req, res, githubLocation, fn) {
  const pat = getCredential(req)
  if (!pat) {
    sendAuthenticationRequired(res, { provider: 'github' })
    return
  }
  try {
    await fn({ ...githubLocation, pat })
  } catch (err) {
    if (err instanceof AuthenticationError) {
      sendAuthenticationRequired(res, { provider: err.provider })
      return
    }
    throw err
  }
}

// #31 — the GitLab twin of withGitHubCredential above (#26): identical shape, defaulting the
// missing-PAT response to name 'gitlab' rather than 'github'/'azure-devops', so a GitLab-backed route
// with no PAT at all still prompts for the right provider (docs/adr/0039's "every authentication
// error names the provider it came from"). #32 reuses this same helper for GitLab's
// workspace-definitions routes.
async function withGitLabCredential(req, res, gitlabLocation, fn) {
  const pat = getCredential(req)
  if (!pat) {
    sendAuthenticationRequired(res, { provider: 'gitlab' })
    return
  }
  try {
    await fn({ ...gitlabLocation, pat })
  } catch (err) {
    if (err instanceof AuthenticationError) {
      sendAuthenticationRequired(res, { provider: err.provider })
      return
    }
    throw err
  }
}

// #24/#32: every `/api/workspaces/:workspaceId/definitions*` route below dispatches on
// `workspace.provider` — a GitHub branch, then (since #32) a GitLab branch, then an *unconditional*
// Azure DevOps one. #24 originally guarded the Azure DevOps fallback with this function because
// `gitlab` had just become a validated, `getOrCreateWorkspace`-accepted provider (ADR-0041) with no
// workspace-definitions support of its own yet — an unguarded fallback would have run Azure DevOps
// logic against a GitLab-shaped workspace location. #32 gives GitLab its own branch at every one of
// these call sites, so in practice every currently-supported provider now returns before reaching
// this function; it stays in place as a fail-safe for any *future* provider added to
// `lib/provider.js` without workspace-definitions support of its own — returns whether it already
// responded, so a caller writes `if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return`.
function rejectUnlessAzureDevOpsWorkspace(res, workspace) {
  if (workspace.provider === 'azure-devops') return false
  sendJSON(res, 400, { error: `Workspace definitions are not supported yet for provider "${workspace.provider}".` })
  return true
}

// The Azure-DevOps half of ADR-0036's "ids are unique across the server library and every workspace;
// no shadowing" (review finding on WI #383: `assertDefinitionIdAvailable` and its two callers below
// only ever scanned the local filesystem — the library and every *server* workspace — so two Azure
// DevOps workspaces (or an Azure DevOps workspace and the library/a server workspace) could silently
// share an id). Every registered Azure DevOps workspace (`excludeWorkspaceId` left out, since a
// caller that's already about to scan *that* one workspace itself — the create-in-this-workspace
// route below — would otherwise double-fetch it) is asked for its own already-known ids, using the
// same PAT the current request already carries (per lib/credential.js's doc comment, the browser
// attaches it to every request, not just Azure-DevOps-gated ones).
//
// Deliberately best-effort, not all-or-nothing: with no PAT on the request at all, this returns `[]`
// immediately rather than blocking an ordinary library/server-workspace create for a caller who has
// never configured Azure DevOps; and a workspace that this PAT can't reach (wrong organization, a
// revoked token, a network blip) is skipped rather than failing the whole create — the same
// "verify what we can, don't hold a write hostage to a workspace nobody asked about" trade-off
// lib/definitionHome.js's own doc comment already makes for server-workspace scanning being
// local-filesystem-only. A caller that specifically targets an Azure DevOps workspace still gets a
// hard "authentication required" for *that* workspace via `withAzureDevOpsCredential`, unchanged.
async function collectOtherAzureDevOpsDefinitionIds({ instancesDir, pat, excludeWorkspaceId } = {}) {
  if (!pat) return []
  const workspaces = listWorkspaces({ instancesDir }).filter(
    (w) => w.provider === 'azure-devops' && w.id !== excludeWorkspaceId
  )
  const ids = []
  for (const workspace of workspaces) {
    try {
      const workspaceIds = await listAzureDevOpsDefinitionIds({ azureDevOps: { ...workspace.location, pat } })
      ids.push(...workspaceIds)
    } catch {
      // Unreachable/unauthorized for this PAT — best-effort, skip it (see doc comment above).
    }
  }
  return ids
}

// #17 — the GitHub twin of collectOtherAzureDevOpsDefinitionIds above: same best-effort, same
// single ambient PAT (docs/adr/0038 — the browser attaches one credential to every request
// regardless of which provider it's ultimately checked against), same "one unreachable workspace
// never blocks the rest" tolerance. Kept as a separate function rather than a provider parameter so
// each stays a straight-line mirror of its own provider's client/error shapes, matching this file's
// existing azureDevOps/github pairing convention (e.g. withAzureDevOpsCredential/withGitHubCredential).
async function collectOtherGitHubDefinitionIds({ instancesDir, pat, excludeWorkspaceId } = {}) {
  if (!pat) return []
  const workspaces = listWorkspaces({ instancesDir }).filter((w) => w.provider === 'github' && w.id !== excludeWorkspaceId)
  const ids = []
  for (const workspace of workspaces) {
    try {
      const workspaceIds = await listGitHubDefinitionIds({ github: { ...workspace.location, pat } })
      ids.push(...workspaceIds)
    } catch {
      // Unreachable/unauthorized for this PAT — best-effort, skip it (see doc comment above).
    }
  }
  return ids
}

// #32 — the GitLab twin of collectOtherGitHubDefinitionIds/collectOtherAzureDevOpsDefinitionIds
// above: same best-effort, single-ambient-PAT, "one unreachable workspace never blocks the rest"
// contract, kept as its own straight-line function for the same reason those two are (a mirror of
// GitLab's own client/error shapes, not a provider parameter).
async function collectOtherGitLabDefinitionIds({ instancesDir, pat, excludeWorkspaceId } = {}) {
  if (!pat) return []
  const workspaces = listWorkspaces({ instancesDir }).filter((w) => w.provider === 'gitlab' && w.id !== excludeWorkspaceId)
  const ids = []
  for (const workspace of workspaces) {
    try {
      const workspaceIds = await listGitLabDefinitionIds({ gitlab: { ...workspace.location, pat } })
      ids.push(...workspaceIds)
    } catch {
      // Unreachable/unauthorized for this PAT — best-effort, skip it (see doc comment above).
    }
  }
  return ids
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
    ...(field.type === 'select' ? { options: field.options, multiple: field.multiple === true ? true : undefined, default: field.default } : {}),
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
    if (err instanceof NotFoundError) return null
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

  // #121 (parent #109, docs/adr/0047): `GANTRY_SHARED_WORKSPACE_PATS` — a rename of #113/docs/adr/0046's
  // now-superseded env var, no alias for the old name — a `{ workspaceId: pat }`
  // map (same shape/validation style as `GANTRY_WORKSPACE_PATS`, mcp-server/src/credentials.js's
  // `parseWorkspacePats`) now doing two jobs, not one: the boot-time discovery pass further down (still
  // gated behind `options.migrateWorkspacesOnStart`, unchanged in what it does) AND, the point of this
  // ticket, the credential `GET /api/instances` (below) falls back to for a request that carries none
  // of its own — a workspace with an entry here is *shared*: every visitor sees its rows, not just one
  // who happens to already hold a Provider credential for it. Parsed here, unconditionally — not inside
  // the `migrateWorkspacesOnStart` gate below — because request-time row-building must see it on every
  // `createServer` call, migration-on-start or not. `options.sharedWorkspacePats`, when supplied,
  // overrides `process.env.GANTRY_SHARED_WORKSPACE_PATS` outright (the same options-first-env-var-
  // fallback convention `bootstrapWorkspaces` below uses) — both are the env var's own raw JSON-object
  // string, parsed the identical way regardless of source, so a test can inject a value without
  // mutating `process.env`. A malformed value throws here, before this server ever calls `.listen()`,
  // exactly like a malformed `GANTRY_BOOTSTRAP_WORKSPACES` already does. Unset — the default — parses
  // to `{}`: no workspace is shared, `GET /api/instances` behaves byte-for-byte as it did before this
  // ticket, and the boot-time discovery pass further down has nothing to iterate either.
  const rawSharedWorkspacePats =
    options.sharedWorkspacePats !== undefined ? options.sharedWorkspacePats : process.env.GANTRY_SHARED_WORKSPACE_PATS
  const sharedWorkspacePats = parseSharedWorkspacePats(rawSharedWorkspacePats)

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

    // #111 (parent #109): `GANTRY_BOOTSTRAP_WORKSPACES` — an operator declares the workspaces a
    // deployment should always have, and every real `gantry serve` boot rebuilds those registrations
    // idempotently (`lib/workspaceBootstrap.js`), so an ephemeral container filesystem stops mattering.
    // Gated by the same `options.migrateWorkspacesOnStart` flag as the migrate/ensure-default-workspace
    // block just above, deliberately reusing it rather than introducing a second on/off knob — "runs
    // once per real serve, tests opt in explicitly" is exactly the posture this boot step wants too.
    // `options.bootstrapWorkspaces`, when supplied, overrides `process.env.GANTRY_BOOTSTRAP_WORKSPACES`
    // outright (the same "options first, env var fallback" convention `libraryPats` below uses) — both
    // are the env var's own raw JSON-array string, parsed the identical way regardless of source, so a
    // test can inject a value without mutating `process.env`. A malformed declaration throws here,
    // before this server ever calls `.listen()` — `bin/gantry.js`'s `serve` action is what turns that
    // into a single-line, non-stack-trace failure at the process level.
    const rawBootstrapWorkspaces =
      options.bootstrapWorkspaces !== undefined ? options.bootstrapWorkspaces : process.env.GANTRY_BOOTSTRAP_WORKSPACES
    const bootstrappedWorkspaces = applyBootstrapWorkspaces(parseBootstrapWorkspaces(rawBootstrapWorkspaces), { instancesDir })

    // #115 (parent #109): one line per bootstrapped workspace, naming the location and the id it is
    // actually registered under. `GANTRY_SHARED_WORKSPACE_PATS` and the MCP server's `GANTRY_WORKSPACE_PATS`
    // are both keyed by that id, and on a hosted platform the deploy log is the one place an operator
    // can always read it — no shell, no browser round trip to `GET /api/workspaces`. `gantry
    // workspace-id` computes the same id offline; this line is the authority for what THIS server
    // ended up with, which differs only in the one case bootstrap deliberately allows: a workspace
    // already registered at that location keeps the id it was first registered under rather than being
    // re-keyed to the derived one (see `deriveWorkspaceId`'s own doc comment). The location is
    // formatted by `lib/provider.js`'s `describeProviderLocation`, never per-provider here. No PAT is
    // involved: this runs before any workspace's `GANTRY_SHARED_WORKSPACE_PATS` entry is used, and
    // prints registry facts only.
    for (const workspace of bootstrappedWorkspaces) {
      console.log(
        `gantry serve: bootstrapped workspace ${workspace.provider} ${describeProviderLocation(workspace.provider, workspace.location)} — id ${workspace.id}`
      )
    }

    // The boot-time-discovery half of `GANTRY_SHARED_WORKSPACE_PATS` (parsed once, unconditionally,
    // above) — unchanged in what it does since #113/docs/adr/0046: a bootstrap-registered workspace
    // with a matching entry has its instances discovered immediately at boot
    // (`lib/workspaceBootstrap.js`'s `discoverBootstrapPatInstances`, wrapping #112's
    // `backfillProviderInstances`), so `GET /api/instances` is already populated before any browser
    // request arrives — closing the gap #112 alone leaves (instances reappear only on the first
    // authenticated request), which for an unattended deployment (the hosted demo) looks
    // indistinguishable from "still broken". Unset — the default — parses to `{}` above,
    // `discoverBootstrapPatInstances` has nothing to iterate, and nothing below this point runs: zero
    // behavior change, discovery still only ever runs on #112's request-credential path otherwise.
    if (Object.keys(sharedWorkspacePats).length > 0) {
      // Fire-and-forget, the same posture as the startup library-repo refresh further down: never
      // awaited (a slow or unreachable Provider host must not delay this server actually starting to
      // listen), and a rejected/expired shared PAT degrades to "this workspace just isn't discovered at
      // boot, the request-credential path still works later" rather than failing startup —
      // `discoverBootstrapPatInstances` itself already catches and logs per workspace, this outer
      // `.catch` is only a backstop against something failing outside that per-workspace loop.
      discoverBootstrapPatInstances(bootstrappedWorkspaces, sharedWorkspacePats, { instancesDir }).catch((err) => {
        console.error(`lib/server.js: startup shared-workspace-PAT instance discovery failed — ${err.message}`)
      })
    }
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
  // The same SSRF guard as `allowAzureDevOpsBaseUrlOverride` above, gating `POST /api/workspaces`'s
  // own caller-supplied `baseUrl` when the workspace being registered is on GitHub — a GitHub
  // Enterprise Server host, per #8's own acceptance criteria and docs/adr/0039's "per-provider flag
  // with identical semantics". A single generic flag covering both providers is left for a later
  // ticket (docs/adr/0039 names this as the target shape, but renaming
  // `allowAzureDevOpsBaseUrlOverride` itself touches every existing caller/test of that option) —
  // for now the two are separate, provider-named flags with the same trust model and the same
  // default-`false`, fail-closed posture.
  const allowGitHubBaseUrlOverride = options.allowGitHubBaseUrlOverride ?? false
  // The GitLab twin of `allowGitHubBaseUrlOverride` above (#28) — self-hosted GitLab CE/EE (ADR-0041)
  // needs the exact same caller-supplied-`baseUrl` SSRF guard, so it gets its own identically-shaped,
  // default-`false`, fail-closed flag rather than being folded into the GitHub one. `GET
  // /api/identities`'s own `provider=gitlab` branch was the first route to consult it; #30 adds a
  // second — `POST /api/instance/work-items/link`'s own `gitlab` branch, the same SSRF-prevention
  // posture for that route's caller-supplied `baseUrl`. Workspace registration's own `baseUrl` gating
  // (the `POST /api/workspaces` twin of `allowGitHubBaseUrlOverride` above) is #25's job, not yet wired
  // as of this ticket. Left `false` by default; only tests (against the fake GitLab server) opt in.
  const allowGitLabBaseUrlOverride = options.allowGitLabBaseUrlOverride ?? false

  // #48 (ADR-0042): Atlassian v1 is Cloud-only, so — unlike every other provider's own
  // `allow*BaseUrlOverride` flag above — there is deliberately no caller-supplied override to gate at
  // all: a request can never redirect this server's own Bitbucket/Jira calls anywhere. These two
  // options exist purely for this suite's own server-integration tests to point `checkAtlassianRepo`
  // (`POST /api/workspaces`'s atlassian path) at `tests/helpers/fakeBitbucketServer.js`/
  // `fakeJiraServer.js` instead of the real, fixed `api.bitbucket.org`/`<jiraSite>` hosts — set only by
  // `createServer`'s own caller (a test), never derived from a request.
  const atlassianBitbucketBaseUrl = options.atlassianBitbucketBaseUrl
  const atlassianJiraBaseUrl = options.atlassianJiraBaseUrl

  // WI #386 (ADR-0036): "read with the server PAT" — a library repo is read by the server itself, at
  // startup, before any browser request (and its own per-request PAT, lib/credential.js) exists at
  // all — so this is a single credential resolved once here, never a per-request one.
  // `options.libraryPat` lets a test (or an embedder of this module) supply it directly, the same
  // "options first, env var fallback" convention `bin/gantry.js` already uses for
  // GANTRY_INSTANCES_DIR/GANTRY_WORKSPACES_DIR. With neither set, library repos stay configured but
  // unread — every read attempt reports "no server PAT configured" rather than silently doing
  // nothing, and any already-cached content keeps serving regardless (graceful degradation, WI #386).
  // `!== undefined` (not `??`) so a caller — a test proving the "no server PAT configured" path —
  // can pass `libraryPat: null` to force that deterministically, regardless of this process's own
  // environment; only actually *omitting* the option falls back to the env var.
  //
  // #19 (ADR-0039): "GANTRY_LIBRARY_PAT is a single provider-blind environment variable ... replaced
  // by one variable per provider ... with the existing name kept as a deprecated alias for the Azure
  // DevOps one." `options.libraryPat` keeps meaning "the Azure DevOps one" for every existing caller
  // (falling back to the new GANTRY_LIBRARY_PAT_AZURE_DEVOPS, then the deprecated GANTRY_LIBRARY_PAT,
  // exactly as before when neither option is supplied); `options.libraryPatGithub` is the GitHub
  // counterpart, resolved the same "option first, env var fallback" way. #27 (ADR-0041) adds
  // `options.libraryPatGitlab`/`GANTRY_LIBRARY_PAT_GITLAB` as the third, identical slot — no
  // deprecated alias, since GitLab has no prior provider-blind variable to be backward compatible
  // with. `options.libraryPats`, if supplied, overrides all three at once — for a test (or embedder)
  // that wants to hand the whole per-provider map directly rather than one option per provider.
  const libraryPats =
    options.libraryPats !== undefined
      ? options.libraryPats
      : {
          'azure-devops':
            options.libraryPat !== undefined
              ? options.libraryPat
              : (process.env.GANTRY_LIBRARY_PAT_AZURE_DEVOPS ?? process.env.GANTRY_LIBRARY_PAT ?? null),
          github: options.libraryPatGithub !== undefined ? options.libraryPatGithub : (process.env.GANTRY_LIBRARY_PAT_GITHUB ?? null),
          // #27 (ADR-0041): GitLab's own slot, resolved the identical "option first, env var
          // fallback" way as the GitHub one above — no deprecated alias, since GitLab is new.
          gitlab: options.libraryPatGitlab !== undefined ? options.libraryPatGitlab : (process.env.GANTRY_LIBRARY_PAT_GITLAB ?? null),
          // #49 (ADR-0042): Atlassian's own slot — a single token, not a `{bitbucket, jira}` pair,
          // since a Library repo needs only its Bitbucket environment credential (reading
          // `definitions/` and opening a Promote pull request are both content-store-only
          // operations that never touch Jira). No deprecated alias, same reasoning as GitLab's.
          atlassian: options.libraryPatAtlassian !== undefined ? options.libraryPatAtlassian : (process.env.GANTRY_LIBRARY_PAT_ATLASSIAN ?? null),
        }

  // "Re-read at startup ... no polling, no TTL" (WI #386): fire-and-forget, one pass over every
  // configured library repo, right now — never awaited (a slow or unreachable repo must not delay
  // this server actually starting to listen) and never retried on a timer. `options.skipLibraryRepoStartupRefresh`
  // lets a test suppress this (most tests never configure a library repo at all, so
  // `refreshAllLibraryRepos` is a fast no-op for them regardless — this is only for a test that wants
  // to control exactly when a refresh happens instead of racing this startup one).
  if (!options.skipLibraryRepoStartupRefresh) {
    const configuredRepos = listLibraryRepos({ instancesDir })
    if (configuredRepos.length > 0) {
      refreshAllLibraryRepos(configuredRepos, { instancesDir, pats: libraryPats }).catch((err) => {
        console.error(`lib/server.js: startup library-repo refresh failed — ${err.message}`)
      })
    }
  }

  // The token every `/node_modules/*` URL in the import map carries, so those URLs change whenever
  // the installed dependency set does — which is what makes it safe to serve them as immutable
  // rather than revalidating all ~40 of them on every single page load (WI #368 left the browser
  // with no choice but the latter, turning one page load into ~40 conditional round trips; on a
  // constrained host that burst is what tips into dropped connections).
  //
  // Derived from `package-lock.json`, the one file that changes on *any* dependency change,
  // including a transitive one a `version` bump would miss. If it isn't readable — a deployment that
  // ships `node_modules` without the lockfile — fall back to the package version, and failing that
  // skip versioning entirely so those URLs stay bare and keep today's `no-cache` behaviour. Never
  // guess a token: a wrong one would cache a stale dependency for a year.
  const assetVersion = (() => {
    for (const file of ['package-lock.json', 'package.json']) {
      try {
        return createHash('sha1').update(readFileSync(join(pkgRoot, file))).digest('hex').slice(0, 12)
      } catch {
        continue
      }
    }
    return undefined
  })()

  const importMap = buildImportMap(FRONT_END_SPECIFIERS, { nodeModulesDir, version: assetVersion })

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
        // Only a request carrying *this* server's own token is cached forever. An absent or stale
        // `?v=` means the URL didn't come from the import map this process just built — a hand-typed
        // path, or a page shell cached from before an upgrade — so it revalidates as it always has
        // and can never pin the wrong bytes.
        const immutable = assetVersion !== undefined && url.searchParams.get('v') === assetVersion
        serveStaticFile(req, res, nodeModulesDir, url.pathname.slice('/node_modules/'.length), { immutable })
        return
      }

      // #117 — which version of gantry this deployment is running, answered by the server itself.
      // `{ version }` and nothing else: no paths, no env vars, no SHA, no build metadata (this
      // ticket's own "version string only" scope), and `null` rather than a placeholder when the
      // install's `package.json` can't be read.
      //
      // Deliberately uncredentialed, unlike the Provider-backed routes below: the version isn't
      // sensitive, and gating it would defeat the purpose — an unauthenticated visitor asking "what
      // version are you on?" is exactly who this exists for.
      //
      // Read from `pkgRoot` per request, not baked into the front-end bundle: a browser serving a
      // cached `app.js` from before a redeploy would otherwise report the *old* version, which is
      // precisely the failure this route exists to prevent.
      if (url.pathname === '/api/version' && req.method === 'GET') {
        sendJSON(res, 200, { version: readPackageVersion(pkgRoot) })
        return
      }

      // WI #383 (ADR-0036): `?includeWorkspaces=1` unions the library with every locally-visible
      // server workspace's own `definitions/` folder, each row tagged `home` — the Definitions page
      // switcher's "Server / Workspace: <name>" grouping and the "+ New Workspace" wizard's definition
      // picker both ask for this. Without it, this route is byte-for-byte unchanged (library rows
      // only, no `home` field difference any existing caller depends on) from before this ticket.
      if (url.pathname === '/api/definitions' && req.method === 'GET') {
        const includeArchived = url.searchParams.get('archived') === '1'
        const includeWorkspaces = url.searchParams.get('includeWorkspaces') === '1'
        sendJSON(res, 200, listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived, includeWorkspaces }))
        return
      }

      // New definition: POST /api/definitions { sourceId, newId } clones; { newId, title } (no
      // sourceId) starts blank — the editor's New definition "Blank or Clone" choice (WI #381).
      //
      // WI #383 (ADR-0036): an optional `home: { kind: 'server-workspace', id }` targets a server
      // workspace's own `definitions/` folder instead of the library (the default, and the only
      // option before this ticket — `home` omitted or `{ kind: 'library' }` is byte-for-byte the
      // pre-existing behavior). Either way, `newId` is checked against *every* home — the library and
      // every server workspace — before anything is written: "ids are unique across the server
      // library and every workspace; no shadowing", refused as 409 on a collision, never silently
      // reused. Clone stays scoped to the *target* home's own definitions, same as the library's own
      // clone always has been — bringing content in from a different home is WI #382's copy flow, not
      // this route.
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
        const home = body?.home
        let targetDefinitionsDir = definitionsDir
        if (home !== undefined && home !== null && home.kind !== 'library') {
          if (home.kind !== 'server-workspace' || typeof home.id !== 'string') {
            sendJSON(res, 400, { error: 'home must be { kind: "library" } or { kind: "server-workspace", id }' })
            return
          }
          if (!listServerWorkspaceHomes(instancesDir).some((w) => w.id === home.id)) {
            sendJSON(res, 400, { error: `Unknown workspace "${home.id}"` })
            return
          }
          targetDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, home.id)
        }
        // A collision in the home actually being written to is the pre-existing "already exists" 400
        // (`cloneDefinition`/`createBlankDefinition`'s own check, below, unchanged); ADR-0036's new
        // no-shadowing rule — a collision in any *other* home, including an Azure DevOps, GitHub or
        // GitLab workspace's (`collectOtherAzureDevOpsDefinitionIds`/`collectOtherGitHubDefinitionIds`/
        // `collectOtherGitLabDefinitionIds`, above) — is the new 409, checked only when the target
        // itself is free, so the pre-existing 400 contract for a same-store collision never changes
        // underfoot.
        if (!definitionIdExistsIn(targetDefinitionsDir, newId)) {
          try {
            const pat = getCredential(req)
            const azureDevOpsIds = await collectOtherAzureDevOpsDefinitionIds({ instancesDir, pat })
            const githubIds = await collectOtherGitHubDefinitionIds({ instancesDir, pat })
            const gitlabIds = await collectOtherGitLabDefinitionIds({ instancesDir, pat })
            assertDefinitionIdAvailable(newId, { definitionsDir, instancesDir, extraKnownIds: [...azureDevOpsIds, ...githubIds, ...gitlabIds] })
          } catch (err) {
            if (err instanceof DefinitionIdConflictError) {
              sendJSON(res, 409, { error: err.message })
              return
            }
            sendJSON(res, 400, { error: err.message })
            return
          }
        }
        try {
          // WI #386: "clonable into a workspace" — a library-repo-sourced sourceId's only home is
          // lib/libraryCache.js's mirror, never `targetDefinitionsDir` itself, so `cloneDefinition`
          // (which only ever reads and writes within one `definitionsDir`) can't source it; every
          // other source (library, server workspace) is unchanged.
          const result = sourceId
            ? isLibraryRepoSourcedId(sourceId, { definitionsDir, instancesDir })
              ? cloneFromLibraryRepoMirror(sourceId, newId, targetDefinitionsDir, { instancesDir })
              : cloneDefinition(sourceId, newId, { definitionsDir: targetDefinitionsDir })
            : createBlankDefinition(newId, { definitionsDir: targetDefinitionsDir, title: body?.title })
          sendJSON(res, 201, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // WI #386 (Feature #380 phase 6, ADR-0036): Global Settings' library repos — lists configured
      // repos (each with its cache status: `definitionCount`/`fetchedAt` when it has one, `null` when
      // it's never been successfully read yet) and the current id-clash `problems`
      // (`lib/definitionHome.js`'s `libraryRepoProblems`) the Definitions page's problems banner reads.
      if (url.pathname === '/api/library-repos' && req.method === 'GET') {
        const repos = listLibraryRepos({ instancesDir }).map((repo) => {
          const meta = readLibraryRepoCacheMeta(repo.id, { instancesDir })
          return {
            ...repo,
            definitionCount: meta?.ids.length ?? null,
            fetchedAt: meta?.fetchedAt ?? null,
          }
        })
        sendJSON(res, 200, { repos, problems: libraryRepoProblems({ definitionsDir, instancesDir }) })
        return
      }

      // Registers a new library repo and immediately attempts to read it (ADR-0036: "re-read ... when
      // a repo is added") — best-effort: the repo is registered regardless of whether that first read
      // succeeds, since a currently-unreachable repo is still worth having configured for the next
      // Refresh. Uses the server's own PAT (`libraryPats`, resolved once at server startup — never a
      // per-request one, see this function's own doc comment above), not the caller's.
      //
      // #19 (ADR-0037): a body naming `provider` registers a nested-location repo (`{ provider,
      // location: {...}, codeOwner? }`) — GitHub's `{ owner, repository, baseUrl? }` or Azure DevOps's
      // own nested shape. A body with no `provider` is the pre-#19 flat wire shape (`{ organization,
      // project, repository, baseUrl?, codeOwner? }`), always meaning `provider: 'azure-devops'` —
      // unchanged for every existing caller. `lib/librarySettings.js` itself only speaks the nested
      // shape (ticket #6), so this flat wire body is nested right here rather than in that module.
      if (url.pathname === '/api/library-repos' && req.method === 'POST') {
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const repoInput = body?.provider
          ? { provider: body.provider, location: body.location, codeOwner: body.codeOwner }
          : {
              provider: 'azure-devops',
              location: { organization: body?.organization, project: body?.project, repository: body?.repository, baseUrl: body?.baseUrl },
              codeOwner: body?.codeOwner,
            }
        let repo
        try {
          repo = addLibraryRepo(repoInput, { instancesDir })
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
          return
        }
        const [refreshResult] = await refreshAllLibraryRepos([repo], { instancesDir, pats: libraryPats })
        sendJSON(res, 201, { repo, refresh: refreshResult })
        return
      }

      // WI #387 (Feature #380 phase 7, ADR-0036's Promote section): edits a configured library
      // repo's `codeOwner` — the identity Promote attaches as a required reviewer on every Pull
      // Request it opens against this repo. The only field editable after a repo is added (see
      // `lib/librarySettings.js`'s `updateLibraryRepoCodeOwner` doc comment on why
      // organization/project/repository/baseUrl aren't).
      const libraryRepoMatch = url.pathname.match(/^\/api\/library-repos\/([^/]+)$/)
      if (libraryRepoMatch && req.method === 'PUT') {
        const repoId = decodeURIComponent(libraryRepoMatch[1])
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        try {
          const repo = updateLibraryRepoCodeOwner(repoId, body?.codeOwner ?? '', { instancesDir })
          sendJSON(res, 200, { repo })
        } catch (err) {
          sendJSON(res, 404, { error: err.message })
        }
        return
      }

      // The Definitions page's explicit Refresh button (ADR-0036: "cached ... with an explicit Refresh
      // action, not re-fetched on every read") — re-reads every configured library repo now.
      if (url.pathname === '/api/library-repos/refresh' && req.method === 'POST') {
        const results = await refreshAllLibraryRepos(listLibraryRepos({ instancesDir }), { instancesDir, pats: libraryPats })
        sendJSON(res, 200, { results, problems: libraryRepoProblems({ definitionsDir, instancesDir }) })
        return
      }

      // New draft version: POST /api/definitions/:id/versions
      const newDraftMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions$/)
      if (newDraftMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(newDraftMatch[1])
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
        const newDraftDefinitionsDir = resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir)
        if (isDefinitionArchived(rawId, { definitionsDir: newDraftDefinitionsDir })) {
          sendJSON(res, 400, { error: `Definition "${rawId}" is archived` })
          return
        }
        try {
          const result = createDraftVersion(rawId, { definitionsDir: newDraftDefinitionsDir })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 404, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
        try {
          const result = archiveDefinition(rawId, { definitionsDir: resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) })
          sendJSON(res, 200, result)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }
      const restoreMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/restore$/)
      if (restoreMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(restoreMatch[1])
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 404, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
        try {
          const result = restoreDefinition(rawId, { definitionsDir: resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
        const vNum = Number(rawVersion)
        try {
          const result = publishDefinitionVersion(rawId, vNum, { definitionsDir: resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
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
        const templateDefinitionsDir = resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir)
        if (req.method === 'GET') {
          try {
            const source = readDefinitionTemplate(rawId, vNum, rawName, { definitionsDir: templateDefinitionsDir })
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
          if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
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
            const existing = loadDefinition(rawId, { version: vNum, definitionsDir: templateDefinitionsDir })
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
            const result = writeDefinitionTemplate(rawId, vNum, rawName, body.source, { definitionsDir: templateDefinitionsDir })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeArchived: true, includeWorkspaces: true }).map((d) => d.id))
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
        const referenceDocxDefinitionsDir = resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir)
        if (req.method === 'GET') {
          try {
            const bytes = readDefinitionReferenceDocx(rawId, vNum, artefactId, { definitionsDir: referenceDocxDefinitionsDir })
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
          if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
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
            const result = writeDefinitionReferenceDocx(rawId, vNum, artefactId, buffer, { definitionsDir: referenceDocxDefinitionsDir })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true }).map((d) => d.id))
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
          const changelog = loadDefinitionChangelog(rawId, vNum, { definitionsDir: resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) })
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
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        // WI #386: a library-repo-sourced id resolves here exactly like any other — to
        // lib/libraryCache.js's mirrored `definitions/` directory, via `resolveDefinitionsDirForId` /
        // `findDefinitionHomeDefinitionsDir` — no special-casing needed on this read path at all;
        // that's the whole point of mirroring the cache as a real definitionsDir.
        try {
          const def = loadDefinition(rawId, { version: vNum, definitionsDir: resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir) })
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

      // WI #387 (Feature #380 phase 7, ADR-0036's Promote section): the persisted PR link/status
      // per library repo for a definition version — read straight off `.promotions/<n>.json`
      // (`lib/definitionPromote.js`), never a live Azure DevOps call. `[]` for a version nobody has
      // ever promoted, and for any home that isn't a server workspace (library/library-repo rows
      // simply have nothing here) — this route never 404s on a *known* id/version, only on an
      // unknown one, so the Definitions page can always ask it unconditionally.
      const promotionsMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/promotions$/)
      if (promotionsMatch && req.method === 'GET') {
        const rawId = decodeURIComponent(promotionsMatch[1])
        const rawVersion = decodeURIComponent(promotionsMatch[2])
        const rows = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true })
        const row = rows.find((r) => r.id === rawId)
        if (!row) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const promotions = row.home?.kind === 'server-workspace'
          ? readPromotions(serverWorkspaceDefinitionsDir(instancesDir, row.home.id), rawId, Number(rawVersion))
          : []
        sendJSON(res, 200, { promotions })
        return
      }

      // Promotes a published workspace definition version to one or more configured library repos
      // (WI #387): `{ repoIds: [...] }`. Available on a **server-workspace** definition only — a
      // library/library-repo row has no "workspace" to promote *from* (ADR-0036), and an Azure
      // DevOps or local workspace definition isn't reachable through this id/version-keyed route at
      // all (`lib/definitionHome.js` never lists either here — an Azure DevOps workspace definition
      // has no UI surface yet at all, and a local workspace one ships its own files straight to
      // `POST /api/local/definitions/promote` below instead, since this server has no folder of its
      // own to read for it). One commit per selected repo, on a fresh `definition/<id>-v<n>`
      // branch, opening a Pull Request into that repo's `main` — never a direct write, per
      // ADR-0036. One repo's failure never stops another's (the fan-out WI #387 calls for); the
      // response reports every repo's own outcome, and every successful one is persisted
      // immediately so it survives a page reload without needing an extra "Check" click first.
      const promoteMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/promote$/)
      if (promoteMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(promoteMatch[1])
        const rawVersion = decodeURIComponent(promoteMatch[2])
        const rows = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true })
        const row = rows.find((r) => r.id === rawId)
        if (!row) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        if (row.home?.kind !== 'server-workspace') {
          sendJSON(res, 400, { error: 'Promote is only available for a published workspace definition version.' })
          return
        }
        const vNum = Number(rawVersion)
        const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, row.home.id)
        let def
        try {
          def = loadDefinition(rawId, { version: vNum, definitionsDir: workspaceDefinitionsDir })
        } catch (err) {
          sendJSON(res, 404, { error: err.message })
          return
        }
        if (def.status !== 'published') {
          sendJSON(res, 400, { error: 'Promote is only available for a published version.' })
          return
        }
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const repoIds = Array.isArray(body?.repoIds) ? body.repoIds : []
        if (repoIds.length === 0) {
          sendJSON(res, 400, { error: 'repoIds must be a non-empty array' })
          return
        }
        const repos = []
        for (const repoId of repoIds) {
          const repo = resolveLibraryRepo(repoId, { instancesDir })
          if (!repo) {
            sendJSON(res, 400, { error: `Unknown library repo "${repoId}"` })
            return
          }
          repos.push(repo)
        }
        // #20: no single blanket "no server PAT configured" guard here any more — `repos` may span
        // providers, and a request naming only GitHub repos must not be refused for the Azure DevOps
        // PAT being unset. `fanOutPromoteDefinitionVersion` resolves each repo's own credential from
        // `libraryPats` and reports a missing one as that repo's own per-repo failure instead.
        const files = readWorkspaceVersionFolderFiles(workspaceDefinitionsDir, rawId, vNum)
        const results = await fanOutPromoteDefinitionVersion({ definitionId: rawId, version: vNum, files, repos, pats: libraryPats })
        for (const result of results) {
          if (result.ok) upsertPromotion(workspaceDefinitionsDir, rawId, vNum, result)
        }
        sendJSON(res, 200, { promotions: readPromotions(workspaceDefinitionsDir, rawId, vNum), results })
        return
      }

      // The explicit "Check" action (WI #387: "status is read on an explicit Check, not polled —
      // same posture as sign-off"): re-reads every persisted promotion's Pull Request status/review
      // straight from Azure DevOps and updates the persisted record — never invoked on a timer, only
      // this one caller-triggered click.
      const promotionsCheckMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/versions\/([^/]+)\/promotions\/check$/)
      if (promotionsCheckMatch && req.method === 'POST') {
        const rawId = decodeURIComponent(promotionsCheckMatch[1])
        const rawVersion = decodeURIComponent(promotionsCheckMatch[2])
        const rows = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true })
        const row = rows.find((r) => r.id === rawId)
        if (!row || row.home?.kind !== 'server-workspace') {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, row.home.id)
        const existing = readPromotions(workspaceDefinitionsDir, rawId, vNum)
        let latest = existing
        for (const promotion of existing) {
          const repo = resolveLibraryRepo(promotion.repoId, { instancesDir })
          // The repo was removed from Settings since this was promoted — nothing to re-check
          // against; the persisted record is left exactly as it was rather than guessed at.
          if (!repo) continue
          // #20: resolved per-promotion from that repo's own provider — a mixed-provider set of
          // promotions checks each against its own credential, not one shared PAT.
          const pat = libraryPats[repo.provider]
          if (!pat) {
            latest = upsertPromotion(workspaceDefinitionsDir, rawId, vNum, { ...promotion, checkError: missingLibraryPatMessage(repo.provider), lastCheckedAt: new Date().toISOString() })
            continue
          }
          try {
            const updated = await checkPromotionStatus({ promotion, repo, pat })
            latest = upsertPromotion(workspaceDefinitionsDir, rawId, vNum, updated)
          } catch (err) {
            latest = upsertPromotion(workspaceDefinitionsDir, rawId, vNum, { ...promotion, checkError: err.message, lastCheckedAt: new Date().toISOString() })
          }
        }
        sendJSON(res, 200, { promotions: latest })
        return
      }

      if (definitionVersionMatch && req.method === 'PUT') {
        const rawId = decodeURIComponent(definitionVersionMatch[1])
        const rawVersion = decodeURIComponent(definitionVersionMatch[2])
        const knownIds = new Set(listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true }).map((d) => d.id))
        if (!knownIds.has(rawId)) {
          sendJSON(res, 400, { error: `Unknown definition "${rawId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        if (rejectIfLibraryRepoSourced(res, rawId, definitionsDir, instancesDir)) return
        const vNum = Number(rawVersion)
        const versionDefinitionsDir = resolveDefinitionsDirForId(rawId, definitionsDir, instancesDir)
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
          const existing = loadDefinition(rawId, { version: vNum, definitionsDir: versionDefinitionsDir })
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
          const result = writeDefinitionVersion(rawId, vNum, body, { definitionsDir: versionDefinitionsDir })
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

      // WI #383/#17/#32 (ADR-0036, ADR-0037, ADR-0041) — a remote workspace's own `definitions/`
      // folder, committed straight to that workspace repo's `main` (single commits, not stage
      // branches or PRs — `lib/definitionAzureDevOps.js`'s own doc comment has the full reasoning,
      // identical for GitHub and GitLab). A deliberately smaller surface than the library/server-
      // workspace routes above: list, create-blank, new-draft-version, load, save and publish, gated
      // behind the caller's own PAT exactly like every other provider-backed route in this file
      // (`withAzureDevOpsCredential`/`withGitHubCredential`/`withGitLabCredential`) — no
      // templates/reference-docx/clone yet, matching the other two providers' own definitions-home
      // scope. `:workspaceId` is the workspace's own registry id (`lib/workspaceRegistry.js`), not a
      // server workspace folder name — dispatched on `workspace.provider` (#17/#32: Azure DevOps,
      // GitHub and GitLab share this one route surface).
      const workspaceDefinitionsListMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions$/)
      if (workspaceDefinitionsListMatch && req.method === 'GET') {
        const workspaceId = decodeURIComponent(workspaceDefinitionsListMatch[1])
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        const includeArchived = url.searchParams.get('archived') === '1'
        if (workspace.provider === 'github') {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            const rows = await listGitHubDefinitions({ github }, { includeArchived })
            sendJSON(res, 200, rows.map((row) => ({ ...row, home: { kind: 'github-workspace', id: workspaceId, name: workspace.location.repository } })))
          })
          return
        }
        if (workspace.provider === 'gitlab') {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            const rows = await listGitLabDefinitions({ gitlab }, { includeArchived })
            sendJSON(res, 200, rows.map((row) => ({ ...row, home: { kind: 'gitlab-workspace', id: workspaceId, name: workspace.location.repository } })))
          })
          return
        }
        if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          const rows = await listAzureDevOpsDefinitions({ azureDevOps }, { includeArchived })
          sendJSON(res, 200, rows.map((row) => ({ ...row, home: { kind: 'azure-devops-workspace', id: workspaceId, name: workspace.location.repository } })))
        })
        return
      }

      // Create: POST /api/workspaces/:workspaceId/definitions { newId, title } — blank only (clone
      // into a remote workspace isn't implemented yet; bring content in via WI #382's copy flow once
      // the definition exists). Same "unique across the library and every workspace" 409 guard as the
      // library/server-workspace create route, extended with this workspace's own already-known ids
      // plus every *other* Azure DevOps, GitHub and GitLab workspace's (fetched with the caller's own
      // PAT, since this module can't scan a remote workspace without one — see
      // lib/definitionHome.js's own doc comment on why) — a duplicate id is refused regardless of
      // which two homes it collides across (ADR-0036/#17/#32's own "no shadowing" acceptance
      // criterion).
      if (workspaceDefinitionsListMatch && req.method === 'POST') {
        const workspaceId = decodeURIComponent(workspaceDefinitionsListMatch[1])
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        const body = JSON.parse((await readBody(req)) || '{}')
        const newId = body?.newId
        if (!newId || typeof newId !== 'string') {
          sendJSON(res, 400, { error: 'newId is required' })
          return
        }
        if (body?.sourceId) {
          sendJSON(res, 400, { error: 'Cloning into a remote workspace is not supported yet — create blank, then copy elements in.' })
          return
        }
        if (workspace.provider === 'github') {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            const existingIds = await listGitHubDefinitionIds({ github })
            const otherGitHubIds = await collectOtherGitHubDefinitionIds({ instancesDir, pat: github.pat, excludeWorkspaceId: workspaceId })
            const azureDevOpsIds = await collectOtherAzureDevOpsDefinitionIds({ instancesDir, pat: github.pat })
            const gitlabIds = await collectOtherGitLabDefinitionIds({ instancesDir, pat: github.pat })
            try {
              assertDefinitionIdAvailable(newId, {
                definitionsDir,
                instancesDir,
                extraKnownIds: [...existingIds, ...otherGitHubIds, ...azureDevOpsIds, ...gitlabIds],
              })
            } catch (err) {
              sendJSON(res, err instanceof DefinitionIdConflictError ? 409 : 400, { error: err.message })
              return
            }
            const result = await createBlankGitHubDefinition(newId, { github }, { title: body?.title })
            sendJSON(res, 201, result)
          })
          return
        }
        if (workspace.provider === 'gitlab') {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            const existingIds = await listGitLabDefinitionIds({ gitlab })
            const otherGitLabIds = await collectOtherGitLabDefinitionIds({ instancesDir, pat: gitlab.pat, excludeWorkspaceId: workspaceId })
            const azureDevOpsIds = await collectOtherAzureDevOpsDefinitionIds({ instancesDir, pat: gitlab.pat })
            const githubIds = await collectOtherGitHubDefinitionIds({ instancesDir, pat: gitlab.pat })
            try {
              assertDefinitionIdAvailable(newId, {
                definitionsDir,
                instancesDir,
                extraKnownIds: [...existingIds, ...otherGitLabIds, ...azureDevOpsIds, ...githubIds],
              })
            } catch (err) {
              sendJSON(res, err instanceof DefinitionIdConflictError ? 409 : 400, { error: err.message })
              return
            }
            const result = await createBlankGitLabDefinition(newId, { gitlab }, { title: body?.title })
            sendJSON(res, 201, result)
          })
          return
        }
        if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          const existingIds = await listAzureDevOpsDefinitionIds({ azureDevOps })
          // No-shadowing (ADR-0036) also covers every *other* registered Azure DevOps, GitHub or
          // GitLab workspace, not just this one — see `collectOtherAzureDevOpsDefinitionIds`/
          // `collectOtherGitHubDefinitionIds`/`collectOtherGitLabDefinitionIds`'s own doc comments
          // above.
          const otherAzureDevOpsIds = await collectOtherAzureDevOpsDefinitionIds({
            instancesDir,
            pat: azureDevOps.pat,
            excludeWorkspaceId: workspaceId,
          })
          const githubIds = await collectOtherGitHubDefinitionIds({ instancesDir, pat: azureDevOps.pat })
          const gitlabIds = await collectOtherGitLabDefinitionIds({ instancesDir, pat: azureDevOps.pat })
          try {
            assertDefinitionIdAvailable(newId, {
              definitionsDir,
              instancesDir,
              extraKnownIds: [...existingIds, ...otherAzureDevOpsIds, ...githubIds, ...gitlabIds],
            })
          } catch (err) {
            sendJSON(res, err instanceof DefinitionIdConflictError ? 409 : 400, { error: err.message })
            return
          }
          const result = await createBlankAzureDevOpsDefinition(newId, { azureDevOps }, { title: body?.title })
          sendJSON(res, 201, result)
        })
        return
      }

      const workspaceNewDraftMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions\/([^/]+)\/versions$/)
      if (workspaceNewDraftMatch && req.method === 'POST') {
        const workspaceId = decodeURIComponent(workspaceNewDraftMatch[1])
        const rawId = decodeURIComponent(workspaceNewDraftMatch[2])
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        if (workspace.provider === 'github') {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            try {
              const result = await createGitHubDraftVersion(rawId, { github })
              sendJSON(res, 200, result)
            } catch (err) {
              sendJSON(res, 400, { error: err.message })
            }
          })
          return
        }
        if (workspace.provider === 'gitlab') {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            try {
              const result = await createGitLabDraftVersion(rawId, { gitlab })
              sendJSON(res, 200, result)
            } catch (err) {
              sendJSON(res, 400, { error: err.message })
            }
          })
          return
        }
        if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          try {
            const result = await createAzureDevOpsDraftVersion(rawId, { azureDevOps })
            sendJSON(res, 200, result)
          } catch (err) {
            sendJSON(res, /has no versions|is archived/.test(err.message) ? 400 : 400, { error: err.message })
          }
        })
        return
      }

      const workspaceVersionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions\/([^/]+)\/versions\/([^/]+)$/)
      if (workspaceVersionMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const workspaceId = decodeURIComponent(workspaceVersionMatch[1])
        const rawId = decodeURIComponent(workspaceVersionMatch[2])
        const rawVersion = decodeURIComponent(workspaceVersionMatch[3])
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        const isGitHub = workspace.provider === 'github'
        const isGitLab = workspace.provider === 'gitlab'
        if (!isGitHub && !isGitLab && rejectUnlessAzureDevOpsWorkspace(res, workspace)) return

        if (req.method === 'GET') {
          const loadFn = isGitHub ? loadGitHubDefinition : isGitLab ? loadGitLabDefinition : loadAzureDevOpsDefinition
          const withCredential = isGitHub ? withGitHubCredential : isGitLab ? withGitLabCredential : withAzureDevOpsCredential
          const optionsFor = (providerConfig) => (isGitHub ? { github: providerConfig } : isGitLab ? { gitlab: providerConfig } : { azureDevOps: providerConfig })
          await withCredential(req, res, workspace.location, async (providerConfig) => {
            try {
              const def = await loadFn(rawId, vNum, optionsFor(providerConfig))
              sendJSON(res, 200, definitionVersionProjection(def))
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
                return
              }
              sendJSON(res, 400, { error: err.message })
            }
          })
          return
        }

        // PUT — save a draft version's structure, one commit straight to `main` (WI #383's own "Done
        // when" bar: this is the path exercised against the fake Azure DevOps/GitHub/GitLab servers).
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
        if (isGitHub) {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            try {
              const result = await writeGitHubDefinitionVersion(rawId, vNum, body, { github })
              if (result && result.problems) {
                sendJSON(res, 422, { problems: result.problems })
                return
              }
              sendJSON(res, 200, { ok: true, ...result })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
                return
              }
              const msg = err.message ?? ''
              if (/not a draft/i.test(msg)) {
                sendJSON(res, 409, { error: msg })
                return
              }
              sendJSON(res, 400, { error: msg })
            }
          })
          return
        }
        if (isGitLab) {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            try {
              const result = await writeGitLabDefinitionVersion(rawId, vNum, body, { gitlab })
              if (result && result.problems) {
                sendJSON(res, 422, { problems: result.problems })
                return
              }
              sendJSON(res, 200, { ok: true, ...result })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
                return
              }
              const msg = err.message ?? ''
              if (/not a draft/i.test(msg)) {
                sendJSON(res, 409, { error: msg })
                return
              }
              sendJSON(res, 400, { error: msg })
            }
          })
          return
        }
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          try {
            const result = await writeAzureDevOpsDefinitionVersion(rawId, vNum, body, { azureDevOps })
            if (result && result.problems) {
              sendJSON(res, 422, { problems: result.problems })
              return
            }
            sendJSON(res, 200, { ok: true, ...result })
          } catch (err) {
            if (err instanceof NotFoundError) {
              sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
              return
            }
            const msg = err.message ?? ''
            if (/not a draft/i.test(msg)) {
              sendJSON(res, 409, { error: msg })
              return
            }
            sendJSON(res, 400, { error: msg })
          }
        })
        return
      }

      const workspacePublishMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions\/([^/]+)\/versions\/([^/]+)\/publish$/)
      if (workspacePublishMatch && req.method === 'POST') {
        const workspaceId = decodeURIComponent(workspacePublishMatch[1])
        const rawId = decodeURIComponent(workspacePublishMatch[2])
        const rawVersion = decodeURIComponent(workspacePublishMatch[3])
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
          sendJSON(res, 400, { error: `Invalid version "${rawVersion}"` })
          return
        }
        const vNum = Number(rawVersion)
        if (workspace.provider === 'github') {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            try {
              const result = await publishGitHubDefinitionVersion(rawId, vNum, { github })
              if (result && result.problems) {
                sendJSON(res, 422, { problems: result.problems })
                return
              }
              sendJSON(res, 200, { ok: true, ...result })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
                return
              }
              const msg = err.message ?? ''
              if (/not a draft/i.test(msg)) {
                sendJSON(res, 409, { error: msg })
                return
              }
              sendJSON(res, 400, { error: msg })
            }
          })
          return
        }
        if (workspace.provider === 'gitlab') {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            try {
              const result = await publishGitLabDefinitionVersion(rawId, vNum, { gitlab })
              if (result && result.problems) {
                sendJSON(res, 422, { problems: result.problems })
                return
              }
              sendJSON(res, 200, { ok: true, ...result })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
                return
              }
              const msg = err.message ?? ''
              if (/not a draft/i.test(msg)) {
                sendJSON(res, 409, { error: msg })
                return
              }
              sendJSON(res, 400, { error: msg })
            }
          })
          return
        }
        if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          try {
            const result = await publishAzureDevOpsDefinitionVersion(rawId, vNum, { azureDevOps })
            if (result && result.problems) {
              sendJSON(res, 422, { problems: result.problems })
              return
            }
            sendJSON(res, 200, { ok: true, ...result })
          } catch (err) {
            if (err instanceof NotFoundError) {
              sendJSON(res, 404, { error: `Definition "${rawId}" has no version ${vNum}` })
              return
            }
            const msg = err.message ?? ''
            if (/not a draft/i.test(msg)) {
              sendJSON(res, 409, { error: msg })
              return
            }
            sendJSON(res, 400, { error: msg })
          }
        })
        return
      }

      const workspaceArchiveMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions\/([^/]+)\/(archive|restore)$/)
      if (workspaceArchiveMatch && req.method === 'POST') {
        const workspaceId = decodeURIComponent(workspaceArchiveMatch[1])
        const rawId = decodeURIComponent(workspaceArchiveMatch[2])
        const action = workspaceArchiveMatch[3]
        const workspace = resolveWorkspace(workspaceId, { instancesDir })
        if (!workspace) {
          sendJSON(res, 404, { error: `Unknown workspace "${workspaceId}"` })
          return
        }
        if (workspace.provider === 'github') {
          await withGitHubCredential(req, res, workspace.location, async (github) => {
            const result = action === 'archive' ? await archiveGitHubDefinition(rawId, { github }) : await restoreGitHubDefinition(rawId, { github })
            sendJSON(res, 200, result)
          })
          return
        }
        if (workspace.provider === 'gitlab') {
          await withGitLabCredential(req, res, workspace.location, async (gitlab) => {
            const result = action === 'archive' ? await archiveGitLabDefinition(rawId, { gitlab }) : await restoreGitLabDefinition(rawId, { gitlab })
            sendJSON(res, 200, result)
          })
          return
        }
        if (rejectUnlessAzureDevOpsWorkspace(res, workspace)) return
        await withAzureDevOpsCredential(req, res, workspace.location, async (azureDevOps) => {
          const result =
            action === 'archive'
              ? await archiveAzureDevOpsDefinition(rawId, { azureDevOps })
              : await restoreAzureDevOpsDefinition(rawId, { azureDevOps })
          sendJSON(res, 200, result)
        })
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
      // WI #383: every server workspace (a `workspace.json`-marked folder under `instancesDir`) — no
      // credentials needed, unlike `/api/workspaces` above (Azure DevOps workspaces). The Definitions
      // page's "+ New definition" home picker uses this to offer every workspace as a target even one
      // with no definitions of its own yet, which the `home`-tagged rows from `GET /api/definitions`
      // alone can't (a workspace with zero definitions never appears there).
      if (url.pathname === '/api/server-workspaces' && req.method === 'GET') {
        sendJSON(res, 200, listServerWorkspaceHomes(instancesDir))
        return
      }

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

      // Registers a new workspace directly — the primitive the future Settings screen (#101/#104) will build on. Structural validation errors (missing location fields, an unavailable `provider`) are checked first and reported as 400 with no network cost, exactly like every other validating route in this file. Unlike a plain metadata store, though, this route *establishes* a remote location the same way `POST /api/instances`/`POST /api/instances/adopt` already do — so it requires the caller's own PAT (the same credential-provider seam, #86) and actually proves that PAT against this exact location via `checkAzureDevOpsRepo`/`checkGitHubRepo` (#8, docs/adr/0037/0039 — the same check `/api/instances/adopt` already performs for Azure DevOps) before persisting anything. Without this, any caller with mere network access to this server — no credential needed at all — could register a workspace (or, since a location isn't unique here, have it silently reused by a later legitimate registration for the exact same repo via `getOrCreateWorkspace`'s tuple matching) carrying a spoofed `owner`/`baseUrl` for a repo it has no real access to. `baseUrl` is gated behind the same per-provider allow flag (`allowAzureDevOpsBaseUrlOverride` / `allowGitHubBaseUrlOverride`) every other caller-supplied `baseUrl` in this file already requires, for the same SSRF-prevention reason documented on those options above.
      //
      // Accepts either wire shape (ticket #5, ADR-0037): the #3 nested `{ provider, location: {...}, owner? }` the "+ New Workspace" wizard now sends, or the pre-#3 flat `{ organization, project, repository, baseUrl?, owner? }` still exercised by this suite's own back-compat coverage — detected on the presence of a `location` key. The flat shape always means `provider: 'azure-devops'` (it has no GitHub-shaped fields of its own); a GitHub workspace (#8) is only reachable via the nested shape, with `location: { owner, repository, baseUrl? }` — `provider.js`'s own per-provider location schema, so it never collides on the wire with this same body's *workspace* `owner` (the Owner *person* every provider's workspace carries, unrelated to a GitHub repo's own owner/org, which lives nested under `location.owner` instead). `lib/workspaceRegistry.js` itself only speaks the nested shape (ticket #6) — this route already normalizes to `{ provider, location }` below before ever calling it, so removing that module's own flat detection doesn't touch this route.
      if (url.pathname === '/api/workspaces' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const isNested = Boolean(body) && typeof body === 'object' && body.location !== undefined && body.location !== null
        const provider = isNested ? (body.provider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER
        const rawLocation = isNested
          ? body.location
          : { organization: body?.organization, project: body?.project, repository: body?.repository, baseUrl: body?.baseUrl }
        const owner = body?.owner

        try {
          assertValidProvider(provider)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
          return
        }

        let location
        try {
          location = normalizeProviderLocation(provider, rawLocation, { entityLabel: 'A workspace' })
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
          return
        }

        // #24: keyed by provider rather than `provider === 'github' ? ... : <assume azure-devops>` —
        // that ternary would have silently reused Azure DevOps's own baseUrl-override flag (and
        // `checkAzureDevOpsRepo` below) for any third *declared* provider. #25 adds `gitlab` to both
        // tables, using the same `checkGitLabRepo`/`allowGitLabBaseUrlOverride` seam #35's adopt path
        // (`POST /api/instances/adopt`/`GET /api/gitlab/repo-check`) already exercises for a location
        // the caller already knows holds data — this is that same proof, run once up front instead,
        // before a *new* GitLab workspace is first registered.
        // Provider not in either table below → base URL overrides default to disallowed (fails safe)
        // and the repo check is reported as unsupported rather than run against the wrong provider's client.
        const BASE_URL_OVERRIDE_ALLOWED = {
          github: allowGitHubBaseUrlOverride,
          'azure-devops': allowAzureDevOpsBaseUrlOverride,
          gitlab: allowGitLabBaseUrlOverride,
          // atlassian deliberately absent — no `baseUrl` field exists in its stored location at all
          // (ADR-0042: Cloud-only), so it falls through to this table's own `?? false` default and any
          // caller-supplied `location.baseUrl` for it is rejected below exactly like an unrecognized
          // provider's would be.
        }
        const REPO_CHECKERS = { github: checkGitHubRepo, 'azure-devops': checkAzureDevOpsRepo, gitlab: checkGitLabRepo, atlassian: checkAtlassianRepo }

        const baseUrlAllowed = BASE_URL_OVERRIDE_ALLOWED[provider] ?? false
        if (rawLocation?.baseUrl !== undefined && !baseUrlAllowed) {
          sendJSON(res, 400, { error: `${PROVIDER_OPTION_KEY[provider] ?? provider}.baseUrl overrides are not permitted on this server` })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          // #9 (ADR-0038): `provider` is already known at this point (from the request body, before
          // any workspace exists to resolve it from) — named here rather than falling through to
          // `sendAuthenticationRequired`'s own azure-devops-only default, so a GitHub registration
          // with no PAT at all still gets a GitHub-named prompt, not a misleading Azure DevOps one.
          sendAuthenticationRequired(res, { provider })
          return
        }

        // #48 (ADR-0042): an Atlassian registration has to prove *two* tokens — Bitbucket's (`pat`,
        // the primary `Authorization` header, same as every other provider) and Jira's (a second,
        // equally Basic-encoded header — see lib/credential.js's own `getSecondaryCredential` doc
        // comment). Missing either is reported the same "authentication required" way as a missing
        // Bitbucket token, since neither half alone proves this workspace is real.
        let jiraPat
        if (provider === 'atlassian') {
          jiraPat = getSecondaryCredential(req)
          if (!jiraPat) {
            sendAuthenticationRequired(res, { provider })
            return
          }
        }

        const checkRepo = REPO_CHECKERS[provider]
        if (!checkRepo) {
          sendJSON(res, 400, { error: `Registering a "${provider}" workspace is not supported yet.` })
          return
        }

        // Extra args only `checkAtlassianRepo` reads (its own two-token, test-only-baseUrl shape,
        // lib/repoCheck.js's own doc comment) — kept out of the spread below for every other provider
        // so an always-`undefined` `baseUrl`/`jiraBaseUrl` here can never clobber a caller-supplied
        // `location.baseUrl` those providers' own checkers do read off `...location`.
        const atlassianCheckArgs = provider === 'atlassian' ? { jiraPat, baseUrl: atlassianBitbucketBaseUrl, jiraBaseUrl: atlassianJiraBaseUrl } : {}

        try {
          // A location check, not an instance check — whether this repo already holds instance data ('found') or not ('empty') is irrelevant here; only a rejected PAT changes this route's response.
          await checkRepo({ ...location, pat, ...atlassianCheckArgs, definitionsDir })
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
            return
          }
          if (err instanceof RepoNotFoundError) {
            sendJSON(res, 400, { error: err.message })
            return
          }
          throw err
        }

        try {
          const existing = findWorkspaceByLocation({ provider, location }, { instancesDir })
          const workspace = getOrCreateWorkspace({ provider, location, owner }, { instancesDir })
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

      // Updates a workspace's `owner` — the Settings screen's Workspace tab (#104). Deliberately narrower than `registerWorkspace`'s own field set — `organization`/`project`/`repository`/`baseUrl` are not accepted here, since changing *those* would re-point an already-established workspace at a different remote location, which (unlike a plain metadata edit) would need the same real-access proof `POST /api/workspaces` requires; that's out of this ticket's scope, so it's simply not an accepted field on this route rather than a security hole. No PAT is required or consulted, for the same reason `GET /api/workspaces` doesn't: `owner` isn't used to establish or prove Provider access, only to record metadata this server already trusts itself to serve.
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
        // A PAT is optional here, not required: this route has never gated on a credential the way the single-instance routes do (#86), so a request with none simply sees every local instance plus any Provider-backed one it happens to already be able to authenticate to — see lib/registry.js's buildAzureDevOpsRow/buildGitHubRow/buildGitLabRow for why an entry it can't read is left out rather than failing the whole listing.
        const pat = getCredential(req)
        // `?archived=1` (#223) — the "show archived / restore" view: includes archived instances
        // too, each row then carrying an `archived` boolean. Without it, archived instances are
        // absent and no row has that key, so the default listing is unchanged from before #223.
        const includeArchived = url.searchParams.get('archived') === '1'
        // #121 (parent #109, docs/adr/0047): `sharedWorkspacePats` (parsed once at boot, above) is
        // this route's own read-only fallback — a request with no credential for a *shared* workspace
        // still gets that workspace's rows, resolved per row by lib/registry.js's
        // resolveRowCredential. This is the one and only listRegistry call site in this file that ever
        // sees this map: every other call — the read-back after a POST/PUT/DELETE mutation — passes no
        // `sharedPats` at all, so a shared credential can never be reached from a write path.
        sendJSON(res, 200, await listRegistry({ instancesDir, definitionsDir, pat, includeArchived, sharedPats: sharedWorkspacePats }))
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
        const { definition: definitionId, slug, owner, assignee, azureDevOps, github, definitionVersion: rawDefinitionVersion, version: rawVersion } = body ?? {}
        let requestedVersion = rawDefinitionVersion ?? rawVersion ?? null
        // Accept "latest" string as latest published
        if (requestedVersion === 'latest') requestedVersion = null
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        // WI #383 (ADR-0036): a brand-new local instance always lands in the reserved `default` server
        // workspace (`localInstancesDir`, below) — so besides the library, the only workspace whose own
        // definitions are eligible here is that one. An Azure-DevOps-backed instance (the branch below)
        // still only ever resolves `definitionId` against the library, unchanged: its own workspace's
        // `definitions/` folder is a later phase's work (see this ticket's final report).
        const instanceCreationDefinitionsDir = resolveDefinitionsDirForId(definitionId, definitionsDir, instancesDir)
        if (definitionId && isDefinitionArchived(definitionId, { definitionsDir: instanceCreationDefinitionsDir })) {
          sendJSON(res, 409, { error: `Definition "${definitionId}" is archived` })
          return
        }
        // WI #386: a library-repo-sourced definition is eligible here too, same as a packaged-library
        // one — both are globally-visible read sources (never scoped to one workspace the way a
        // server workspace's own definitions are), and "instances pinned to a library-repo definition
        // keep working from the cache if the repo is unreachable" presupposes an instance can be
        // pinned to one in the first place.
        const defs = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true }).filter(
          (d) => d.home.kind === 'library' || d.home.kind === 'library-repo' || d.home.id === MIGRATED_DEFAULT_WORKSPACE_FOLDER
        )
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
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            if (err instanceof RepoNotFoundError) {
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

        // #11 — the GitHub twin of the azureDevOps branch above: same field/baseUrl validation, same
        // authentication gating, same 400/409 error mapping, registered under `{ kind: 'github' }`
        // instead. Always writes to `main`, same as the azureDevOps branch above — creating the
        // instance skeleton is not itself a stage "Save", so there's no stage branch to target yet
        // (#12's stage-branch lifecycle starts on the first real module write).
        if (github !== undefined) {
          if (typeof github !== 'object' || github === null) {
            sendJSON(res, 400, { error: 'github must be an object with owner and repository' })
            return
          }
          const missingFields = ['owner', 'repository'].filter((key) => !github[key])
          if (missingFields.length) {
            sendJSON(res, 400, { error: `github location is missing: ${missingFields.join(', ')}` })
            return
          }
          if (github.baseUrl !== undefined && !allowGitHubBaseUrlOverride) {
            sendJSON(res, 400, { error: 'github.baseUrl overrides are not permitted on this server' })
            return
          }

          const pat = getCredential(req)
          if (!pat) {
            sendAuthenticationRequired(res, { provider: 'github' })
            return
          }

          const location = {
            owner: github.owner,
            repository: github.repository,
            ...(allowGitHubBaseUrlOverride && github.baseUrl ? { baseUrl: github.baseUrl } : {}),
          }
          try {
            await createInstance(definitionId, slug, { definitionsDir, owner, assignee, definitionVersion: definitionVersionToUse, github: { ...location, pat } })
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            if (err instanceof RepoNotFoundError) {
              sendJSON(res, 400, { error: err.message })
              return
            }
            const status = /already exists/.test(err.message) ? 409 : 400
            sendJSON(res, status, { error: err.message })
            return
          }
          registerInstance(slug, { kind: 'github', ...location }, { instancesDir })
          const created = (await listRegistry({ instancesDir, definitionsDir, pat })).find((i) => i.slug === slug)
          sendJSON(res, 201, created)
          return
        }

        try {
          createInstance(definitionId, slug, { instancesDir: localInstancesDir, definitionsDir: instanceCreationDefinitionsDir, owner, assignee, definitionVersion: definitionVersionToUse })
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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
            return
          }
          if (err instanceof RepoNotFoundError) {
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

      // The GitHub twin of `GET /api/azure-devops/repo-check` above (#18) — same "what's in this
      // specific remote repo, given the caller's own PAT" contract, over `checkGitHubRepo`'s own
      // discovery (extended by this same ticket to report `found`/`multiple`/`empty`). `baseUrl` is
      // gated by the single `allowGitHubBaseUrlOverride` flag every other GitHub query-param route
      // already uses (see e.g. `GET /api/identities`'s own `provider=github` branch), rather than an
      // Azure-DevOps-style allow-list — createServer's own doc comment on that option.
      if (url.pathname === '/api/github/repo-check' && req.method === 'GET') {
        const owner = url.searchParams.get('owner')
        const repository = url.searchParams.get('repository')
        const missing = ['owner', 'repository'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowGitHubBaseUrlOverride) {
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a GitHub Enterprise Server instance.',
          })
          return
        }

        await withGitHubCredential(req, res, { owner, repository, baseUrl: requestedBaseUrl }, async (github) => {
          const result = await checkGitHubRepo({ ...github, definitionsDir })
          sendJSON(res, 200, result)
        })
        return
      }

      // The GitLab twin of `GET /api/github/repo-check` above (#35, ADR-0041) — same "what's in this
      // specific remote location, given the caller's own PAT" contract, over `checkGitLabRepo`'s own
      // discovery. `baseUrl` is gated by the single `allowGitLabBaseUrlOverride` flag every other
      // GitLab query-param route already uses, rather than an Azure-DevOps-style allow-list —
      // createServer's own doc comment on that option.
      if (url.pathname === '/api/gitlab/repo-check' && req.method === 'GET') {
        const namespace = url.searchParams.get('namespace')
        const repository = url.searchParams.get('repository')
        const missing = ['namespace', 'repository'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowGitLabBaseUrlOverride) {
          sendJSON(res, 400, {
            error:
              'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
              'need to check a location on a self-hosted GitLab instance.',
          })
          return
        }

        await withGitLabCredential(req, res, { namespace, repository, baseUrl: requestedBaseUrl }, async (gitlab) => {
          const result = await checkGitLabRepo({ ...gitlab, definitionsDir })
          sendJSON(res, 200, result)
        })
        return
      }

      // Adopts an Azure-DevOps-backed instance the setup wizard's (#78) own repo-check (#90) already found data at — registering that location in the instance registry (#89) so it becomes resolvable the same way a freshly-created one is, without writing anything. A companion to `POST /api/instances`'s create-and-register path (#93), but for the opposite intent: that route's own "instance.yaml already exists at this Azure DevOps location" case is a genuine conflict when the caller asked to *create* a new instance there (#93's locked-in 409 contract — tests/server.test.js) and must stay that way; this route is for a caller who already knows (from its own prior repo-check) that data exists and wants to adopt it, not create anything (#94, under #88's "Open instance ... actually works" acceptance criterion for the wizard's "existing instance found" outcome).
      //
      // Re-runs `checkAzureDevOpsRepo` itself (rather than trusting a slug/definition the caller supplies) so the slug registered is always the real one currently in that repo's instance.yaml, not whatever a possibly-stale client-side check result claims.
      //
      // Idempotent for a slug already registered to this *exact* location (re-opening a previously-adopted instance from the wizard must not fail) — but a 409 conflict, same as POST /api/instances, when the slug is already registered to a *different* location (local or a different Azure DevOps repo), so this can never silently repoint an existing registry entry.
      //
      // #18 — the same route additionally accepts a `github` location instead of `azureDevOps`
      // (never both), handled by its own self-contained branch below before falling through to the
      // Azure DevOps handling unchanged: same "prove access, then re-check what's actually there,
      // then register-or-409" shape, over `checkGitHubRepo`'s own now-discovering result (extended by
      // this same ticket to report `found`/`multiple`/`empty` the way `checkAzureDevOpsRepo` always
      // has) and `registerInstance`'s existing `{ kind: 'github' }` support (#11), which already
      // reuses-or-creates the workspace for this exact owner/repository tuple via
      // `getOrCreateWorkspace` — nothing extra needed here for "adopting an already-registered repo
      // reuses it". #35 (ADR-0041) adds a third, equally self-contained `gitlab` branch, same shape,
      // over `checkGitLabRepo`/`{ kind: 'gitlab' }` and GitLab's own `namespace`/`repository` fields.
      if (url.pathname === '/api/instances/adopt' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const github = body?.github
        if (github !== undefined) {
          if (typeof github !== 'object' || github === null) {
            sendJSON(res, 400, { error: 'github must be an object with owner and repository' })
            return
          }
          const missingGitHubFields = ['owner', 'repository'].filter((key) => !github[key])
          if (missingGitHubFields.length) {
            sendJSON(res, 400, { error: `github location is missing: ${missingGitHubFields.join(', ')}` })
            return
          }
          if (github.baseUrl !== undefined && !allowGitHubBaseUrlOverride) {
            sendJSON(res, 400, { error: 'github.baseUrl overrides are not permitted on this server' })
            return
          }

          const githubPat = getCredential(req)
          if (!githubPat) {
            sendAuthenticationRequired(res, { provider: 'github' })
            return
          }

          const githubLocation = {
            owner: github.owner,
            repository: github.repository,
            ...(allowGitHubBaseUrlOverride && github.baseUrl ? { baseUrl: github.baseUrl } : {}),
          }

          let githubCheckResult
          try {
            githubCheckResult = await checkGitHubRepo({ ...githubLocation, pat: githubPat, definitionsDir })
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            throw err
          }

          if (githubCheckResult.result === 'multiple') {
            sendJSON(res, 400, {
              error: `This GitHub location already holds more than one instance (${githubCheckResult.slugs.join(', ')}) — adopting a specific one isn't supported yet.`,
            })
            return
          }
          if (githubCheckResult.result !== 'found') {
            sendJSON(res, 400, { error: 'No instance data found at this GitHub location yet — nothing to adopt.' })
            return
          }
          if (!githubCheckResult.slug) {
            sendJSON(res, 400, { error: 'Instance data at this GitHub location has no slug set.' })
            return
          }
          if (!isValidSlug(githubCheckResult.slug)) {
            sendJSON(res, 400, { error: `Instance data at this GitHub location has an invalid slug "${githubCheckResult.slug}".` })
            return
          }

          const githubSlug = githubCheckResult.slug
          const existingGitHubLocation = resolveInstanceLocation(githubSlug, { instancesDir })
          const sameGitHubLocation =
            existingGitHubLocation?.kind === 'github' &&
            existingGitHubLocation.owner === githubLocation.owner &&
            existingGitHubLocation.repository === githubLocation.repository &&
            (existingGitHubLocation.baseUrl ?? undefined) === (githubLocation.baseUrl ?? undefined)

          if (existingGitHubLocation && !sameGitHubLocation) {
            sendJSON(res, 409, { error: `Instance "${githubSlug}" already exists` })
            return
          }
          if (!existingGitHubLocation) {
            registerInstance(githubSlug, { kind: 'github', ...githubLocation }, { instancesDir })
          }

          const githubRow = (await listRegistry({ instancesDir, definitionsDir, pat: githubPat })).find((i) => i.slug === githubSlug)
          sendJSON(res, 200, githubRow)
          return
        }

        // #35 (ADR-0041) — the GitLab twin of the `github` branch above: same "prove access, then
        // re-check what's actually there, then register-or-409" shape, over `checkGitLabRepo`'s own
        // discovery and `registerInstance`'s existing `{ kind: 'gitlab' }` support (already wired by
        // #24's/#26's own dispatch generalization), which already reuses-or-creates the workspace for
        // this exact namespace/repository tuple via `getOrCreateWorkspace` — nothing extra needed here
        // for "adopting an already-registered project reuses it".
        const gitlab = body?.gitlab
        if (gitlab !== undefined) {
          if (typeof gitlab !== 'object' || gitlab === null) {
            sendJSON(res, 400, { error: 'gitlab must be an object with namespace and repository' })
            return
          }
          const missingGitLabFields = ['namespace', 'repository'].filter((key) => !gitlab[key])
          if (missingGitLabFields.length) {
            sendJSON(res, 400, { error: `gitlab location is missing: ${missingGitLabFields.join(', ')}` })
            return
          }
          if (gitlab.baseUrl !== undefined && !allowGitLabBaseUrlOverride) {
            sendJSON(res, 400, { error: 'gitlab.baseUrl overrides are not permitted on this server' })
            return
          }

          const gitlabPat = getCredential(req)
          if (!gitlabPat) {
            sendAuthenticationRequired(res, { provider: 'gitlab' })
            return
          }

          const gitlabLocation = {
            namespace: gitlab.namespace,
            repository: gitlab.repository,
            ...(allowGitLabBaseUrlOverride && gitlab.baseUrl ? { baseUrl: gitlab.baseUrl } : {}),
          }

          let gitlabCheckResult
          try {
            gitlabCheckResult = await checkGitLabRepo({ ...gitlabLocation, pat: gitlabPat, definitionsDir })
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            throw err
          }

          if (gitlabCheckResult.result === 'multiple') {
            sendJSON(res, 400, {
              error: `This GitLab location already holds more than one instance (${gitlabCheckResult.slugs.join(', ')}) — adopting a specific one isn't supported yet.`,
            })
            return
          }
          if (gitlabCheckResult.result !== 'found') {
            sendJSON(res, 400, { error: 'No instance data found at this GitLab location yet — nothing to adopt.' })
            return
          }
          if (!gitlabCheckResult.slug) {
            sendJSON(res, 400, { error: 'Instance data at this GitLab location has no slug set.' })
            return
          }
          if (!isValidSlug(gitlabCheckResult.slug)) {
            sendJSON(res, 400, { error: `Instance data at this GitLab location has an invalid slug "${gitlabCheckResult.slug}".` })
            return
          }

          const gitlabSlug = gitlabCheckResult.slug
          const existingGitLabLocation = resolveInstanceLocation(gitlabSlug, { instancesDir })
          const sameGitLabLocation =
            existingGitLabLocation?.kind === 'gitlab' &&
            existingGitLabLocation.namespace === gitlabLocation.namespace &&
            existingGitLabLocation.repository === gitlabLocation.repository &&
            (existingGitLabLocation.baseUrl ?? undefined) === (gitlabLocation.baseUrl ?? undefined)

          if (existingGitLabLocation && !sameGitLabLocation) {
            sendJSON(res, 409, { error: `Instance "${gitlabSlug}" already exists` })
            return
          }
          if (!existingGitLabLocation) {
            registerInstance(gitlabSlug, { kind: 'gitlab', ...gitlabLocation }, { instancesDir })
          }

          const gitlabRow = (await listRegistry({ instancesDir, definitionsDir, pat: gitlabPat })).find((i) => i.slug === gitlabSlug)
          sendJSON(res, 200, gitlabRow)
          return
        }

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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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
        const stagesId = definitionStagesMatch[1]
        const definition = loadDefinition(stagesId, { definitionsDir: resolveDefinitionsDirForId(stagesId, definitionsDir, instancesDir) })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate })
            const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
            const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
            sendJSON(res, 200, await checkGate(slug, { azureDevOps, definitionsDir, gate }))
          })
          return
        }

        // The GitHub twin of the Azure-DevOps-backed branch above (#14) — there's no per-stage GitHub
        // branch yet (#12 is a later ticket), so this reads straight off `main` rather than resolving
        // one.
        const githubLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubLocation) {
          await withGitHubCredential(req, res, githubLocation, async (githubBase) => {
            sendJSON(res, 200, await checkGate(slug, { github: githubBase, definitionsDir, gate }))
          })
          return
        }

        sendJSON(res, 200, checkGate(slug, { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId), definitionsDir, gate }))
        return
      }

      // Links an instance to an Azure DevOps parent work item, auto-creating one child work item per stage in its definition underneath it (#95/#103). `organization`/`project` name where the *work item* lives — independent of, and not required to match, wherever this instance's own module data is stored (local or a different Azure DevOps repo entirely). `workItemType` is optional, defaulting to `DEFAULT_WORK_ITEM_TYPE` ("Task") — the configurable-with-a-sensible-default acceptance criterion. Requires the caller's own PAT (Work Items scope), via the same credential-provider seam as every other Azure-DevOps-backed route; if this instance's own data also happens to be Azure-DevOps-backed, the same PAT is reused for both calls rather than asking twice.
      //
      // `body.provider` (#14) picks which branch runs — `'github'` links to an existing *issue*
      // (`body.owner`/`body.repository`/`body.parentNumber`, no `workItemType` — docs/adr/0040 drops
      // the concept rather than emulating it); anything else (including the field's absence, for every
      // caller that predates #14) keeps the Azure DevOps behaviour above unchanged.
      if (url.pathname === '/api/instance/work-items/link' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug, instancesDir)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const body = JSON.parse(await readBody(req))

        if (body?.provider === 'github') {
          const { owner, repository, parentNumber } = body
          const missing = ['owner', 'repository', 'parentNumber'].filter((key) => !body?.[key])
          if (missing.length) {
            sendJSON(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` })
            return
          }
          if (body?.baseUrl !== undefined && !allowGitHubBaseUrlOverride) {
            sendJSON(res, 400, { error: 'A work item baseUrl override is not permitted on this server' })
            return
          }
          const workItemBaseUrl = allowGitHubBaseUrlOverride ? body?.baseUrl : undefined

          const pat = getCredential(req)
          if (!pat) {
            sendAuthenticationRequired(res, { provider: 'github' })
            return
          }

          const githubLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
          const instanceOptions = githubLocation
            ? { github: { ...githubLocation, pat } }
            : { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }

          try {
            const workItem = await linkInstanceToWorkItem(
              slug,
              { provider: 'github', owner, repository, parentNumber: Number(parentNumber), pat, baseUrl: workItemBaseUrl },
              { ...instanceOptions, definitionsDir }
            )
            sendJSON(res, 200, workItem)
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            const status = /already linked/.test(err.message) ? 409 : 400
            sendJSON(res, status, { error: err.message })
          }
          return
        }

        // #30: the GitLab twin of the `github` branch above — links to an existing GitLab Issue
        // (`body.namespace`/`body.repository`/`body.parentIid`, GitLab's own project-scoped issue
        // number). There's no `resolveGitLabLocation` yet (registering a GitLab-backed workspace is
        // #25's own job — not yet landed), so `instanceOptions` always reads/writes this instance's own
        // data locally; a local instance linking to a remote GitLab issue is exactly the same shape the
        // `github` branch above already supports for a not-GitHub-backed instance.
        if (body?.provider === 'gitlab') {
          const { namespace, repository, parentIid } = body
          const missing = ['namespace', 'repository', 'parentIid'].filter((key) => !body?.[key])
          if (missing.length) {
            sendJSON(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` })
            return
          }
          if (body?.baseUrl !== undefined && !allowGitLabBaseUrlOverride) {
            sendJSON(res, 400, { error: 'A work item baseUrl override is not permitted on this server' })
            return
          }
          const workItemBaseUrl = allowGitLabBaseUrlOverride ? body?.baseUrl : undefined

          const pat = getCredential(req)
          if (!pat) {
            sendAuthenticationRequired(res, { provider: 'gitlab' })
            return
          }

          const instanceOptions = { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }

          try {
            const workItem = await linkInstanceToWorkItem(
              slug,
              { provider: 'gitlab', namespace, repository, parentIid: Number(parentIid), pat, baseUrl: workItemBaseUrl },
              { ...instanceOptions, definitionsDir }
            )
            sendJSON(res, 200, workItem)
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            const status = /already linked/.test(err.message) ? 409 : 400
            sendJSON(res, status, { error: err.message })
          }
          return
        }

        // #24: a declared provider other than 'github'/'gitlab' used to fall straight through to the
        // Azure DevOps branch below unconditionally (`body?.provider === 'github' ? ... : <assume
        // azure-devops>`) — for a third, genuinely-declared provider that meant running Azure DevOps's
        // own field validation against a body that was never shaped for it, surfacing a confusing
        // "missing organization/project/parentId" 400 instead of a clear "not supported yet" one. An
        // absent `provider` still means Azure DevOps, unchanged (every caller before #14).
        if (body?.provider !== undefined && body.provider !== 'azure-devops') {
          sendJSON(res, 400, { error: `Linking an instance to a "${body.provider}" work item is not supported yet.` })
          return
        }

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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = definition.stages.find((s) => s.id === bootstrapInstance.stage)
            if (!stage) {
              throw new Error(`Instance "${slug}" has no stage "${bootstrapInstance.stage}"`)
            }
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            instanceOptions = { azureDevOps: { ...azureDevOpsBase, branch } }
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            throw err
          }
        }

        try {
          const result = await tagLinkedWorkItems(slug, { ...instanceOptions, pat })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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

        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: resolved?.provider ?? 'azure-devops' })
          return
        }

        let instanceOptions = { instancesDir: resolveLocalDataDir(slug, instancesDir, scopeId) }
        if (resolved?.provider === 'azure-devops') {
          const azureDevOpsBase = { ...resolved.location, pat }
          try {
            const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate })
            const branch = await resolveStageBranch(azureDevOpsBase, definition, slug, stage.id)
            instanceOptions = { azureDevOps: { ...azureDevOpsBase, branch } }
          } catch (err) {
            if (err instanceof AuthenticationError) {
              sendAuthenticationRequired(res, { provider: err.provider })
              return
            }
            throw err
          }
        } else if (resolved) {
          // No per-stage branch yet for a provider besides Azure DevOps (#12 added GitHub's read/write
          // against `main` directly) — a future provider's own stage-branch support plugs in above,
          // keyed by its own provider id, rather than this falling to whichever provider isn't Azure
          // DevOps (#24).
          instanceOptions = providerCredentialOptions(resolved, pat)
        }

        try {
          const result = await syncGatePassToWorkItem(slug, { gate }, { ...instanceOptions, definitionsDir, pat })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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

      // Request Review is an ungated, advisory action. Each request creates its own Azure DevOps Task
      // or, for a GitHub-backed instance (#15, docs/adr/0040), its own labelled/assigned issue — and is
      // tracked against the stage being viewed; unlike Request Sign-off, it never opens or changes a
      // Pull Request and is not available for local instances.
      if (url.pathname === '/api/instance/request-review' && req.method === 'POST') {
        const { slug, scopeId, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const rawBody = await readBody(req)
        const body = rawBody ? JSON.parse(rawBody) : {}
        const stageId = body?.stage ?? url.searchParams.get('stage') ?? undefined
        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)
        if (!resolved) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — review requests are only supported for Workspace-backed instances.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: resolved.provider })
          return
        }

        try {
          const result = await requestStageReview(
            slug,
            { reviewer: body?.reviewer, stageId, instanceUrl: instanceStageUrl(req, slug, stageId) },
            { ...providerCredentialOptions(resolved, pat), definitionsDir }
          )
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Request Review', provider: err.provider })
            return
          }
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      // Review status is read only on this explicit action (Azure DevOps Task native/custom-field
      // state, or a GitHub review issue's current `gantry:review/*` label — #15). The result is
      // persisted so the status card remains useful across reloads without introducing polling on
      // GET /api/instance.
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
        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)
        if (!resolved) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — review statuses are only supported for Workspace-backed instances.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: resolved.provider })
          return
        }

        try {
          const result = await checkStageReviewStatus(slug, { reviewId, stageId }, { ...providerCredentialOptions(resolved, pat), definitionsDir })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Check Review status', provider: err.provider })
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

        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)
        if (!resolved) {
          sendJSON(res, 400, {
            error: `Instance "${slug}" is not Workspace-backed — there is no stage branch or Pull Request to open for it.`,
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: resolved.provider })
          return
        }

        try {
          const result = await requestStageApproval(slug, {
            ...providerCredentialOptions(resolved, pat),
            definitionsDir,
            gate,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: err.operation ?? 'Request Approval', provider: err.provider })
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

        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)
        if (!resolved) {
          sendJSON(res, 400, {
            error:
              `Instance "${slug}" is not Workspace-backed — it has no Pull Request to check. Local instances ` +
              'advance through their own self-serve action instead.',
          })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: resolved.provider })
          return
        }

        try {
          const result = await checkStageApprovalStatus(slug, {
            ...providerCredentialOptions(resolved, pat),
            definitionsDir,
            gate,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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
            const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
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
            if (err instanceof AuthenticationError) {
              throw err
            }
            if (err instanceof NotFoundError) {
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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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

      // Lists a Jira Cloud project's own live-configured issue types (#48, ADR-0042's "Jira issue
      // type" section) — the Atlassian twin of `GET /api/azure-devops/work-item-types` immediately
      // above: the "+ New Workspace" wizard's Register step uses this to build a real picker (once
      // Jira Site + Jira Project are both entered) rather than hardcoding one, mirroring Azure DevOps's
      // own `loadWorkItemTypes()` pattern. Read-only; carries no `organization`/`project`/`baseUrl`
      // SSRF surface the way the Azure DevOps route above does — Atlassian is Cloud-only (ADR-0042: no
      // caller-supplied `baseUrl` at all), so this only ever reaches this client's own fixed
      // `https://<jiraSite>` host. Gated behind the same credential-provider seam (#86) as every other
      // Provider-backed route — the single `Authorization` header here carries the Jira token alone
      // (unlike `POST /api/workspaces`'s own atlassian path, this route only ever talks to one
      // product, so there is nothing for a second header to carry).
      if (url.pathname === '/api/atlassian/issue-types' && req.method === 'GET') {
        const jiraSite = url.searchParams.get('jiraSite')
        const jiraProjectKey = url.searchParams.get('jiraProjectKey')
        const missing = ['jiraSite', 'jiraProjectKey'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider: 'atlassian' })
          return
        }

        try {
          const client = resolveWorkItems('atlassian', { jiraSite, jiraProjectKey, pat, baseUrl: atlassianJiraBaseUrl })
          const types = await client.listIssueTypes()
          sendJSON(
            res,
            200,
            types.filter((t) => !t.subtask).map((t) => ({ name: t.name }))
          )
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider, credentialRejected: true, operation: 'loading Jira issue types' })
            return
          }
          if (err instanceof RepoNotFoundError) {
            sendJSON(res, 400, { error: err.message })
            return
          }
          throw err
        }
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
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `No work item ${id} found in ${org}/${proj}` })
                return
              }
              throw err
            }
          }
        )
        return
      }

      // The GitHub twin of `GET /api/azure-devops/work-items/:id` above (#14) — the "+ New Workspace"
      // wizard's parent-issue look-up for a GitHub workspace's link step. No work-item-*type* lookup
      // route exists for GitHub (docs/adr/0040: there is no type to pick), so this is the only lookup
      // route GitHub needs. `owner`/`repository` are entirely caller-supplied (never a gantry slug or
      // registry entry), gated the same way as every other caller-supplied-location GitHub route:
      // credential-provider seam + `allowGitHubBaseUrlOverride`.
      const githubWorkItemLookupMatch = url.pathname.match(/^\/api\/github\/work-items\/(\d+)$/)
      if (githubWorkItemLookupMatch && req.method === 'GET') {
        const number = Number(githubWorkItemLookupMatch[1])
        const owner = url.searchParams.get('owner')
        const repository = url.searchParams.get('repository')
        const missing = ['owner', 'repository'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowGitHubBaseUrlOverride) {
          sendJSON(res, 400, { error: 'The "baseUrl" query parameter is not permitted on this server.' })
          return
        }

        await withGitHubCredential(
          req,
          res,
          { owner, repository, baseUrl: requestedBaseUrl },
          async ({ owner: ownerName, repository: repoName, pat, baseUrl }) => {
            const client = createGitHubWorkItemsClient({ owner: ownerName, repository: repoName, pat, baseUrl })
            try {
              const issue = await client.getIssue(number)
              sendJSON(res, 200, { number: issue.number, title: issue.title ?? '', state: issue.state ?? '' })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `No issue #${number} found in ${ownerName}/${repoName}` })
                return
              }
              throw err
            }
          }
        )
        return
      }

      // The GitHub twin of `POST /api/azure-devops/work-items` above (#14) — the wizard's "create a new
      // parent work item" mode for a GitHub workspace: creates a plain issue, with no `workItemType`
      // (docs/adr/0040).
      if (url.pathname === '/api/github/work-items' && req.method === 'POST') {
        const rawBody = await readBody(req)
        let body
        try {
          body = rawBody ? JSON.parse(rawBody) : null
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const owner = body?.owner
        const repository = body?.repository
        const title = body?.title
        const missing = []
        if (!owner) missing.push('owner')
        if (!repository) missing.push('repository')
        if (!title) missing.push('title')
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` })
          return
        }
        const requestedBaseUrl = body?.baseUrl ?? undefined
        if (requestedBaseUrl && !allowGitHubBaseUrlOverride) {
          sendJSON(res, 400, { error: 'The "baseUrl" field is not permitted on this server.' })
          return
        }
        await withGitHubCredential(
          req,
          res,
          { owner, repository, baseUrl: requestedBaseUrl },
          async ({ owner: ownerName, repository: repoName, pat, baseUrl }) => {
            const client = createGitHubWorkItemsClient({ owner: ownerName, repository: repoName, pat, baseUrl })
            const issue = await client.createIssue({ title })
            sendJSON(res, 201, { number: issue.number, title: issue.title ?? title, state: issue.state ?? '' })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
                  if (err instanceof AuthenticationError) throw err
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

        const githubLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubLocation) {
          await withGitHubCredential(req, res, githubLocation, async (githubBase) => {
            // Read-only bootstrap (against 'main', the client's own default) purely to learn which stage this request is actually browsing — never itself starts a stage's branch lifecycle (#12, mirroring #122's Azure DevOps contract): opening the module editor to look must not create a branch, only saving something does (see PUT /api/instance/modules/:id below).
            const bootstrapInstance = await readInstance(slug, { github: githubBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }

            // Only report this stage's real content once work has actually begun on it (its branch exists) — otherwise the bootstrap read above (against 'main') already is that stage's real content, since nothing has diverged from it yet.
            // A completed stage (free-browsing a stage the instance has already advanced past) must read from main, not its stale leftover branch — mirrors #122/WI264's Azure DevOps contract.
            let branch = await findGitHubStageBranch(githubBase, slug, stage.id)
            const viewedIdxForBranch = definition.stages.findIndex((s) => s.id === stage.id)
            const currentIdxForBranch = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
            if (viewedIdxForBranch !== -1 && currentIdxForBranch !== -1 && viewedIdxForBranch < currentIdxForBranch) {
              branch = undefined
            }
            const github = branch ? { ...githubBase, branch } : githubBase
            const instance = branch ? await readInstance(slug, { github }) : bootstrapInstance

            const modules = await Promise.all(
              stage.modules.map(async (moduleId) => {
                let data = { status: 'draft', owner: '', fields: {} }
                try {
                  data = await readModule(definition, slug, moduleId, { github })
                } catch (err) {
                  if (err instanceof AuthenticationError) throw err
                  if (!/has no saved data/.test(err.message)) throw err
                }
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

            sendJSON(res, 200, {
              ...buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, true, githubLocation, null, instancesDir, scopeId),
              archived: isInstanceArchived(slug, { instancesDir, scopeId }),
              // No pull-requests capability yet (#13) — GitHub has no sync-status affordance to report.
              stageSync: { behind: false, behindFiles: [], ahead: false },
            })
          })
          return
        }

        // #35 (ADR-0041) — the GitLab twin of the `github` branch above: same shape, over GitLab's own
        // `{ namespace, repository }` location and `findGitLabStageBranch` (#29). GitLab has no
        // registered pull-requests capability yet either (ADR-0041's own scope list — a later ticket),
        // so this reports no sync-status affordance, exactly mirroring GitHub's own pre-#13 shape above.
        const gitlabInstanceLocation = resolveGitLabLocation(slug, instancesDir, scopeId)
        if (gitlabInstanceLocation) {
          await withGitLabCredential(req, res, gitlabInstanceLocation, async (gitlabBase) => {
            const bootstrapInstance = await readInstance(slug, { gitlab: gitlabBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stageId = resolveStageIdParam(url, definition, bootstrapInstance.stage)
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }

            let branch = await findGitLabStageBranch(gitlabBase, slug, stage.id)
            const viewedIdxForBranch = definition.stages.findIndex((s) => s.id === stage.id)
            const currentIdxForBranch = definition.stages.findIndex((s) => s.id === bootstrapInstance.stage)
            if (viewedIdxForBranch !== -1 && currentIdxForBranch !== -1 && viewedIdxForBranch < currentIdxForBranch) {
              branch = undefined
            }
            const gitlab = branch ? { ...gitlabBase, branch } : gitlabBase
            const instance = branch ? await readInstance(slug, { gitlab }) : bootstrapInstance

            const modules = await Promise.all(
              stage.modules.map(async (moduleId) => {
                let data = { status: 'draft', owner: '', fields: {} }
                try {
                  data = await readModule(definition, slug, moduleId, { gitlab })
                } catch (err) {
                  if (err instanceof AuthenticationError) throw err
                  if (!/has no saved data/.test(err.message)) throw err
                }
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

            sendJSON(res, 200, {
              ...buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, true, gitlabInstanceLocation, null, instancesDir, scopeId),
              archived: isInstanceArchived(slug, { instancesDir, scopeId }),
              stageSync: { behind: false, behindFiles: [], ahead: false },
            })
          })
          return
        }

        const resolvedInstanceDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedInstanceDir })
        const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
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
          const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
            if (err instanceof NotFoundError) {
              sendJSON(res, 404, { error: err.message })
              return
            }
            if (err instanceof AuthenticationError) throw err
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
        const resolved = resolveInstanceProviderLocation(slug, instancesDir, scopeId)
        if (!resolved) {
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
          sendAuthenticationRequired(res, { provider: resolved.provider })
          return
        }
        try {
          const result = await reopenStage(slug, stageId, {
            ...providerCredentialOptions(resolved, pat),
            definitionsDir,
          })
          sendJSON(res, 200, result)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: 'Re-open stage', provider: err.provider })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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

        const githubLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubLocation) {
          await withGitHubCredential(req, res, githubLocation, async (githubBase) => {
            const bootstrapInstance = await readInstance(slug, { github: githubBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
            const branch = await resolveGitHubStageBranch(githubBase, definition, slug, stage.id)
            const github = { ...githubBase, branch }
            const titles = moduleIds.map((id) => definition.modules.get(id).title)
            // #11's own acceptance criterion — one Save is one commit — is enforced by writeModules
            // itself (a single Git Data API commit for every changed module); #12 lands that commit on
            // the stage's own branch (creating/stacking it on first write), never on `main` directly.
            const saved = await writeModules(definition, slug, modules, { github, message: `Save ${stage.title}: ${titles.join(', ')}` })
            const status = await getStatus(slug, { github, definitionsDir, stageId })
            sendJSON(res, 200, { ...status, saved: saved.modules, commit: saved.commit })
          })
          return
        }

        const resolvedModuleDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedModuleDir })
        const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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

        const githubLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubLocation) {
          await withGitHubCredential(req, res, githubLocation, async (githubBase) => {
            const bootstrapInstance = await readInstance(slug, { github: githubBase })
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
            const stageId = url.searchParams.get('stage') ?? bootstrapInstance.stage
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }
            const branch = await resolveGitHubStageBranch(githubBase, definition, slug, stage.id)
            const github = { ...githubBase, branch }

            const body = JSON.parse(await readBody(req))
            await writeModule(definition, slug, moduleId, body, { github })
            // No render-on-save (WI #376, ADR-0034): documents are rendered only when the author clicks Render.
            sendJSON(res, 200, await getStatus(slug, { github, definitionsDir, stageId }))
          })
          return
        }

        const resolvedModuleDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const instance = readInstance(slug, { instancesDir: resolvedModuleDir })
        const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
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
            const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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

        // #16 — GitHub twin of the Azure-DevOps-backed branch above. No stage-branch resolution yet
        // (#12) — every read/write here targets `main` directly, unlike the Azure-DevOps-backed branch
        // above which resolves a per-stage branch first.
        const githubRenderLocation = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubRenderLocation) {
          await withGitHubCredential(req, res, githubRenderLocation, async (githubBase) => {
            const instance = await readInstance(slug, { github: githubBase })
            const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
            const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
            const reviewSummary = artefactSpec
              ? buildReviewSummaryForArtefact(definition, artefactSpec, instance, githubBase, null, 'github')
              : undefined

            const format = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
            const result = await renderArtefact(slug, artefactId, { github: githubBase, instancesDir, definitionsDir, reviewSummary, format })
            sendJSON(res, 200, {
              artefact: artefactId,
              format,
              githubPath: result.githubPath,
              githubUrl: githubArtefactFileUrl(githubBase, result.githubPath, githubBase.branch ?? 'main'),
            })
          })
          return
        }

        // #31 — GitLab twin of the GitHub branch above. No stage-branch resolution yet (#29) — every
        // read/write here targets `main` directly, unlike the Azure-DevOps-backed branch above which
        // resolves a per-stage branch first.
        const gitlabRenderLocation = resolveGitLabLocation(slug, instancesDir, scopeId)
        if (gitlabRenderLocation) {
          await withGitLabCredential(req, res, gitlabRenderLocation, async (gitlabBase) => {
            const instance = await readInstance(slug, { gitlab: gitlabBase })
            const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
            const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
            const reviewSummary = artefactSpec
              ? buildReviewSummaryForArtefact(definition, artefactSpec, instance, gitlabBase, null, 'gitlab')
              : undefined

            const format = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
            const result = await renderArtefact(slug, artefactId, { gitlab: gitlabBase, instancesDir, definitionsDir, reviewSummary, format })
            sendJSON(res, 200, {
              artefact: artefactId,
              format,
              gitlabPath: result.gitlabPath,
              gitlabUrl: gitlabArtefactFileUrl(gitlabBase, result.gitlabPath, gitlabBase.branch ?? 'main'),
            })
          })
          return
        }

        // Local render — build a minimal reviewSummary so the Document Control
        // block still appears with a plain hash and Pending row.
        const resolvedRenderDir = resolveLocalDataDir(slug, instancesDir, scopeId)
        const localInstance = readInstance(slug, { instancesDir: resolvedRenderDir })
        const localDefinition = loadDefinition(localInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, localInstance.definition), version: instanceDefinitionVersion(localInstance) })
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
        const githubWasmPrepareLocation = azureDevOpsLocation ? null : resolveGitHubLocation(slug, instancesDir, scopeId)
        const gitlabWasmPrepareLocation =
          azureDevOpsLocation || githubWasmPrepareLocation ? null : resolveGitLabLocation(slug, instancesDir, scopeId)
        if (!azureDevOpsLocation && !githubWasmPrepareLocation && !gitlabWasmPrepareLocation) {
          // WI #349 — a plain local instance (under `instancesDir`, e.g. the bundled `examples`).
          // Compiles the artefact (dry run: no `pandoc` subprocess — a zip-release install has
          // none) and writes the .md alongside where the .docx will land, exactly as the native
          // `/api/instance/render/:artefact` route does; the browser converts the markdown with
          // pandoc-wasm and hands the bytes to render-wasm-finish below. The Document Control
          // block is already stamped here (git hash or .build-info.json, AB#345).
          const resolvedWasmPrepareDir = resolveLocalDataDir(slug, instancesDir, scopeId)
          const localInstance = readInstance(slug, { instancesDir: resolvedWasmPrepareDir })
          const localDefinition = loadDefinition(localInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, localInstance.definition), version: instanceDefinitionVersion(localInstance) })
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
        if (githubWasmPrepareLocation) {
          // #16 — GitHub twin of the Azure-DevOps-backed branch below. No stage-branch resolution
          // yet (#12) — every read/write here targets `main` directly.
          await withGitHubCredential(req, res, githubWasmPrepareLocation, async (githubBase) => {
            const instance = await readInstance(slug, { github: githubBase })
            const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
            const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
            const reviewSummary = artefactSpec
              ? buildReviewSummaryForArtefact(definition, artefactSpec, instance, githubBase, null, 'github')
              : undefined

            const result = await prepareGitHubWasmRender(slug, artefactId, { github: githubBase, instancesDir, definitionsDir, reviewSummary })
            const wasmPrepared = externaliseImagesForWasm(result.markdown)
            sendJSON(res, 200, {
              artefact: artefactId,
              markdown: wasmPrepared.markdown,
              imageFilesBase64: wasmPrepared.files,
              basename: result.basename,
              referenceDocBase64: result.referenceDocPath ? readFileSync(result.referenceDocPath).toString('base64') : null,
              commit: result.commit,
              githubPath: result.githubPath,
              branch: result.branch,
            })
          })
          return
        }
        if (gitlabWasmPrepareLocation) {
          // #31 — GitLab twin of the GitHub branch above. No stage-branch resolution yet (#29) —
          // every read/write here targets `main` directly.
          await withGitLabCredential(req, res, gitlabWasmPrepareLocation, async (gitlabBase) => {
            const instance = await readInstance(slug, { gitlab: gitlabBase })
            const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
            const artefactSpec = definition.artefacts.find((a) => a.id === artefactId)
            const reviewSummary = artefactSpec
              ? buildReviewSummaryForArtefact(definition, artefactSpec, instance, gitlabBase, null, 'gitlab')
              : undefined

            const result = await prepareGitLabWasmRender(slug, artefactId, { gitlab: gitlabBase, instancesDir, definitionsDir, reviewSummary })
            const wasmPrepared = externaliseImagesForWasm(result.markdown)
            sendJSON(res, 200, {
              artefact: artefactId,
              markdown: wasmPrepared.markdown,
              imageFilesBase64: wasmPrepared.files,
              basename: result.basename,
              referenceDocBase64: result.referenceDocPath ? readFileSync(result.referenceDocPath).toString('base64') : null,
              commit: result.commit,
              gitlabPath: result.gitlabPath,
              branch: result.branch,
            })
          })
          return
        }
        await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOpsBase) => {
          const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
          const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
        const githubWasmFinishLocation = azureDevOpsLocation ? null : resolveGitHubLocation(slug, instancesDir, scopeId)
        const gitlabWasmFinishLocation =
          azureDevOpsLocation || githubWasmFinishLocation ? null : resolveGitLabLocation(slug, instancesDir, scopeId)
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
        if (!azureDevOpsLocation && !githubWasmFinishLocation && !gitlabWasmFinishLocation) {
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
        if (githubWasmFinishLocation) {
          // #16 — GitHub twin of the Azure-DevOps-backed branch below.
          if (!body || typeof body.docxBase64 !== 'string' || typeof body.githubPath !== 'string' || !body.commit?.hash) {
            sendJSON(res, 400, { error: 'Body must include docxBase64, githubPath, and commit' })
            return
          }
          await withGitHubCredential(req, res, githubWasmFinishLocation, async (githubBase) => {
            const github = { ...githubBase, branch: body.branch }
            await finishGitHubWasmRender(Buffer.from(body.docxBase64, 'base64'), {
              github,
              githubPath: body.githubPath,
              branch: body.branch,
              commit: body.commit,
              artefactId,
            })
            sendJSON(res, 200, {
              artefact: artefactId,
              githubPath: body.githubPath,
              githubUrl: githubArtefactFileUrl(github, body.githubPath, body.branch ?? 'main'),
            })
          })
          return
        }
        if (gitlabWasmFinishLocation) {
          // #31 — GitLab twin of the GitHub branch above.
          if (!body || typeof body.docxBase64 !== 'string' || typeof body.gitlabPath !== 'string' || !body.commit?.hash) {
            sendJSON(res, 400, { error: 'Body must include docxBase64, gitlabPath, and commit' })
            return
          }
          await withGitLabCredential(req, res, gitlabWasmFinishLocation, async (gitlabBase) => {
            const gitlab = { ...gitlabBase, branch: body.branch }
            await finishGitLabWasmRender(Buffer.from(body.docxBase64, 'base64'), {
              gitlab,
              gitlabPath: body.gitlabPath,
              branch: body.branch,
              commit: body.commit,
              artefactId,
            })
            sendJSON(res, 200, {
              artefact: artefactId,
              gitlabPath: body.gitlabPath,
              gitlabUrl: gitlabArtefactFileUrl(gitlab, body.gitlabPath, body.branch ?? 'main'),
            })
          })
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
              const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
        // #16 — GitHub twin of the Azure-DevOps-backed branch above. No stage-branch lifecycle yet
        // (#12), so this always lists `main` (or `?stage=`'s effect is a no-op) — no branch/main
        // union fetch needed.
        const githubAssetsLoc = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubAssetsLoc) {
          await withGitHubCredential(req, res, githubAssetsLoc, async (githubBase) => {
            const client = resolveContentStore('github', githubBase)
            const items = await client.listFolder(githubAssetsDir(slug), { branch: githubBase.branch ?? 'main' })
            const assets = items
              .filter((item) => !item.isFolder)
              .map((item) => {
                const filename = item.path.split('/').pop()
                return { id: filename, filename, name: filename, source: '', uploadedBy: '', usedIn: [] }
              })
              .sort((a, b) => a.filename.localeCompare(b.filename))
            sendJSON(res, 200, assets)
          })
          return
        }
        // #31 — GitLab twin of the GitHub branch above. No stage-branch lifecycle yet (#29), so this
        // always lists `main` (or `?stage=`'s effect is a no-op) — no branch/main union fetch needed.
        const gitlabAssetsLoc = resolveGitLabLocation(slug, instancesDir, scopeId)
        if (gitlabAssetsLoc) {
          await withGitLabCredential(req, res, gitlabAssetsLoc, async (gitlabBase) => {
            const client = resolveContentStore('gitlab', gitlabBase)
            const items = await client.listFolder(gitlabAssetsDir(slug), { branch: gitlabBase.branch ?? 'main' })
            const assets = items
              .filter((item) => !item.isFolder)
              .map((item) => {
                const filename = item.path.split('/').pop()
                return { id: filename, filename, name: filename, source: '', uploadedBy: '', usedIn: [] }
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
        const definition = loadDefinition(instance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, instance.definition), version: instanceDefinitionVersion(instance) })
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
        // #16 — unlike the Azure DevOps branch above, a GitHub-backed instance's asset upload IS
        // wired through gantry itself: the bytes are committed straight to
        // `gantry-workspace/<slug>/assets/<filename>` via the same content-store write every module
        // save already uses (#11), and the reference the caller inserts is the plain repo-asset
        // convention (`![name](assets/<filename>)`, WI260) — no manifest, no `source` metadata,
        // since a GitHub-committed asset cites itself (see lib/render.js's citationUrl).
        const githubLocForPost = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubLocForPost) {
          await withGitHubCredential(req, res, githubLocForPost, async (githubBase) => {
            const body = JSON.parse(await readBody(req))
            const filename = body.filename
            if (typeof filename !== 'string' || !filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
              sendJSON(res, 400, { error: `Invalid asset filename "${filename}"` })
              return
            }
            const ext = extname(filename).toLowerCase()
            if (!ALLOWED_EXTENSIONS.has(ext)) {
              sendJSON(res, 400, { error: `Unsupported image file type "${ext || '(none)'}" — expected .png, .jpg, or .jpeg.` })
              return
            }
            if (!body.dataBase64) {
              sendJSON(res, 400, { error: 'An image file is required.' })
              return
            }
            const client = resolveContentStore('github', githubBase)
            await client.writeFile(githubAssetPath(slug, filename), body.dataBase64, {
              contentType: 'base64encoded',
              message: `Upload asset "${filename}"`,
              branch: githubBase.branch,
            })
            sendJSON(res, 201, {
              id: filename,
              filename,
              name: (body.name ?? '').trim() || filename,
              source: (body.source ?? '').trim(),
              uploadedBy: (body.uploadedBy ?? '').trim(),
            })
          })
          return
        }
        // #31 — GitLab twin of the GitHub branch above: a GitLab-backed instance's asset upload is
        // wired through gantry the same way, committing straight to
        // `gantry-workspace/<slug>/assets/<filename>` via the content store's own writeFile (#26).
        const gitlabLocForPost = resolveGitLabLocation(slug, instancesDir, scopeId)
        if (gitlabLocForPost) {
          await withGitLabCredential(req, res, gitlabLocForPost, async (gitlabBase) => {
            const body = JSON.parse(await readBody(req))
            const filename = body.filename
            if (typeof filename !== 'string' || !filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
              sendJSON(res, 400, { error: `Invalid asset filename "${filename}"` })
              return
            }
            const ext = extname(filename).toLowerCase()
            if (!ALLOWED_EXTENSIONS.has(ext)) {
              sendJSON(res, 400, { error: `Unsupported image file type "${ext || '(none)'}" — expected .png, .jpg, or .jpeg.` })
              return
            }
            if (!body.dataBase64) {
              sendJSON(res, 400, { error: 'An image file is required.' })
              return
            }
            const client = resolveContentStore('gitlab', gitlabBase)
            await client.writeFile(gitlabAssetPath(slug, filename), body.dataBase64, {
              contentType: 'base64encoded',
              message: `Upload asset "${filename}"`,
              branch: gitlabBase.branch,
            })
            sendJSON(res, 201, {
              id: filename,
              filename,
              name: (body.name ?? '').trim() || filename,
              source: (body.source ?? '').trim(),
              uploadedBy: (body.uploadedBy ?? '').trim(),
            })
          })
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
              const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: definitionsDirForScope(definitionsDir, instancesDir, slug, scopeId, bootstrapInstance.definition), version: instanceDefinitionVersion(bootstrapInstance) })
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
              if (err instanceof NotFoundError) {
                // Fallback: if not on the stage branch, try main explicitly before 404 — covers assets committed before the branch was created.
                if (azureDevOps.branch && azureDevOps.branch !== 'main') {
                  try {
                    const mainClient = createAzureDevOpsClient({ ...azureDevOpsBase })
                    content = await mainClient.getFileContent(assetPath, { branch: 'main' })
                  } catch (fallbackErr) {
                    if (fallbackErr instanceof NotFoundError) {
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
        // #16 — GitHub twin of the Azure-DevOps-backed branch above. No stage-branch lifecycle yet
        // (#12), so this always reads `main` directly — no branch-then-fall-back-to-main dance.
        const githubAssetFileLoc = resolveGitHubLocation(slug, instancesDir, scopeId)
        if (githubAssetFileLoc) {
          const filename = decodeURIComponent(assetFileMatch[1])
          if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            sendJSON(res, 400, { error: `Invalid asset filename "${filename}"` })
            return
          }
          await withGitHubCredential(req, res, githubAssetFileLoc, async (githubBase) => {
            const client = resolveContentStore('github', githubBase)
            const assetPath = githubAssetPath(slug, filename)
            let bytes
            try {
              // #16: `getFileBytes` (not `getFileContent`) — the Contents API's real bytes, not the
              // text-decoded string `getFileContent` returns, which would corrupt a binary image.
              bytes = await client.getFileBytes(assetPath, { branch: githubBase.branch ?? 'main' })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `No asset "${filename}" for instance "${slug}"` })
                return
              }
              throw err
            }
            const ext = extname(filename).toLowerCase()
            const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
            res.writeHead(200, { 'Content-Type': contentType })
            res.end(bytes)
          })
          return
        }
        // #31 — GitLab twin of the GitHub branch above. No stage-branch lifecycle yet (#29), so this
        // always reads `main` directly — no branch-then-fall-back-to-main dance.
        const gitlabAssetFileLoc = resolveGitLabLocation(slug, instancesDir, scopeId)
        if (gitlabAssetFileLoc) {
          const filename = decodeURIComponent(assetFileMatch[1])
          if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            sendJSON(res, 400, { error: `Invalid asset filename "${filename}"` })
            return
          }
          await withGitLabCredential(req, res, gitlabAssetFileLoc, async (gitlabBase) => {
            const client = resolveContentStore('gitlab', gitlabBase)
            const assetPath = gitlabAssetPath(slug, filename)
            let bytes
            try {
              bytes = await client.getFileBytes(assetPath, { branch: gitlabBase.branch ?? 'main' })
            } catch (err) {
              if (err instanceof NotFoundError) {
                sendJSON(res, 404, { error: `No asset "${filename}" for instance "${slug}"` })
                return
              }
              throw err
            }
            const ext = extname(filename).toLowerCase()
            const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
            res.writeHead(200, { 'Content-Type': contentType })
            res.end(bytes)
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

      // Identity search endpoint (#145 Part 2; extended #10 for GitHub docs/adr/0040, and #28 for
      // GitLab ADR-0041) — proxies a provider's own identity/member directory behind the standard PAT
      // credential seam. Returns an array of `{ uniqueName, displayName, emailAddress, id }` objects
      // for the front-end's identity picker component — plus, for GitHub and GitLab, `canAssign` and
      // (when `false`) `blockedReason`, since both providers reject an assignee without sufficient
      // access. Scoped to whichever location the caller names: a `slug` (an already-known instance —
      // Azure DevOps only today, since neither a GitHub- nor a GitLab-backed instance has this lookup
      // wired in through `slug` yet), explicit `organization`+`project` (Azure DevOps),
      // `provider=github`+`owner`+`repository`, or `provider=gitlab`+`namespace`+`repository` query
      // params (mirrors GET /api/azure-devops/work-item-types — the wizard's own Register step, before
      // any workspace exists at all), or — same as before #10 — the first registered workspace, of
      // whichever provider it happens to be.
      if (url.pathname === '/api/identities' && req.method === 'GET') {
        const query = url.searchParams.get('q') ?? ''
        if (!query.trim()) {
          sendJSON(res, 200, [])
          return
        }

        const { slug: identitySlug } = resolveSlugParam(url, defaultSlug, instancesDir)
        let provider = 'azure-devops'
        let location = null
        if (identitySlug) {
          location = resolveAzureDevOpsLocation(identitySlug, instancesDir)
        }
        if (!location) {
          const requestedProvider = url.searchParams.get('provider')
          // #24: a declared `provider` other than 'github'/'gitlab' used to fall straight through to
          // the Azure DevOps branch below unconditionally — for a third, genuinely-declared provider
          // with no `organization`/`project` params either, that silently fell all the way through to
          // this route's own "first registered workspace" default instead of reporting the request's
          // own `provider` as unsupported.
          if (requestedProvider !== null && requestedProvider !== 'github' && requestedProvider !== 'gitlab' && requestedProvider !== 'azure-devops') {
            sendJSON(res, 400, { error: `Identity lookup is not supported yet for provider "${requestedProvider}".` })
            return
          }
          if (requestedProvider === 'github') {
            const ownerParam = url.searchParams.get('owner')
            const repoParam = url.searchParams.get('repository')
            if (ownerParam || repoParam) {
              const missing = ['owner', 'repository'].filter((name) => !url.searchParams.get(name))
              if (missing.length > 0) {
                sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
                return
              }
              const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
              if (requestedBaseUrl && !allowGitHubBaseUrlOverride) {
                sendJSON(res, 400, {
                  error:
                    'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
                    'need to check a location on a GitHub Enterprise Server instance.',
                })
                return
              }
              provider = 'github'
              location = { owner: ownerParam, repository: repoParam, baseUrl: requestedBaseUrl }
            }
          } else if (requestedProvider === 'gitlab') {
            // #28: the GitLab twin of the GitHub branch above — `namespace`+`repository`
            // (ADR-0041's own location fields) rather than `owner`+`repository`.
            const namespaceParam = url.searchParams.get('namespace')
            const repoParam = url.searchParams.get('repository')
            if (namespaceParam || repoParam) {
              const missing = ['namespace', 'repository'].filter((name) => !url.searchParams.get(name))
              if (missing.length > 0) {
                sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
                return
              }
              const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
              if (requestedBaseUrl && !allowGitLabBaseUrlOverride) {
                sendJSON(res, 400, {
                  error:
                    'The "baseUrl" query parameter is not permitted on this server. Contact your administrator if you ' +
                    'need to check a location on a self-hosted GitLab instance.',
                })
                return
              }
              provider = 'gitlab'
              location = { namespace: namespaceParam, repository: repoParam, baseUrl: requestedBaseUrl }
            }
          } else {
            const orgParam = url.searchParams.get('organization')
            const projParam = url.searchParams.get('project')
            if (orgParam || projParam) {
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
              location = { organization: orgParam, project: projParam, baseUrl: requestedBaseUrl }
            }
          }
        }
        if (!location) {
          // Fall back to the first registered workspace, whichever provider it is.
          const workspaces = listWorkspaces({ instancesDir })
          if (workspaces.length > 0) {
            provider = workspaces[0].provider
            location = { ...workspaces[0].location }
          }
        }
        if (!location) {
          // No remote context exists anywhere to search against (a purely
          // local instance, no registered workspace). This isn't a
          // caller error — free-text fields like Assignee route through this
          // same identity-search widget even when no remote org/project is
          // ever going to be available — so it's reported as "no matches"
          // (200), not a 400. A 4xx here would make Chromium log a console
          // error on every keystroke into those fields, for a state the
          // picker already renders correctly as "no results".
          sendJSON(res, 200, [])
          return
        }

        const pat = getCredential(req)
        if (!pat) {
          sendAuthenticationRequired(res, { provider })
          return
        }

        try {
          const identityClient = resolveIdentityCapability(provider, { ...location, pat })
          const identities = await identityClient.searchIdentities(query)
          sendJSON(res, 200, identities)
        } catch (err) {
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { credentialRejected: true, operation: 'identity search', provider: err.provider })
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
          if (err instanceof AuthenticationError) {
            sendAuthenticationRequired(res, { provider: err.provider })
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
      // Stateless structural validation for a *local-workspace definition's own*
      // in-memory draft (WI #384, ADR-0029) — the `/api/local/*` sibling of the
      // library editor's `POST /api/definitions/:id/versions/:n/validate` (WI #381),
      // same `findDefinitionProblemsInStructure` rule set, but under the
      // no-PAT/size-capped `/api/local/*` namespace (docs/adr/0029, WI #299) a local
      // workspace's own definition editor uses for everything, since — unlike the
      // library route — the caller here has no `:id`/`:n` the server could otherwise
      // use to authorize or rate-limit the request. `{ structure }` (the definition-
      // version-projection shape `web/lib/localDefinitionFiles.js`'s
      // `readLocalDefinitionStructure` reads off disk) is the whole body; nothing is
      // written or read from this machine's own disk.
      if (url.pathname === '/api/local/definition/validate' && req.method === 'POST') {
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
          body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON body' })
          return
        }
        const structure = body?.structure
        if (structure === null || typeof structure !== 'object' || Array.isArray(structure)) {
          sendJSON(res, 400, { error: 'structure is required and must be an object' })
          return
        }
        const problems = findDefinitionProblemsInStructure(structure)
        sendJSON(res, 200, { definition: structure.id ?? null, valid: problems.length === 0, problems })
        return
      }

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

      // WI #387 (Feature #380 phase 7) — "local-workspace definitions ship the folder to a
      // stateless endpoint that performs the push" (branch-topology note, ADR-0029): a local
      // workspace's files live only in the author's own browser (WI #384, not yet merged at the
      // time this route was written — see this ticket's own final report for the integration point
      // a real local-workspace Promote UI still needs to wire up), so unlike the server-workspace
      // `POST /api/definitions/:id/versions/:version/promote` above, this route has no folder of its
      // own to read: the caller ships the full version folder itself, `{ id, version, files: [{
      // path, content, contentType }], repoIds }`, and this performs the exact same fan-out (branch,
      // one commit, PR, per repo) — but persists nothing server-side (true statelessness: there is no
      // server-side "this local workspace's promotions" to keep in sync with, only what the caller's
      // own browser remembers). Kept as its own route rather than folded into
      // `runLocalWorkspaceCompute`'s `status/check/validate/render/compile` dispatcher above — that
      // dispatcher's own contract ("Definitions are resolved only from the repo's bundled
      // `definitionsDir`… never from the caller's payload", `lib/localWorkspace.js`) is the opposite
      // of what Promote needs here, so reusing it would misrepresent its own documented promise
      // rather than actually reuse anything. Statelessness doesn't excuse it from the same
      // "published only" rule the server-workspace route enforces via `def.status`: this route reads
      // the same `status` field back out of the caller-supplied `definition.yaml` before touching any
      // repo (review finding against this ticket).
      if (url.pathname === '/api/local/definitions/promote' && req.method === 'POST') {
        let rawBody
        try {
          rawBody = await readBodyWithLimit(req, LOCAL_WORKSPACE_LIMITS.maxBodyBytes)
        } catch (err) {
          if (err.tooLarge) {
            sendJSON(res, 413, { error: `Request body exceeds the ${LOCAL_WORKSPACE_LIMITS.maxBodyBytes}-byte limit for /api/local/* requests` })
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
        const definitionId = body?.id
        const version = Number(body?.version)
        const files = Array.isArray(body?.files) ? body.files : null
        const repoIds = Array.isArray(body?.repoIds) ? body.repoIds : []
        if (typeof definitionId !== 'string' || !definitionId) {
          sendJSON(res, 400, { error: 'id is required' })
          return
        }
        if (!Number.isInteger(version) || version < 1) {
          sendJSON(res, 400, { error: 'version must be a positive integer' })
          return
        }
        if (!files || files.length === 0) {
          sendJSON(res, 400, { error: 'files must be a non-empty array' })
          return
        }
        // This route is stateless (no server-side folder to load the version from — see the doc
        // comment above), so unlike the server-workspace route above it can't call `loadDefinition`
        // to check `status`. It enforces the same "published only" rule the caller's own UI is
        // meant to honour by reading `status` straight out of the shipped `definition.yaml`, the
        // same file `loadDefinition` reads it from — a caller-supplied file set that never declares
        // itself published (or omits `status`, which every versioned definition.yaml written by
        // this codebase always sets — `publishDefinitionVersion` in lib/definition.js) is refused
        // before any repo is touched, exactly as the server-workspace route refuses a draft.
        const definitionYamlFile = files.find((f) => f && f.path === 'definition.yaml')
        if (!definitionYamlFile || typeof definitionYamlFile.content !== 'string') {
          sendJSON(res, 400, { error: 'files must include a definition.yaml' })
          return
        }
        let definitionYaml
        try {
          definitionYaml = parseYAML(definitionYamlFile.content)
        } catch (err) {
          sendJSON(res, 400, { error: `Invalid definition.yaml: ${err.message}` })
          return
        }
        if ((definitionYaml?.status ?? 'published') !== 'published') {
          sendJSON(res, 400, { error: 'Promote is only available for a published version.' })
          return
        }
        if (repoIds.length === 0) {
          sendJSON(res, 400, { error: 'repoIds must be a non-empty array' })
          return
        }
        const repos = []
        for (const repoId of repoIds) {
          const repo = resolveLibraryRepo(repoId, { instancesDir })
          if (!repo) {
            sendJSON(res, 400, { error: `Unknown library repo "${repoId}"` })
            return
          }
          repos.push(repo)
        }
        // #20: see the server-workspace promote route's identical comment above — no blanket PAT
        // guard; each repo's own provider credential is resolved inside the fan-out.
        const results = await fanOutPromoteDefinitionVersion({ definitionId, version, files, repos, pats: libraryPats })
        sendJSON(res, 200, { results })
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
