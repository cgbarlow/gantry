import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { loadDefinition, listDefinitions } from './definition.js'
import { readInstance, readModule, writeModule, createInstance } from './instance.js'
import { getStatus } from './status.js'
import { checkGate } from './check.js'
import { renderArtefact } from './render.js'
import { buildImportMap } from './importmap.js'
import { listRegistry } from './registry.js'
import { createAsset, getAsset, listAssets } from './assets.js'
import { getCredential } from './credential.js'
import { AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'
import { checkAzureDevOpsRepo } from './repoCheck.js'

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

// The bare specifiers the web form imports directly; buildImportMap walks
// their `dependencies` to resolve the rest of the tree.
//
// 'preact/hooks' and 'htm/preact' are subpath specifiers, not separate npm
// packages — both ship their own nested package.json (preact/hooks/,
// htm/preact/) precisely so tools like buildImportMap (which resolves each
// specifier as a directory under node_modules) can address them directly,
// per docs/adr/0006-preact-frontend-framework.md.
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

// A slug must name a direct child of `instancesDir` — never a path
// traversal token. This matters once `slug` can arrive from request input
// (the `?slug=` query param) rather than only a trusted CLI argument at
// server startup: without this check, a slug like `../../etc` would flow
// straight into `join(instancesDir, slug, ...)` inside readInstance/
// readModule/writeModule/renderArtefact, reading or writing files outside
// instancesDir entirely.
const SINGLE_SEGMENT_RE = /^[^\\/]+$/

function isValidSlug(slug) {
  return typeof slug === 'string' && slug !== '' && slug !== '.' && slug !== '..' && SINGLE_SEGMENT_RE.test(slug)
}

// Resolves the slug for a single-instance route: the `?slug=` query param,
// falling back to the server's default slug (`options.slug`) when absent.
// Returns `{ error }` (never throws) when no slug is available or the slug
// given fails the single-path-segment check above, so callers can respond
// with a 400 instead of letting an invalid value reach the filesystem.
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

// The structured "authentication required" response (#82's spec, built out
// here per #86): returned identically whether the request carried no PAT
// at all, or one Azure DevOps itself rejected — callers (the frontend, #87)
// never have to distinguish the two to know to (re-)prompt for a PAT. Never
// includes the credential itself, or anything read off it.
function sendAuthenticationRequired(res) {
  sendJSON(res, 401, {
    error: 'authentication_required',
    message:
      'A valid Azure DevOps Personal Access Token is required for this instance. ' +
      'Provide it via HTTP Basic auth (empty username, PAT as password).',
  })
}

// Gates an Azure-DevOps-backed instance-data route behind the credential-
// provider seam (lib/credential.js): with no PAT on the request, responds
// with the structured "authentication required" response and never calls
// `fn` at all; with one, calls `fn({ ...azureDevOpsLocation, pat })` and —
// if Azure DevOps itself rejects that PAT (`AzureDevOpsAuthenticationError`,
// surfaced from lib/instance.js/lib/status.js/lib/render.js's Azure-DevOps-
// backed paths) — responds with that exact same structured response rather
// than letting it fall through as a generic error. Any other error `fn`
// throws propagates to the server's own top-level catch (a 500), unchanged.
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

// The single module-entry shape `GET /api/instance` returns, built from
// already-fetched module/example data — shared by the local and Azure-
// DevOps-backed branches of that route so they can never drift in what
// they hand the module editor, only in how `data`/`exampleData` were read.
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

// The `GET /api/instance` response shape, built from an already-loaded
// definition/stage/instance and the per-module entries above — shared by
// the local and Azure-DevOps-backed branches of that route for the same
// reason `buildModuleEntry` is.
function buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules) {
  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    // The instance's actual persisted stage — distinct from `stage` above
    // once the form is browsing a different stage's modules.
    currentStageId: instance.stage,
    hasExample: Boolean(stage.example),
    stages: definition.stages.map((s) => ({ id: s.id, title: s.title, gate: s.gate })),
    // Only offer artefacts for the viewed stage's own gate, and only once
    // their template actually exists — the design definition declares
    // hld/sad/ssad/as-built ahead of their templates being written.
    artefacts: definition.artefacts
      .filter((a) => a.gate === stage.gate)
      .filter((a) => existsSync(join(definitionsDir, instance.definition, a.template)))
      .map((a) => ({ id: a.id, title: a.title })),
    modules,
  }
}

