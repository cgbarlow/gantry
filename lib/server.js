import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { loadDefinition } from './definition.js'
import { readInstance, readModule, writeModule } from './instance.js'
import { getStatus } from './status.js'
import { renderArtefact } from './render.js'
import { buildImportMap } from './importmap.js'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

// The bare specifiers the web form imports directly; buildImportMap walks
// their `dependencies` to resolve the rest of the tree.
const FRONT_END_SPECIFIERS = ['codemirror', '@codemirror/state', '@codemirror/lang-markdown', 'markdown-it', 'dompurify']

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

function fieldValue(field, data) {
  const raw = data.fields[field.id]
  if (raw !== undefined) return raw
  return field.type === 'list' ? [] : ''
}

/**
 * `gantry serve <slug>`: a static-file + minimal JSON API server behind
 * the vanilla-JS/ESM web form. Serves `web/`, serves `node_modules/` (so
 * the browser can `import` CodeMirror 6 / markdown-it / DOMPurify via a
 * generated import map, with no bundler), and reads/writes the identical
 * instance module files the CLI path does — no second store.
 */
export function createServer(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const webDir = options.webDir ?? 'web'
  const nodeModulesDir = options.nodeModulesDir ?? 'node_modules'
  const slug = options.slug

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

      if (url.pathname === '/api/instance' && req.method === 'GET') {
        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        const stage = definition.stages.find((s) => s.id === instance.stage)
        if (!stage) {
          throw new Error(`Instance "${slug}" is at unknown stage "${instance.stage}"`)
        }

        const modules = stage.modules.map((moduleId) => {
          const moduleSpec = definition.modules.get(moduleId)
          let data = { status: 'draft', owner: '', fields: {} }
          if (existsSync(join(instancesDir, slug, 'modules', `${moduleId}.md`))) {
            data = readModule(definition, slug, moduleId, { instancesDir })
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
            })),
          }
        })

        sendJSON(res, 200, {
          slug,
          definition: definition.id,
          stage: { id: stage.id, title: stage.title, gate: stage.gate },
          // Only offer artefacts whose template actually exists — the design
          // definition declares hld/sad/ssad/as-built ahead of their templates
          // being written.
          artefacts: definition.artefacts
            .filter((a) => existsSync(join(definitionsDir, instance.definition, a.template)))
            .map((a) => ({ id: a.id, title: a.title })),
          modules,
        })
        return
      }

      const moduleMatch = url.pathname.match(/^\/api\/instance\/modules\/([^/]+)$/)
      if (moduleMatch && req.method === 'PUT') {
        const moduleId = moduleMatch[1]
        const instance = readInstance(slug, { instancesDir })
        const definition = loadDefinition(instance.definition, { definitionsDir })
        const body = JSON.parse(await readBody(req))
        writeModule(definition, slug, moduleId, body, { instancesDir })
        sendJSON(res, 200, getStatus(slug, { instancesDir, definitionsDir }))
        return
      }

      const renderMatch = url.pathname.match(/^\/api\/instance\/render\/([^/]+)$/)
      if (renderMatch && req.method === 'POST') {
        const artefactId = renderMatch[1]
        const result = renderArtefact(slug, artefactId, { instancesDir, definitionsDir })
        // Absolute, not relative to whatever directory `gantry serve` happened
        // to be launched from — the browser has no way to know that directory.
        sendJSON(res, 200, { artefact: artefactId, docxPath: resolve(result.docxPath) })
        return
      }

      serveStaticFile(res, webDir, url.pathname.slice(1))
    } catch (err) {
      sendJSON(res, 500, { error: err.message })
    }
  })
}
