import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AZURE_DEVOPS_WORKSPACE_ROOT, readModule } from './instance.js'
import { moduleFieldsAtCommit } from './changedSinceApproval.js'
import { resolveContentStore } from './providerRegistry.js'
import { NotFoundError } from './providerErrors.js'
import { StorageConflictError } from './storage.js'
import { getBytesOrNull, getTextVersionedOrNull } from './storageFiles.js'
import { REVIEWED_COPY_MAX_BYTES, ReviewedCopyError, checkReviewedCopy, readReviewedCopy } from '../web/lib/reviewedCopy.js'
import { REVIEWS_MANIFEST_PATH, findReview, isReviewId, parseReviewManifest, reviewFilePath, reviewManifestEntry, stringifyReviewManifest } from '../web/lib/reviewManifest.js'

// #302 (ADR-0066): the server's half of bringing a **Reviewed copy** into an Instance. It checks what came
// in with the same reader the browser uses (web/lib/reviewedCopy.js), keeps each copy under the Instance's
// `reviews/` folder with `reviews/manifest.yaml` listing them (web/lib/reviewManifest.js), and gives them
// back. Where the Instance lives decides how a write lands, as for every other Instance file:
//
//   - a Provider-hosted Instance (Azure DevOps, GitHub, GitLab): one commit on the current Stage's branch,
//     holding every copy and the manifest;
//   - a server workspace (`options.storage`, the asynchronous half of lib/storage.js, whatever it keeps
//     its files in): each copy and then the manifest, the manifest written only if it is still as it was read.
//
// A Local workspace never comes here: the browser writes the same files straight into its folder.
// Nothing is rendered or cited, and Gantry never writes into the Reviewed copy itself.

const PROVIDER_STORES = {
  azureDevOps: { id: 'azure-devops', config: ({ organization, project, repository, pat, baseUrl, sharedCache }) => ({ organization, project, repository, pat, baseUrl, sharedCache }) },
  github: { id: 'github', config: ({ owner, repository, pat, baseUrl, sharedCache }) => ({ owner, repository, pat, baseUrl, sharedCache }) },
  gitlab: { id: 'gitlab', config: ({ namespace, repository, pat, baseUrl, sharedCache }) => ({ namespace, repository, pat, baseUrl, sharedCache }) },
}

/** Which Provider an options object names (`'azureDevOps'`, `'github'` or `'gitlab'`), or `null` for a storage-backed server workspace. */
export function reviewProviderKey(options) {
  return Object.keys(PROVIDER_STORES).find((key) => options[key]) ?? null
}

function providerClient(options) {
  const key = reviewProviderKey(options)
  const store = PROVIDER_STORES[key]
  return { key, client: resolveContentStore(store.id, store.config(options[key])), branch: options[key].branch }
}

const repoPath = (slug, relative) => `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/${relative}`
const storageKey = (options, slug, relative) => join(options.instancesDir ?? 'instances', slug, relative)

/** What an Instance of `definition` expects of a document brought in to it (`checkReviewedCopy`'s second argument). */
export function expectedRender(slug, definition) {
  return {
    slug,
    definition: definition.id,
    artefactIds: definition.artefacts.map((artefact) => artefact.id),
    stageIds: definition.stages.map((stage) => stage.id),
  }
}

/**
 * Checks everything in an upload before anything is written. `files` is `[{ filename, bytes }]`.
 * Resolves `{ ok: true, copies: [{ id, filename, bytes, entry }] }` or, when nothing at all may be written,
 * `{ ok: false, status, error, files: [{ filename, ok, code?, message? }] }`:
 *
 *  - an empty upload, or one over 25 MB in all (ADR-0066), is refused whole;
 *  - a file that is not a Word document, has no `gantry-*` properties, or comes from another Instance or
 *    Artefact is refused with the reason, and the other files in the upload are not written either — one
 *    upload is one commit, so it is all or nothing.
 */
export async function prepareReviewedCopies(files, { slug, definition, now = () => new Date() }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, status: 400, error: 'Choose at least one Reviewed copy (a .docx) to bring in.', files: [] }
  }
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0)
  if (total > REVIEWED_COPY_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `The Reviewed copies come to ${(total / 1024 / 1024).toFixed(1)} MB; one upload can hold up to ${REVIEWED_COPY_MAX_BYTES / 1024 / 1024} MB.`,
      files: files.map((file) => ({ filename: file.filename, ok: true })),
    }
  }
  const expected = expectedRender(slug, definition)
  const results = []
  const copies = []
  for (const file of files) {
    let read
    try {
      read = await readReviewedCopy(file.bytes)
    } catch (err) {
      if (!(err instanceof ReviewedCopyError)) throw err
      results.push({ filename: file.filename, ok: false, code: err.code, message: err.message })
      continue
    }
    const verdict = checkReviewedCopy(read.properties, expected)
    if (!verdict.ok) {
      results.push({ filename: file.filename, ok: false, code: verdict.code, message: verdict.message })
      continue
    }
    results.push({ filename: file.filename, ok: true })
    const id = randomUUID()
    copies.push({
      id,
      filename: file.filename,
      bytes: file.bytes,
      entry: reviewManifestEntry({ id, read, name: file.filename, date: now().toISOString(), size: file.bytes.length }),
    })
  }
  const refused = results.filter((result) => !result.ok)
  if (refused.length > 0) {
    return {
      ok: false,
      status: 422,
      error: refused.length === 1 ? `${refused[0].filename}: ${refused[0].message}` : `${refused.length} of the ${results.length} documents can't be brought in. Nothing was kept.`,
      files: results,
    }
  }
  return { ok: true, copies }
}