/**
 * `gantry serve [slug]`: a static-file + minimal JSON API server behind
 * the vanilla-JS/ESM web form. Serves `web/`, serves `node_modules/` (so
 * the browser can `import` CodeMirror 6 / markdown-it / DOMPurify via a
 * generated import map, with no bundler), and reads/writes the identical
 * instance module files the CLI path does — no second store.
 *
 * `options.slug` is an optional default, not a requirement: `GET
 * /api/instances` lists every instance regardless, and the single-instance
 * routes below resolve their slug per-request (`?slug=<slug>`, falling back
 * to `options.slug` when the query param is absent) — so a server can be
 * started with no slug at all and still serve instance data, once the
 * caller supplies one per request.
 *
 * `options.azureDevOps` (`{ organization, project, repository, baseUrl? }`
 * — a *location*, never a credential) marks this server's single-instance
 * routes (`GET /api/instance`, `PUT /api/instance/modules/:id`, `POST
 * /api/instance/render/:artefact`, per #86) as Azure-DevOps-backed: each
 * such request is gated behind the credential-provider seam
 * (lib/credential.js's `getCredential(req)`), extracting the caller's own
 * Azure DevOps PAT from its Authorization header and passing it — never
 * stored beyond that one request — into lib/instance.js/lib/status.js/
 * lib/render.js's Azure-DevOps-backed paths (#85) alongside this location.
 * A request with no PAT, or one Azure DevOps itself rejects, gets the same
 * structured "authentication required" response either way. Without
 * `options.azureDevOps` — every existing caller, and the three local
 * instances (`examples`, `demo-cli`, `demo-web`) — these routes are
 * completely unaffected: no credential is ever required or even looked
 * for. The multi-instance registry routes (`GET`/`POST /api/instances`)
 * always operate on the local `instancesDir`, in both modes — an Azure-
 * DevOps-backed server serves exactly one instance, the same way a local
 * server pinned to `options.slug` does.
 *
 * `options.allowedAzureDevOpsBaseUrls` (default `[]`, an exact-match allow-
 * list — never a blanket on/off switch) gates whether `GET
 * /api/azure-devops/repo-check` (#90) — the one route whose Azure DevOps
 * *location* is entirely caller-supplied per-request, not fixed at server
 * startup — will honour a caller-supplied `?baseUrl=`. Left empty (the
 * default, and what `gantry serve` uses), every request to that route talks
 * to the real `https://dev.azure.com` regardless of what `baseUrl` a caller
 * asks for, so a request can never direct this server to make an outbound
 * HTTP call to a host of the caller's choosing (an SSRF vector
 * `organization`/`project`/`repository` don't share, since those only ever
 * become path segments under whichever host is actually used). A real on-
 * premises-Azure-DevOps-Server deployment that needs callers to be able to
 * name that server explicitly lists its exact base URL(s) here — this
 * deliberately isn't a single boolean "trust callers with any host" flag:
 * enabling support for one specific, known on-prem location must not also
 * reopen the door to an arbitrary caller-chosen one.
 */
