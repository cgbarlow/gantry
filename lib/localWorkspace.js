import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { isValidSlug } from './slug.js'
import { getStatus } from './status.js'
import { checkGate } from './check.js'
import { validateDefinition } from './validate.js'
import { renderArtefact } from './render.js'

/**
 * Server-side sandboxed harness for the stateless `/api/local/*` routes
 * (docs/adr/0029, WI #294). A browser holding a **local workspace**'s files on
 * the user's own machine can't run gantry's compute itself — it ships the file
 * contents here, this module unpacks them into a throwaway temp directory laid
 * out exactly like an on-disk instance (`gantry-workspace/<slug>/instance.yaml`
 * + `modules/<id>.md` + `assets/<id>`), runs the same `lib/` functions the CLI
 * uses against that temp dir (and the repo's own bundled `definitionsDir`), and
 * returns the result. The temp dir is always removed afterwards — on success and
 * on every error path.
 *
 * Nothing here consults a PAT or any server identity (a local workspace has
 * none), touches the instance registry, or writes anywhere durable. Definitions
 * are resolved only from the repo's bundled `definitions/` by `definitionId` +
 * `definitionVersion` — never from the caller's payload.
 *
 * This is distinct from the browser-side local-workspace module in the sibling
 * ticket; that one drives the File System Access API, this one is the compute.
 */

// Total decoded request body cap and per-collection count caps. The route
// enforces the body-size cap on the raw bytes before this module ever runs;
// the count caps are enforced here before anything is written to disk.
export const LOCAL_WORKSPACE_LIMITS = Object.freeze({
  maxBodyBytes: 10 * 1024 * 1024,
  maxModuleFiles: 200,
  maxAssets: 200,
})

// The `mkdtemp` prefix every request's sandbox directory is created under, in
// `os.tmpdir()`. Exported so tests can watch `os.tmpdir()` for leaked sandboxes.
export const LOCAL_WORKSPACE_TMP_PREFIX = 'gantry-local-'

const OPERATIONS = new Set(['status', 'check', 'validate', 'render', 'compile'])

/**
 * A caller-input problem — a bad or oversized payload — that the route should
 * turn into a 4xx with `message`, rather than a 500. `status` defaults to 400;
 * over-limit collections use 413.
 */
export class LocalWorkspaceRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'LocalWorkspaceRequestError'
    this.status = status
  }
}

function fail(message, status = 400) {
  throw new LocalWorkspaceRequestError(message, status)
}

// A plain, safe single filename: letters/digits/dot/dash/underscore only, and
// never a `..` traversal. Rejects `/`, `\`, absolute paths, empty, and `..`.
function isSafeFilename(name) {
  return typeof name === 'string' && name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..')
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
}

// Validates the whole payload shape and every filename in it BEFORE any temp
// directory is created or any byte is written. Returns the normalised pieces.
function validatePayload(operation, payload) {
  assertObject(payload, 'Request body')

  const definitionId = payload.definitionId
  if (typeof definitionId !== 'string' || definitionId.trim() === '') {
    fail('definitionId is required')
  }
  if (!isSafeFilename(definitionId)) {
    fail(`Invalid definitionId "${definitionId}"`)
  }

  let definitionVersion
  if (payload.definitionVersion !== undefined && payload.definitionVersion !== null) {
    definitionVersion = Number(payload.definitionVersion)
    if (!Number.isInteger(definitionVersion) || definitionVersion < 1) {
      fail(`Invalid definitionVersion "${payload.definitionVersion}"`)
    }
  }

  const moduleFiles = payload.moduleFiles ?? {}
  assertObject(moduleFiles, 'moduleFiles')
  const moduleIds = Object.keys(moduleFiles)
  if (moduleIds.length > LOCAL_WORKSPACE_LIMITS.maxModuleFiles) {
    fail(
      `Too many moduleFiles: ${moduleIds.length} (limit ${LOCAL_WORKSPACE_LIMITS.maxModuleFiles})`,
      413
    )
  }
  for (const id of moduleIds) {
    if (!isSafeFilename(id)) fail(`Unsafe moduleFiles key "${id}" — must be a plain filename`)
    if (typeof moduleFiles[id] !== 'string') fail(`moduleFiles["${id}"] must be a string`)
  }

  const assets = payload.assets ?? []
  if (!Array.isArray(assets)) fail('assets must be an array')
  if (assets.length > LOCAL_WORKSPACE_LIMITS.maxAssets) {
    fail(`Too many assets: ${assets.length} (limit ${LOCAL_WORKSPACE_LIMITS.maxAssets})`, 413)
  }
  for (const asset of assets) {
    assertObject(asset, 'each asset')
    if (!isSafeFilename(asset.id)) fail(`Unsafe asset id "${asset?.id}" — must be a plain filename`)
    if (typeof asset.base64 !== 'string') fail(`asset "${asset.id}" must carry a base64 string`)
  }

  const instanceYaml = payload.instanceYaml
  if (instanceYaml !== undefined && instanceYaml !== null && typeof instanceYaml !== 'string') {
    fail('instanceYaml must be a string')
  }
  if (operation !== 'validate' && (typeof instanceYaml !== 'string' || instanceYaml.trim() === '')) {
    fail(`instanceYaml is required for /api/local/${operation}`)
  }

  if ((operation === 'render' || operation === 'compile') && (typeof payload.artefact !== 'string' || payload.artefact.trim() === '')) {
    fail(`artefact is required for /api/local/${operation}`)
  }

  return { definitionId, definitionVersion, moduleFiles, assets, instanceYaml }
}