// --- Reading -------------------------------------------------------------------------------------------------

async function readProviderText(client, path, branch) {
  for (const ref of [...new Set([branch ?? 'main', 'main'])]) {
    try {
      return await client.getFileContent(path, { branch: ref })
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }
  return null
}

/** The Reviewed copies kept with an Instance, as the manifest lists them (oldest first). */
export async function readReviewManifest(slug, options) {
  if (options.storage) {
    const stored = await getTextVersionedOrNull(options.storage, storageKey(options, slug, REVIEWS_MANIFEST_PATH))
    return parseReviewManifest(stored?.text)
  }
  const { client, branch } = providerClient(options)
  return parseReviewManifest(await readProviderText(client, repoPath(slug, REVIEWS_MANIFEST_PATH), branch))
}

/** The bytes of one Reviewed copy, or `null` when the manifest has no such id or the file is gone. */
export async function readReviewedCopyFile(slug, id, options) {
  if (!isReviewId(id)) return null
  const entries = await readReviewManifest(slug, options)
  const entry = findReview(entries, id)
  if (!entry) return null
  const relative = reviewFilePath(id)
  if (options.storage) return getBytesOrNull(options.storage, storageKey(options, slug, relative))
  const { client, branch } = providerClient(options)
  for (const ref of [...new Set([branch ?? 'main', 'main'])]) {
    try {
      return Buffer.from(await client.getFileBytes(repoPath(slug, relative), { branch: ref }))
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }
  return null
}

// --- Writing -------------------------------------------------------------------------------------------------

/**
 * Keeps the prepared `copies` (`prepareReviewedCopies`) with the Instance and adds them to the manifest.
 * For a Provider that is one commit on `options.<provider>.branch`; for a store it is each copy then the
 * manifest. Resolves the manifest entries that were added.
 */
export async function storeReviewedCopies(slug, copies, options) {
  const added = copies.map((copy) => copy.entry)
  const names = copies.map((copy) => copy.filename).join(', ')
  if (options.storage) {
    const { storage } = options
    for (const copy of copies) await storage.putBytes(storageKey(options, slug, reviewFilePath(copy.id)), Buffer.from(copy.bytes))
    // Two uploads at once each read the manifest and add their entries; the write is conditional on the
    // version read, so the loser reads again rather than dropping the other's entries.
    for (let attempt = 0; ; attempt++) {
      const key = storageKey(options, slug, REVIEWS_MANIFEST_PATH)
      const stored = await getTextVersionedOrNull(storage, key)
      try {
        await storage.putText(key, stringifyReviewManifest([...parseReviewManifest(stored?.text), ...added]), { ifVersion: stored ? stored.version : null })
        return added
      } catch (err) {
        if (!(err instanceof StorageConflictError) || attempt >= 4) throw err
      }
    }
  }
  const { client, branch } = providerClient(options)
  const current = parseReviewManifest(await readProviderText(client, repoPath(slug, REVIEWS_MANIFEST_PATH), branch))
  const files = [
    ...copies.map((copy) => ({ path: repoPath(slug, reviewFilePath(copy.id)), content: Buffer.from(copy.bytes).toString('base64'), contentType: 'base64encoded' })),
    { path: repoPath(slug, REVIEWS_MANIFEST_PATH), content: stringifyReviewManifest([...current, ...added]) },
  ]
  await client.writeFiles(files, {
    branch,
    message: copies.length === 1 ? `Bring in the Reviewed copy "${names}"` : `Bring in ${copies.length} Reviewed copies (${names})`,
  })
  return added
}

// --- What a render showed ------------------------------------------------------------------------------------

function fieldText(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n')
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Every Field of the Definition, with its wording, for placing a Reviewed copy's comments (web/lib/
 * reviewedCopy.js's `placeReview`):
 *
 *   { basis: 'commit' | 'today', commit?, fields: [{ moduleId, moduleTitle, fieldId, fieldTitle, text? }] }
 *
 * With `commit` on a Provider-hosted Instance, the wording is each Module as it was at that commit (the
 * render the document came from, rebuilt); without one — a server workspace has no history — it is today's
 * content, and `basis` says so. `texts: false` gives the Fields alone, which is all the bookmarks need.
 * `options` is what `readModule` takes (a Provider location with its branch, or a store).
 */
export async function readReviewBasis(definition, slug, { commit, texts = true, ...options }) {
  const providerKey = reviewProviderKey(options)
  const atCommit = Boolean(texts && commit && providerKey)
  const fields = []
  for (const [moduleId, spec] of definition.modules) {
    let values = {}
    if (texts) {
      if (atCommit) {
        const { branch: _branch, ...base } = options[providerKey]
        values = (await moduleFieldsAtCommit({ providerKey, base, slug, definition, commit, moduleId })) ?? {}
      } else {
        try {
          values = (await readModule(definition, slug, moduleId, options)).fields ?? {}
        } catch (err) {
          if (!/has no saved data|ENOENT|not found/i.test(err.message) && !(err instanceof NotFoundError)) throw err
        }
      }
    }
    for (const field of spec.fields) {
      fields.push({
        moduleId,
        moduleTitle: spec.title,
        fieldId: field.id,
        fieldTitle: field.title,
        ...(texts ? { text: fieldText(values[field.id]) } : {}),
      })
    }
  }
  return { basis: atCommit ? 'commit' : 'today', ...(atCommit ? { commit } : {}), fields }
}