export function createServer(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const webDir = options.webDir ?? 'web'
  const nodeModulesDir = options.nodeModulesDir ?? 'node_modules'
  const defaultSlug = options.slug
  const azureDevOpsLocation = options.azureDevOps
  // `Array.isArray` (not `?? []`) so a plausible misconfiguration — passing
  // a bare string instead of a single-element array — can't silently
  // degrade the exact-match allow-list check below into a *substring*
  // check (`String.prototype.includes` rather than `Array.prototype.includes`).
  // Anything other than a real array falls back to the same empty,
  // fail-closed default as leaving the option off entirely.
  const allowedAzureDevOpsBaseUrls = Array.isArray(options.allowedAzureDevOpsBaseUrls)
    ? options.allowedAzureDevOpsBaseUrls
    : []

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

      if (url.pathname === '/api/instances' && req.method === 'GET') {
        sendJSON(res, 200, listRegistry({ instancesDir, definitionsDir }))
        return
      }

      // Registers a new instance — the instance-setup wizard's (#78) "empty
      // repo" path. `slug` goes through the same single-path-segment check
      // as every other slug arriving from request input (see isValidSlug's
      // own comment). `definition` gets an equivalent guard of its own: it
      // must exactly match one of `listDefinitions()`'s real, known ids —
      // never passed through to `createInstance`/`loadDefinition` unchecked.
      // Without this, `definition` (unlike `slug`) had no path-traversal
      // guard at all: `loadDefinition` resolves it as `join(definitionsDir,
      // definitionId)`, so a value like `../../../../tmp/evil` would read
      // (and, paired with a crafted `definition.yaml` whose own `id` field
      // echoes the same traversal string back, fully register an instance
      // against) an arbitrary directory outside `definitionsDir` — the same
      // class of bug `isValidSlug` exists to prevent for `slug`, just not
      // yet applied to this second request-controlled input.
      // `createInstance` itself still rejects a slug that already has an
      // instance on disk, reported as 409 rather than the 500 the outer
      // catch would otherwise give.
      if (url.pathname === '/api/instances' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const { definition: definitionId, slug, owner } = body ?? {}
        if (!isValidSlug(slug)) {
          sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
          return
        }
        const knownDefinitionIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
        if (!knownDefinitionIds.has(definitionId)) {
          sendJSON(res, 400, { error: `Unknown definition "${definitionId}"` })
          return
        }
        try {
          createInstance(definitionId, slug, { instancesDir, definitionsDir, owner })
        } catch (err) {
          const status = /already exists/.test(err.message) ? 409 : 400
          sendJSON(res, status, { error: err.message })
          return
        }
        const created = listRegistry({ instancesDir, definitionsDir }).find((i) => i.slug === slug)
        sendJSON(res, 201, created)
        return
      }

      // The instance-setup wizard's (#78) "live repo check" — given an
      // Azure DevOps location (never a gantry slug: this is answering
      // "what's in this specific remote repo", not "is this already known
      // to gantry", so it deliberately never touches instancesDir or
      // lib/registry.js, #89) and the caller's own PAT, reports whether
      // that location already holds instance data (#90, under #88).
      // Read-only, no side effects. Gated behind the same credential-
      // provider seam (#86) as the single-instance Azure-DevOps-backed
      // routes below — a missing PAT, or one Azure DevOps itself rejects,
      // gets the identical structured "authentication required" response.
      if (url.pathname === '/api/azure-devops/repo-check' && req.method === 'GET') {
        const organization = url.searchParams.get('organization')
        const project = url.searchParams.get('project')
        const repository = url.searchParams.get('repository')
        const missing = ['organization', 'project', 'repository'].filter((name) => !url.searchParams.get(name))
        if (missing.length > 0) {
          sendJSON(res, 400, { error: `Missing required query parameter(s): ${missing.join(', ')}` })
          return
        }

        // `|| undefined` (not `?? undefined`) so an explicit-but-empty
        // `?baseUrl=` is treated the same as an absent one, rather than
        // being passed through as `''` and bypassing createAzureDevOpsClient's
        // own `= DEFAULT_BASE_URL` default parameter (which only applies to
        // `undefined`).
        const requestedBaseUrl = url.searchParams.get('baseUrl') || undefined
        if (requestedBaseUrl && !allowedAzureDevOpsBaseUrls.includes(requestedBaseUrl)) {
          // Unlike `organization`/`project`/`repository` (which only ever
          // become path segments under whatever host is used), `baseUrl`
          // picks the outbound request's actual network destination. With
          // no matching entry in the server's own `allowedAzureDevOpsBaseUrls`
          // allow-list, honouring an arbitrary caller-supplied `baseUrl`
          // here would let any request direct this server to make outbound
          // HTTP calls to a host of the caller's own choosing (internal
          // services included) — an SSRF vector unique to this route, since
          // every other Azure-DevOps-backed route only ever uses a
          // `baseUrl` the server operator fixed at startup. Rejected
          // outright rather than silently ignored: silently checking the
          // real dev.azure.com instead would misreport an on-premises
          // caller's own location as empty/unreachable rather than telling
          // them the check they asked for wasn't the one that ran.
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

      // The dashboard's (#77) stage-swimlane view needs a definition's full
      // stage list (id/title/gate, in order) to lay out lanes — including
      // empty ones — before any instance of that definition necessarily
      // exists to read it off of. A thin projection of `loadDefinition`,
      // not a general definitions API.
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
        // Mirrors `gantry check <slug> [--gate <id>]` — the dashboard's
        // (#77) "Check" action, run against the instance's current stage
        // unless a specific gate is requested.
        const gate = url.searchParams.get('gate') ?? undefined
        sendJSON(res, 200, checkGate(slug, { instancesDir, definitionsDir, gate }))
        return
      }

      if (url.pathname === '/api/instance' && req.method === 'GET') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
          return
        }

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
                  // Only readModule's own "no saved data yet" miss (its
                  // Azure-DevOps-backed twin's stand-in for the local
                  // branch's existsSync-guarded skip below) defaults to the
                  // blank draft above — a genuine failure (a network error,
                  // an Azure DevOps outage, malformed module content, etc.)
                  // must propagate as a real error instead of silently
                  // rendering as an empty module.
                  if (!/has no saved data/.test(err.message)) throw err
                }
                // The "Populate example text" button's source — a curated example
                // instance declared per-stage in the definition, always read from
                // the local instancesDir: it's a shared fixture, not this Azure-
                // DevOps-backed instance's own data.
                let exampleData = null
                if (stage.example && existsSync(join(instancesDir, stage.example, 'modules', `${moduleId}.md`))) {
                  exampleData = readModule(definition, stage.example, moduleId, { instancesDir })
                }
                return buildModuleEntry(definition, stage, moduleId, data, exampleData)
              })
            )

            sendJSON(res, 200, buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules))
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
          // The "Populate example text" button's source — a curated example
          // instance declared per-stage in the definition, not fabricated
          // placeholder text.
          let exampleData = null
          if (stage.example && existsSync(join(instancesDir, stage.example, 'modules', `${moduleId}.md`))) {
            exampleData = readModule(definition, stage.example, moduleId, { instancesDir })
          }
          return buildModuleEntry(definition, stage, moduleId, data, exampleData)
        })

        sendJSON(res, 200, buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules))
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

        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const instance = await readInstance(slug, { azureDevOps })
            const definition = loadDefinition(instance.definition, { definitionsDir })
            const body = JSON.parse(await readBody(req))
            await writeModule(definition, slug, moduleId, body, { azureDevOps })
            // Report completeness for whichever stage the form is currently
            // browsing, not always the instance's persisted stage — otherwise
            // saving a module that belongs to a non-current stage reports
            // against a status that doesn't include that module at all.
            const stageId = url.searchParams.get('stage') ?? instance.stage
            sendJSON(res, 200, await getStatus(slug, { azureDevOps, definitionsDir, stageId }))
          })
          return
        }

        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        const body = JSON.parse(await readBody(req))
        writeModule(definition, slug, moduleId, body, { instancesDir })
        // Report completeness for whichever stage the form is currently
        // browsing, not always the instance's persisted stage — otherwise
        // saving a module that belongs to a non-current stage reports
        // against a status that doesn't include that module at all.
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

        if (azureDevOpsLocation) {
          await withAzureDevOpsCredential(req, res, azureDevOpsLocation, async (azureDevOps) => {
            const result = await renderArtefact(slug, artefactId, { azureDevOps, instancesDir, definitionsDir })
            // Absolute, not relative to whatever directory `gantry serve` happened
            // to be launched from — the browser has no way to know that directory.
            sendJSON(res, 200, { artefact: artefactId, docxPath: resolve(result.docxPath) })
          })
          return
        }

        const result = renderArtefact(slug, artefactId, { instancesDir, definitionsDir })
        // Absolute, not relative to whatever directory `gantry serve` happened
        // to be launched from — the browser has no way to know that directory.
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

      // preact-iso's client-side routes (e.g. /instance/<slug>, the module
      // editor per instance; /setup, the instance-setup wizard, #78) have no
      // corresponding file under web/ — a fresh navigation or reload at one
      // of those URLs must still get the app shell so the router can take
      // over, exactly as / does. Every real static asset this app serves
      // (app.js, style.css, prototypes/*.html, etc.) has a file extension; a
      // client route path never does, so that's what distinguishes the two
      // here.
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
