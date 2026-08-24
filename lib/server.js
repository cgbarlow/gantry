import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { loadDefinition, listDefinitions } from './definition.js'
import { readInstance, readModule, writeModule, createInstance, updateInstanceAssignee } from './instance.js'
import { getStatus } from './status.js'
import { checkGate } from './check.js'
import { renderArtefact } from './render.js'
import { buildImportMap } from './importmap.js'
import { listRegistry } from './registry.js'
import { registerInstance, resolveInstanceLocation, resolveInstanceWorkspaceId } from './instanceRegistry.js'
import {
  registerWorkspace,
  listWorkspaces,
  updateWorkspace,
  assertValidTicketingSystem,
  DEFAULT_TICKETING_SYSTEM,
} from './workspaceRegistry.js'
import { createAsset, getAsset, listAssets } from './assets.js'
import { getCredential } from './credential.js'
import { AzureDevOpsAuthenticationError, AzureDevOpsNotFoundError } from './azureDevOpsClient.js'
import { checkAzureDevOpsRepo } from './repoCheck.js'
import { linkInstanceToWorkItem, syncGatePassToWorkItem } from './workItemLink.js'
import { advanceStage } from './stageAdvancement.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { isValidSlug } from './slug.js'

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
}

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
]

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function serveStaticFile(res, rootDir, relativePath) {
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
  res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' })
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

// Resolves the slug for a single-instance route: the `?slug=` query param, falling back to the server's default slug (`options.slug`) when absent. Returns `{ error }` (never throws) when no slug is available or the slug given fails the single-path-segment check above, so callers can respond with a 400 instead of letting an invalid value reach the filesystem.
function resolveSlugParam(url, defaultSlug) {
  const slug = url.searchParams.get('slug') ?? defaultSlug
  if (!slug) {
    return { error: 'No instance slug given — pass ?slug=<slug> or a default at server startup' }
  }
  if (!isValidSlug(slug)) {
    return { error: `Invalid instance slug "${slug}"` }
  }
  return { slug }
}

function fieldValue(field, data) {
  const raw = data.fields[field.id]
  if (raw !== undefined) return raw
  return field.type === 'list' ? [] : ''
}

// The structured "authentication required" response (#82's spec, built out here per #86): returned identically whether the request carried no PAT at all, or one Azure DevOps itself rejected — callers (the frontend, #87) never have to distinguish the two to know to (re-)prompt for a PAT. Never includes the credential itself, or anything read off it.
function sendAuthenticationRequired(res) {
  sendJSON(res, 401, {
    error: 'authentication_required',
    message:
      'A valid Azure DevOps Personal Access Token is required for this instance. ' +
      'Provide it via HTTP Basic auth (empty username, PAT as password).',
  })
}

// Resolves `slug`'s storage location via the instance registry (#89): `{ organization, project, repository, baseUrl }` for a slug the registry says is Azure-DevOps-backed, or `null` for everything else — a `{ kind: 'local' }` entry, or a slug the registry has never seen at all (resolved locally exactly as an unregistered slug always has been, surfacing readInstance's own "no instance" error rather than this layer inventing one). This is what lets a single running server serve any mix of local and Azure-DevOps-backed instances at once: the routes below ask this per request instead of trusting one location fixed at server startup.
function resolveAzureDevOpsLocation(slug, instancesDir) {
  const location = resolveInstanceLocation(slug, { instancesDir })
  if (location?.kind !== 'azureDevOps') return null
  const { organization, project, repository, baseUrl } = location
  return { organization, project, repository, baseUrl }
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
function buildModuleEntry(definition, stage, moduleId, data, exampleData) {
  const moduleSpec = definition.modules.get(moduleId)
  return {
    id: moduleId,
    title: moduleSpec.title,
    purpose: moduleSpec.purpose,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
    fields: moduleSpec.fields.map((field) => ({
      id: field.id,
      title: field.title,
      type: field.type,
      required: Boolean(field.required) || Boolean(field.requiredAt?.includes(stage.gate)),
      guidance: field.guidance,
      value: fieldValue(field, data),
      example: exampleData ? fieldValue(field, exampleData) : null,
    })),
  }
}

// The `GET /api/instance` response shape, built from an already-loaded definition/stage/instance and the per-module entries above — shared by the local and Azure-DevOps-backed branches of that route for the same reason `buildModuleEntry` is. `isWorkspaceBacked` is the same "does the instance registry resolve this slug's storage as Azure DevOps" check every other single-instance route already makes (`resolveAzureDevOpsLocation`) — surfaced here (as `workspaceBacked`) so the web form's Stage advancement panel (#115) knows to hide its self-serve "Advance to next stage" action entirely for a Workspace-backed instance, which only ever advances via its own Pull Request flow instead (ADR-0014, #122-#125).
function buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, isWorkspaceBacked) {
  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    // The instance's actual persisted stage — distinct from `stage` above once the form is browsing a different stage's modules.
    currentStageId: instance.stage,
    hasExample: Boolean(stage.example),
    stages: definition.stages.map((s) => ({ id: s.id, title: s.title, gate: s.gate })),
    // Only offer artefacts for the viewed stage's own gate, and only once their template actually exists — the design definition declares hld/sad/ssad/as-built ahead of their templates being written.
    artefacts: definition.artefacts
      .filter((a) => a.gate === stage.gate)
      .filter((a) => existsSync(join(definitionsDir, instance.definition, a.template)))
      .map((a) => ({ id: a.id, title: a.title })),
    modules,
    // The instance-level Azure DevOps work-item link (#103) — `null` for an (the default) unlinked instance, or `{ organization, project, workItemType, parentId, stages: { [stageId]: childWorkItemId } }` once linked. Never includes a PAT or anything credential-shaped; this is the same purely-descriptive shape `instance.yaml`'s own `azureDevOps` field already follows.
    workItem: instance.workItem ?? null,
    // The instance record's own stored `assignee` (#97) — previously only
    // surfaced via `GET /api/instances`' registry row, never on this
    // single-instance route. The new Instance Settings screen (#107) needs
    // it alongside the rest of this response (definition/stage/workItem),
    // rather than making a second request against the multi-instance
    // registry route just to read one instance's own field.
    assignee: instance.assignee ?? '',
    workspaceBacked: Boolean(isWorkspaceBacked),
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
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const webDir = options.webDir ?? 'web'
  const nodeModulesDir = options.nodeModulesDir ?? 'node_modules'
  const defaultSlug = options.slug
  // `Array.isArray` (not `?? []`) so a plausible misconfiguration — passing a bare string instead of a single-element array — can't silently degrade the exact-match allow-list check below into a *substring* check (`String.prototype.includes` rather than `Array.prototype.includes`). Anything other than a real array falls back to the same empty, fail-closed default as leaving the option off entirely.
  const allowedAzureDevOpsBaseUrls = Array.isArray(options.allowedAzureDevOpsBaseUrls)
    ? options.allowedAzureDevOpsBaseUrls
    : []
  // See this option's own note above, next to createServer's doc comment.
  const allowAzureDevOpsBaseUrlOverride = options.allowAzureDevOpsBaseUrlOverride ?? false

  const importMap = buildImportMap(FRONT_END_SPECIFIERS, { nodeModulesDir })

  function serveIndexHtml(res) {
    const html = readFileSync(join(webDir, 'index.html'), 'utf8').replace(
      '"__IMPORT_MAP__"',
      JSON.stringify(importMap)
    )
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveIndexHtml(res)
        return
      }

      if (url.pathname.startsWith('/node_modules/')) {
        serveStaticFile(res, nodeModulesDir, url.pathname.slice('/node_modules/'.length))
        return
      }

      if (url.pathname === '/api/definitions' && req.method === 'GET') {
        sendJSON(res, 200, listDefinitions({ definitionsDir }))
        return
      }

      // The workspace registry (#96): every workspace gantry knows about — each one an Azure DevOps organization/project/repository tuple, with its own owner and ticketing-system setting. Read-only listing; no PAT is required or consulted (no PAT is ever stored here — see lib/workspaceRegistry.js's own doc comment).
      if (url.pathname === '/api/workspaces' && req.method === 'GET') {
        sendJSON(res, 200, listWorkspaces({ instancesDir }))
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
          throw err
        }

        try {
          const workspace = registerWorkspace({ organization, project, repository, baseUrl, owner, ticketingSystem }, { instancesDir })
          sendJSON(res, 201, workspace)
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

      if (url.pathname === '/api/instances' && req.method === 'GET') {
        // A PAT is optional here, not required: this route has never gated on a credential the way the single-instance routes do (#86), so a request with none simply sees every local instance plus any Azure-DevOps-backed one it happens to already be able to authenticate to — see lib/registry.js's buildAzureDevOpsRow for why an entry it can't read is left out rather than failing the whole listing.
        const pat = getCredential(req)
        sendJSON(res, 200, await listRegistry({ instancesDir, definitionsDir, pat }))
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
        const { definition: definitionId, slug, owner, assignee, azureDevOps } = body ?? {}
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        const knownDefinitionIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
        if (!knownDefinitionIds.has(definitionId)) {
          sendJSON(res, 400, { error: `Unknown definition "${definitionId}"` })
          return
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
            await createInstance(definitionId, slug, { definitionsDir, owner, assignee, azureDevOps: { ...location, pat } })
          } catch (err) {
            if (err instanceof AzureDevOpsAuthenticationError) {
              sendAuthenticationRequired(res)
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
          createInstance(definitionId, slug, { instancesDir, definitionsDir, owner, assignee })
        } catch (err) {
          const status = /already exists/.test(err.message) ? 409 : 400
          sendJSON(res, status, { error: err.message })
          return
        }
        const created = (await listRegistry({ instancesDir, definitionsDir })).find((i) => i.slug === slug)
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
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        // Mirrors `gantry check <slug> [--gate <id>]` — the dashboard's (#77) "Check" action, run against the instance's current stage unless a specific gate is requested.
        const gate = url.searchParams.get('gate') ?? undefined

        // Dual local/Azure-DevOps-backed dispatch (#103) — this route previously only ever checked the local `instancesDir`, silently ignoring the registry entirely: an Azure-DevOps-backed instance's "Check" action always evaluated a local directory that instance's data never actually lived in. Fixed here as part of #103's own gate-pass-then-sync flow, which needs a working check for Azure-DevOps-backed instances too, following the exact same resolve-then-gate pattern every other single-instance route uses.
        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            sendJSON(res, 200, await checkGate(slug, { azureDevOps, definitionsDir, gate }))
          })
          return
        }

        sendJSON(res, 200, checkGate(slug, { instancesDir, definitionsDir, gate }))
        return
      }

      // Links an instance to an Azure DevOps parent work item, auto-creating one child work item per stage in its definition underneath it (#95/#103). `organization`/`project` name where the *work item* lives — independent of, and not required to match, wherever this instance's own module data is stored (local or a different Azure DevOps repo entirely). `workItemType` is optional, defaulting to `DEFAULT_WORK_ITEM_TYPE` ("Task") — the configurable-with-a-sensible-default acceptance criterion. Requires the caller's own PAT (Work Items scope), via the same credential-provider seam as every other Azure-DevOps-backed route; if this instance's own data also happens to be Azure-DevOps-backed, the same PAT is reused for both calls rather than asking twice.
      if (url.pathname === '/api/instance/work-items/link' && req.method === 'POST') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
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

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        const instanceOptions = azureDevOpsLocation
          ? { azureDevOps: { ...azureDevOpsLocation, pat } }
          : { instancesDir }

        try {
          const workItem = await linkInstanceToWorkItem(
            slug,
            { organization, project, parentId: Number(parentId), workItemType, pat, baseUrl: workItemBaseUrl },
            { ...instanceOptions, definitionsDir }
          )
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

      // The confirmed half of #95/#103's read-write sync: re-checks the gate server-side (never trusting an earlier client-side check — the same instance the confirmation dialog checked a moment earlier may since have changed) and, only if it genuinely passes, pushes a new state to that stage's linked work item. The confirmation itself already happened client-side before this request was ever sent — declining it means this route is simply never called, leaving the work item's state genuinely untouched.
      if (url.pathname === '/api/instance/work-items/sync' && req.method === 'POST') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
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

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        const instanceOptions = azureDevOpsLocation
          ? { azureDevOps: { ...azureDevOpsLocation, pat } }
          : { instancesDir }

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
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          sendJSON(res, 400, {
            error:
              `Instance "${slug}" is Workspace-backed — it advances to its next stage only once that stage's ` +
              'own Pull Request is merged, not through this self-serve action.',
          })
          return
        }

        try {
          const result = advanceStage(slug, { instancesDir, definitionsDir })
          sendJSON(res, 200, result)
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
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        sendJSON(res, 200, { workspaceId: resolveInstanceWorkspaceId(slug, { instancesDir }) })
        return
      }

      if (url.pathname === '/api/instance' && req.method === 'GET') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const instance = await readInstance(slug, { azureDevOps })
            const definition = loadDefinition(instance.definition, { definitionsDir })
            const stageId = url.searchParams.get('stage') ?? instance.stage
            const stage = definition.stages.find((s) => s.id === stageId)
            if (!stage) {
              throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
            }

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
                if (stage.example && existsSync(join(instancesDir, stage.example, 'modules', `${moduleId}.md`))) {
                  exampleData = readModule(definition, stage.example, moduleId, { instancesDir })
                }
                return buildModuleEntry(definition, stage, moduleId, data, exampleData)
              })
            )

            sendJSON(res, 200, buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, true))
          })
          return
        }

        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        const stageId = url.searchParams.get('stage') ?? instance.stage
        const stage = definition.stages.find((s) => s.id === stageId)
        if (!stage) {
          throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
        }

        const modules = stage.modules.map((moduleId) => {
          let data = { status: 'draft', owner: '', fields: {} }
          if (existsSync(join(instancesDir, slug, 'modules', `${moduleId}.md`))) {
            data = readModule(definition, slug, moduleId, { instancesDir })
          }
          // The "Populate example text" button's source — a curated example instance declared per-stage in the definition, not fabricated placeholder text.
          let exampleData = null
          if (stage.example && existsSync(join(instancesDir, stage.example, 'modules', `${moduleId}.md`))) {
            exampleData = readModule(definition, stage.example, moduleId, { instancesDir })
          }
          return buildModuleEntry(definition, stage, moduleId, data, exampleData)
        })

        sendJSON(res, 200, buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, false))
        return
      }

      // Updates the instance record's own stored `assignee` (#97) — the instance detail UI's edit affordance for it. Distinct from `PUT /api/instance/modules/:id` below, which writes a *module's* own frontmatter `owner`/`status` (the separate Design Authority sign-off convention, untouched by #97). Resolves local vs. Azure-DevOps-backed the same way every other single-instance route does — per-request, via the shared instance registry.
      if (url.pathname === '/api/instance/assignee' && req.method === 'PUT') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const body = JSON.parse(await readBody(req))
        const assignee = typeof body?.assignee === 'string' ? body.assignee : ''

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const instance = await updateInstanceAssignee(slug, assignee, { azureDevOps })
            sendJSON(res, 200, { slug, assignee: instance.assignee })
          })
          return
        }

        const instance = updateInstanceAssignee(slug, assignee, { instancesDir })
        sendJSON(res, 200, { slug, assignee: instance.assignee })
        return
      }

      const moduleMatch = url.pathname.match(/^\/api\/instance\/modules\/([^/]+)$/)
      if (moduleMatch && req.method === 'PUT') {
        const moduleId = moduleMatch[1]
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const instance = await readInstance(slug, { azureDevOps })
            const definition = loadDefinition(instance.definition, { definitionsDir })
            const body = JSON.parse(await readBody(req))
            await writeModule(definition, slug, moduleId, body, { azureDevOps })
            // Report completeness for whichever stage the form is currently browsing, not always the instance's persisted stage — otherwise saving a module that belongs to a non-current stage reports against a status that doesn't include that module at all.
            const stageId = url.searchParams.get('stage') ?? instance.stage
            sendJSON(res, 200, await getStatus(slug, { azureDevOps, definitionsDir, stageId }))
          })
          return
        }

        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        const body = JSON.parse(await readBody(req))
        writeModule(definition, slug, moduleId, body, { instancesDir })
        // Report completeness for whichever stage the form is currently browsing, not always the instance's persisted stage — otherwise saving a module that belongs to a non-current stage reports against a status that doesn't include that module at all.
        const stageId = url.searchParams.get('stage') ?? instance.stage
        sendJSON(res, 200, getStatus(slug, { instancesDir, definitionsDir, stageId }))
        return
      }

      const renderMatch = url.pathname.match(/^\/api\/instance\/render\/([^/]+)$/)
      if (renderMatch && req.method === 'POST') {
        const artefactId = renderMatch[1]
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

        const azureDevOpsLocation = resolveAzureDevOpsLocation(slug, instancesDir)
        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const result = await renderArtefact(slug, artefactId, { azureDevOps, instancesDir, definitionsDir })
            // `azureDevOpsPath` (not `docxPath`, a scratch path on whichever machine `gantry serve` happens to run on) is what the browser should report back — the rendered artefact now lives in the same Azure DevOps repo as the rest of this instance's data.
            sendJSON(res, 200, { artefact: artefactId, azureDevOpsPath: result.azureDevOpsPath })
          })
          return
        }

        const result = renderArtefact(slug, artefactId, { instancesDir, definitionsDir })
        // Absolute, not relative to whatever directory `gantry serve` happened to be launched from — the browser has no way to know that directory.
        sendJSON(res, 200, { artefact: artefactId, docxPath: resolve(result.docxPath) })
        return
      }

      if (url.pathname === '/api/instance/assets' && req.method === 'GET') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        sendJSON(res, 200, listAssets(definition, slug, { instancesDir }))
        return
      }

      if (url.pathname === '/api/instance/assets' && req.method === 'POST') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
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
            { instancesDir }
          )
          sendJSON(res, 201, asset)
        } catch (err) {
          sendJSON(res, 400, { error: err.message })
        }
        return
      }

      const assetFileMatch = url.pathname.match(/^\/api\/instance\/assets\/([^/]+)\/file$/)
      if (assetFileMatch && req.method === 'GET') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }
        try {
          const { path } = getAsset(slug, assetFileMatch[1], { instancesDir })
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

      // preact-iso's client-side routes (e.g. /instance/<slug>, the module editor per instance; /setup, the instance-setup wizard, #78) have no corresponding file under web/ — a fresh navigation or reload at one of those URLs must still get the app shell so the router can take over, exactly as / does. Every real static asset this app serves (app.js, style.css, prototypes/*.html, etc.) has a file extension; a client route path never does, so that's what distinguishes the two here.
      const relativePath = url.pathname.slice(1)
      if (extname(relativePath) === '' && !existsSync(join(webDir, relativePath))) {
        serveIndexHtml(res)
        return
      }

      serveStaticFile(res, webDir, relativePath)
    } catch (err) {
      sendJSON(res, 500, { error: err.message })
    }
  })
}
