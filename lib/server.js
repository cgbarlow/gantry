import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { loadDefinition } from './definition.js'
import { readInstance, readModule, writeModule } from './instance.js'
import { getStatus } from './status.js'
import { renderArtefact } from './render.js'
import { buildImportMap } from './importmap.js'
import { listRegistry } from './registry.js'
import { createAsset, getAsset, listAssets } from './assets.js'

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
 */
export function createServer(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const webDir = options.webDir ?? 'web'
  const nodeModulesDir = options.nodeModulesDir ?? 'node_modules'
  const defaultSlug = options.slug

  const importMap = buildImportMap(FRONT_END_SPECIFIERS, { nodeModulesDir })

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = readFileSync(join(webDir, 'index.html'), 'utf8').replace(
          '"__IMPORT_MAP__"',
          JSON.stringify(importMap)
        )
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }

      if (url.pathname.startsWith('/node_modules/')) {
        serveStaticFile(res, nodeModulesDir, url.pathname.slice('/node_modules/'.length))
        return
      }

      if (url.pathname === '/api/instances' && req.method === 'GET') {
        sendJSON(res, 200, listRegistry({ instancesDir, definitionsDir }))
        return
      }

      if (url.pathname === '/api/instance' && req.method === 'GET') {
        const { slug, error } = resolveSlugParam(url, defaultSlug)
        if (error) {
          sendJSON(res, 400, { error })
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
          const moduleSpec = definition.modules.get(moduleId)
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
        })

        sendJSON(res, 200, {
          slug,
          definition: definition.id,
          stage: { id: stage.id, title: stage.title, gate: stage.gate },
          // The instance's actual persisted stage — distinct from `stage`
          // above once the form is browsing a different stage's modules.
          currentStageId: instance.stage,
          hasExample: Boolean(stage.example),
          stages: definition.stages.map((s) => ({ id: s.id, title: s.title, gate: s.gate })),
          // Only offer artefacts for the viewed stage's own gate, and only
          // once their template actually exists — the design definition
          // declares hld/sad/ssad/as-built ahead of their templates being
          // written.
          artefacts: definition.artefacts
            .filter((a) => a.gate === stage.gate)
            .filter((a) => existsSync(join(definitionsDir, instance.definition, a.template)))
            .map((a) => ({ id: a.id, title: a.title })),
          modules,
        })
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

      serveStaticFile(res, webDir, url.pathname.slice(1))
    } catch (err) {
      sendJSON(res, 500, { error: err.message })
    }
  })
}
