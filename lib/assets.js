import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join, resolve } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { readModule } from './instance.js'

// Assets live in their own `assets/` directory inside an instance, alongside — not nested inside — `modules/` (per #74's "Asset storage" decision and docs/adr/0005-instance-data-in-external-ado-repo.md's shape for instance data). A single `manifest.yaml` inside that directory is the source of truth for an asset's metadata (id, stored filename, display name, the mandatory source-location reference, uploader); the image bytes themselves sit alongside it as `<id><ext>`.
//
// WI260 repo-as-asset-store: for a workspace-backed (Azure DevOps) instance the same directory lives as `gantry-workspace/<slug>/assets/<name>` in the Azure DevOps repo — sibling of `modules/` and `out/`, committed as regular files (no manifest). See lib/instance.js's azureDevOpsAssetsDir() and README's Repository layout.
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

// WI260 repo-as-asset-store: the relative-path convention for workspace-backed assets — a normal markdown image whose URL is a repo-relative path `../assets/<name>` or `assets/<name>` (sibling of `modules/`). Mirrors ASSET_REF_RE above but for committed repo files rather than `asset:<id>`. Keep in sync with web/lib/assetRefs.js's REPO_ASSET_REF_RE.
export const REPO_ASSET_REF_RE = /!\[([^\]]*)\]\((?:\.\.\/)?assets\/([^)\s"']+)\)/g

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
 * WI #348: an asset whose manifest `source` is not an http(s) URL is a *local* source — the copy of the image stored within the instance itself (`assets/<filename>`), the convention the bundled `examples` fixture uses so a zip-release install has no dead links. Its citation links to that local copy, resolved relative to where the rendered document lands (`<instance>/out/`), so `../assets/<filename>` opens the file next to the .docx. UI uploads still require an http(s) source (createAsset below) — this path is only reachable from a hand-written manifest.
 */
export function isLocalAssetSource(source) {
  return typeof source === 'string' && source.trim() !== '' && !/^https?:\/\//i.test(source.trim())
}

/**
 * The citation a source resolves to: `{ label, href }`. Remote sources cite themselves; local sources (see isLocalAssetSource) cite the stored copy relative to the render output directory.
 */
export function assetCitation(asset) {
  if (!asset.source) return null
  if (isLocalAssetSource(asset.source)) {
    return { label: `assets/${asset.filename}`, href: `../assets/${asset.filename}` }
  }
  return { label: asset.source, href: asset.source }
}

function citationMarkdown({ label, href }) {
  return `*Source: [${label.replaceAll(']', '\\]')}](<${href}>)*`
}

/**
 * Rewrites every `![alt](asset:<id>)` reference in `markdown` to `![alt](<absolute path to the asset's stored file>)`, so a renderer that reads local files (the Pandoc compile step, #81) sees an ordinary, resolvable image path in place of the portable `asset:<id>` placeholder — at the exact same position the reference appears in the source, so the embedded image lands in the same paragraph the author put it in. Mirrors web/lib/assetRefs.js's resolveAssetRefs(), which does the same rewrite for the browser's live preview but resolves to a fetchable URL instead of a filesystem path. Throws if a referenced asset id has no manifest entry, the same way getAsset() does.
 * When the asset carries a `source`, also emits a caption-styled citation immediately below the image — `*Source: [<label>](<<href>>)*` — as an italic paragraph Pandoc preserves into the .docx (see assetCitation for what a local vs remote source cites). No citation is emitted for assets lacking a source.
 */
export function resolveAssetFileRefs(markdown, slug, options = {}) {
  return markdown.replace(ASSET_REF_RE, (match, assetId) => {
    const { asset, path } = getAsset(slug, assetId, options)
    const base = match.replace(`asset:${assetId}`, resolve(path))
    const citation = assetCitation(asset)
    if (!citation) return base
    return `${base}\n\n${citationMarkdown(citation)}`
  })
}

/**
 * WI260 repo-as-asset-store: rewrites every `![alt](../assets/<name>)` or `![alt](assets/<name>)` reference in `markdown` to `![alt](<absolute local path>)`, so Pandoc (lib/render.js) and any file-reader sees a resolvable image path. `assets/` is the instance's asset dir sibling of `modules/` (lib/instance.js's azureDevOpsAssetsDir for the repo form, `join(instancesDir, slug, 'assets')` for the local scratch copy). Mirrors web/lib/assetRefs.js's resolveRepoAssetRefs(), which rewrites to a fetchable URL for the browser preview.
 *
 * `options.citationUrl` (#16): when supplied, `citationUrl(filename)` builds the file's own permanent
 * web address — a GitHub-backed instance's repo-asset has no separate `source` metadata to cite (unlike
 * the `asset:<id>` manifest convention above), so its citation is the committed file's own location,
 * derived rather than authored. Emits the same `*Source: [<label>](<<href>>)*` caption as
 * `resolveAssetFileRefs` above. Azure DevOps repo-assets pass no `citationUrl` and keep emitting no
 * citation, unchanged.
 */
export function resolveRepoAssetFileRefs(markdown, slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  return markdown.replace(REPO_ASSET_REF_RE, (match, alt, filename) => {
    const assetPath = join(instancesDir, slug, 'assets', filename)
    const abs = resolve(assetPath)
    const base = `![${alt}](${abs})`
    if (!options.citationUrl) return base
    const href = options.citationUrl(filename)
    if (!href) return base
    return `${base}\n\n${citationMarkdown({ label: `assets/${filename}`, href })}`
  })
}

export const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

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
