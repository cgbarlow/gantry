import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join, resolve } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { readModule } from './instance.js'

// Assets live in their own `assets/` directory inside an instance, alongside — not nested inside — `modules/` (per #74's "Asset storage" decision and docs/adr/0005-instance-data-in-external-ado-repo.md's shape for instance data). A single `manifest.yaml` inside that directory is the source of truth for an asset's metadata (id, stored filename, display name, the mandatory source-location reference, uploader); the image bytes themselves sit alongside it as `<id><ext>`.
function assetsDir(instancesDir, slug) {
  return join(instancesDir, slug, 'assets')
}

function manifestPath(instancesDir, slug) {
  return join(assetsDir(instancesDir, slug), 'manifest.yaml')
}

function readManifest(instancesDir, slug) {
  const path = manifestPath(instancesDir, slug)
  if (!existsSync(path)) return []
  return parseYAML(readFileSync(path, 'utf8')) ?? []
}

function writeManifest(instancesDir, slug, assets) {
  writeFileSync(manifestPath(instancesDir, slug), stringifyYAML(assets))
}

// The hand-typeable markdown convention for referencing an asset (#80's "Authors can also hand-type the same reference convention directly into markdown" acceptance criterion): a normal markdown image whose "URL" is `asset:<id>` rather than a real path. It's never fetched as a literal URL — every renderer (the editor's live preview in web/app.js, and the Pandoc compile step in the follow-on #81) resolves `asset:<id>` to the real file in this instance's `assets/` directory at render time, so the stored markdown source stays portable across servers/hosts.
//
// Keep this regex in sync with web/lib/assetRefs.js's client-side copy — same intentional duplication as web/lib/theme.js vs. web/index.html's bootstrap script (server-side code can't import a browser-facing module, and vice versa).
const ASSET_REF_RE = /!\[[^\]]*\]\(asset:([\w-]+)\)/g

/**
 * Every asset id referenced from any module's markdown fields, across every module the definition declares — not just the currently-viewed stage's modules — since an asset's "used in" reflects the whole instance. Returns a Map of assetId -> array of the distinct module titles that reference it (in definition order encountered).
 */
function computeUsage(definition, slug, instancesDir) {
  const usage = new Map()
  for (const [moduleId, moduleSpec] of definition.modules) {
    if (!existsSync(join(instancesDir, slug, 'modules', `${moduleId}.md`))) continue
    const data = readModule(definition, slug, moduleId, { instancesDir })
    for (const field of moduleSpec.fields) {
      const value = data.fields[field.id]
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(ASSET_REF_RE)) {
        const assetId = match[1]
        const titles = usage.get(assetId) ?? []
        if (!titles.includes(moduleSpec.title)) titles.push(moduleSpec.title)
        usage.set(assetId, titles)
      }
    }
  }
  return usage
}

/**
 * Every asset registered against `slug`, each enriched with `usedIn` (the distinct module titles referencing it via the `asset:<id>` convention) — the shape the asset library screen and the insert modal's "Choose existing" tab both need.
 */
export function listAssets(definition, slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const usage = computeUsage(definition, slug, instancesDir)
  return readManifest(instancesDir, slug).map((asset) => ({
    ...asset,
    usedIn: usage.get(asset.id) ?? [],
  }))
}

/** Resolves an asset id to its manifest entry and on-disk file path. */
export function getAsset(slug, assetId, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const asset = readManifest(instancesDir, slug).find((a) => a.id === assetId)
  if (!asset) {
    throw new Error(`No asset "${assetId}" for instance "${slug}"`)
  }
  return { asset, path: join(assetsDir(instancesDir, slug), asset.filename) }
}

/**
 * Rewrites every `![alt](asset:<id>)` reference in `markdown` to `![alt](<absolute path to the asset's stored file>)`, so a renderer that reads local files (the Pandoc compile step, #81) sees an ordinary, resolvable image path in place of the portable `asset:<id>` placeholder — at the exact same position the reference appears in the source, so the embedded image lands in the same paragraph the author put it in. Mirrors web/lib/assetRefs.js's resolveAssetRefs(), which does the same rewrite for the browser's live preview but resolves to a fetchable URL instead of a filesystem path. Throws if a referenced asset id has no manifest entry, the same way getAsset() does.
 * When the asset carries a `source` URL, also emits a caption-styled citation immediately below the image — `*Source: <source>*` — as an italic paragraph Pandoc preserves into the .docx. No citation is emitted for assets lacking a source.
 */
export function resolveAssetFileRefs(markdown, slug, options = {}) {
  return markdown.replace(ASSET_REF_RE, (match, assetId) => {
    const { asset, path } = getAsset(slug, assetId, options)
    const base = match.replace(`asset:${assetId}`, resolve(path))
    if (!asset.source) return base
    return `${base}\n\n*Source: ${asset.source}*`
  })
}

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

/**
 * Registers a new asset: writes its image bytes under the instance's `assets/` directory and appends its metadata to `manifest.yaml`. Throws (never writes anything) on the two mandatory-field failures the modal's "Upload new" tab must block on: a missing/blank source-location reference, or a missing/unsupported image file — this is the server-side half of that validation, defense-in-depth alongside the client's own inline check.
 *
 * @param {string} slug
 * @param {{ filename: string, buffer: Buffer, name?: string, source: string, uploadedBy?: string }} data
 */
export function createAsset(slug, data, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'

  const source = (data.source ?? '').trim()
  if (!source) {
    throw new Error('Source location is required — link to the originating file (e.g. a Draw.io diagram).')
  }
  let sourceUrl
  try {
    sourceUrl = new URL(source)
  } catch {
    throw new Error(`Source location must be a valid URL: "${source}"`)
  }
  if (!/^https?:$/.test(sourceUrl.protocol)) {
    throw new Error(`Source location must be an http(s) URL: "${source}"`)
  }

  if (!data.filename || !data.buffer || data.buffer.length === 0) {
    throw new Error('An image file is required.')
  }
  const ext = extname(data.filename).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image file type "${ext || '(none)'}" — expected .png, .jpg, or .jpeg.`)
  }

  const dir = assetsDir(instancesDir, slug)
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const filename = `${id}${ext}`
  writeFileSync(join(dir, filename), data.buffer)

  const asset = {
    id,
    filename,
    name: (data.name ?? '').trim() || data.filename,
    source,
    uploadedBy: (data.uploadedBy ?? '').trim(),
  }

  const manifest = readManifest(instancesDir, slug)
  manifest.push(asset)
  writeManifest(instancesDir, slug, manifest)

  return asset
}