// Parses the supplied instance.yaml and forces its identity fields to the
// payload's authoritative values: `definition`/`definitionVersion` decide which
// bundled definition is used (never anything shipped in the payload), and `slug`
// is pinned so the temp-dir path is predictable.
function buildInstanceRecord(instanceYaml, { definitionId, definitionVersion, slug }) {
  let parsed = {}
  if (typeof instanceYaml === 'string' && instanceYaml.trim() !== '') {
    try {
      const value = parseYAML(instanceYaml)
      if (value !== null && value !== undefined) {
        if (typeof value !== 'object' || Array.isArray(value)) fail('instanceYaml must describe a mapping')
        parsed = value
      }
    } catch (err) {
      if (err instanceof LocalWorkspaceRequestError) throw err
      fail(`instanceYaml is not valid YAML: ${err.message}`)
    }
  }
  const record = { ...parsed, definition: definitionId, slug }
  if (definitionVersion !== undefined) record.definitionVersion = definitionVersion
  return record
}

function deriveSlug(instanceYaml) {
  if (typeof instanceYaml !== 'string' || instanceYaml.trim() === '') return 'local'
  try {
    const parsed = parseYAML(instanceYaml)
    const slug = parsed && typeof parsed === 'object' ? parsed.slug : null
    return typeof slug === 'string' && isValidSlug(slug) ? slug : 'local'
  } catch {
    return 'local'
  }
}

/**
 * Runs one `/api/local/*` operation against a caller-supplied file tree.
 *
 * @param {'status'|'check'|'validate'|'render'|'compile'} operation
 * @param {object} payload  `{ definitionId, definitionVersion?, instanceYaml, moduleFiles, assets?, gate?, artefact? }`
 * @param {{ definitionsDir: string, repoDir?: string }} options
 *   `definitionsDir` is the server's own bundled definitions directory;
 *   `repoDir` is where the local render sources its git commit info (the gantry
 *   install, not the throwaway temp dir).
 * @returns {Promise<object>} the operation's result — for `render`, the compiled
 *   `markdown` plus the produced `.docx` as `docxBase64`. For `compile` (WI314,
 *   the client-side WASM Pandoc render path's local-workspace half), the compiled
 *   `markdown` and the reference-doc bytes as `referenceDocBase64` — no `pandoc`
 *   subprocess is invoked at all, so the browser can convert both itself with no
 *   further server round-trip for the conversion. The Document Control commit
 *   footer is already baked into `markdown` either way: unlike the Azure-DevOps-
 *   hosted path (lib/render.js's `prepareAzureDevOpsWasmRender`), a local render's
 *   commit hash/date (`localHeadCommitInfo`) is known synchronously before any
 *   compile even starts, so there's no "learn the commit from a first push" step
 *   to split across a second round-trip here.
 */
export async function runLocalWorkspaceCompute(operation, payload, options = {}) {
  if (!OPERATIONS.has(operation)) fail(`Unknown local operation "${operation}"`, 404)

  const { definitionId, definitionVersion, moduleFiles, assets, instanceYaml } = validatePayload(
    operation,
    payload
  )
  const definitionsDir = options.definitionsDir ?? 'definitions'

  // `validate` never touches the caller's file tree — it checks a bundled
  // definition — so it needs no sandbox at all.
  if (operation === 'validate') {
    return validateDefinition(definitionId, { definitionsDir, version: definitionVersion })
  }

  const slug = deriveSlug(instanceYaml)
  const record = buildInstanceRecord(instanceYaml, { definitionId, definitionVersion, slug })

  if ((operation === 'status' || operation === 'render' || operation === 'compile') && !record.stage) {
    fail(`instanceYaml must set "stage" for /api/local/${operation}`)
  }
  if (operation === 'check' && !record.stage && !payload.gate) {
    fail('instanceYaml must set "stage", or pass "gate", for /api/local/check')
  }

  const root = mkdtempSync(join(tmpdir(), LOCAL_WORKSPACE_TMP_PREFIX))
  try {
    const instancesDir = join(root, 'gantry-workspace')
    const workspaceDir = join(instancesDir, slug)
    mkdirSync(join(workspaceDir, 'modules'), { recursive: true })
    writeFileSync(join(workspaceDir, 'instance.yaml'), stringifyYAML(record))

    for (const [moduleId, text] of Object.entries(moduleFiles)) {
      writeFileSync(join(workspaceDir, 'modules', `${moduleId}.md`), text)
    }
    if (assets.length) {
      mkdirSync(join(workspaceDir, 'assets'), { recursive: true })
      for (const asset of assets) {
        writeFileSync(join(workspaceDir, 'assets', asset.id), Buffer.from(asset.base64, 'base64'))
      }
    }

    if (operation === 'status') {
      return getStatus(slug, { instancesDir, definitionsDir })
    }

    if (operation === 'check') {
      return checkGate(slug, { instancesDir, definitionsDir, gate: payload.gate })
    }

    if (operation === 'compile') {
      // WI314: dry run — compiles the artefact's markdown (Document Control commit
      // footer included) and resolves which reference-doc file it needs, but never
      // shells out to `pandoc`. The browser does the markdown→docx conversion itself
      // (web/lib/pandocWasm.js) against this response.
      const result = renderArtefact(slug, payload.artefact, {
        instancesDir,
        definitionsDir,
        repoDir: options.repoDir,
        dryRun: true,
      })
      return {
        artefact: payload.artefact,
        basename: result.basename,
        markdown: result.markdown,
        referenceDocBase64: result.referenceDocPath ? readFileSync(result.referenceDocPath).toString('base64') : null,
      }
    }

    // render
    const result = renderArtefact(slug, payload.artefact, {
      instancesDir,
      definitionsDir,
      repoDir: options.repoDir,
    })
    return {
      artefact: payload.artefact,
      basename: result.basename,
      markdown: readFileSync(result.mdPath, 'utf8'),
      docxBase64: readFileSync(result.docxPath).toString('base64'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
