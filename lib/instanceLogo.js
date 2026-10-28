// #224 (docs/adr/0058 amendment for #224, docs/adr/0059 amendment for #224): the server's half of an
// Instance's own **Logo** (web/lib/instanceLogo.js describes it). Two things need the reference
// documents themselves, so they live here rather than in the pure description:
//
// - whether a Definition offers the Logo setting at all — only when its reference documents carry a
//   header logo picture (`definitionHeaderLogo`), and what that logo is, for Instance Settings to
//   show when the Instance has none of its own;
// - the render's copy of an Artefact's reference document with the Instance's logo in its header
//   (`referenceDocWithInstanceLogo`), made with the same replacement the Definitions page's Logo
//   control uses (web/lib/definitionLogo.js's `replaceHeaderLogo`, #222) and handed to Pandoc in
//   place of the original. The Definition's own reference documents are never written, and the
//   rendered output is never post-processed, so ADR-0056 holds.
//
// Both run synchronously over node:zlib, because lib/render.js's compile step is synchronous.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { logoImageProblem, readHeaderLogoSync, replaceHeaderLogoSync, sortReferenceDocxNames } from '../web/lib/definitionLogo.js'
import { instanceLogoNotOfferedMessage, instanceLogoPath } from '../web/lib/instanceLogo.js'

const ZLIB_CODEC = { inflateRaw: (bytes) => inflateRawSync(bytes), deflateRaw: (bytes) => deflateRawSync(bytes) }

// A reference document's header logo, by path, kept while the file is unchanged: `GET /api/instance`
// asks for every Instance it opens, and design v3 alone has seven reference documents.
const headerLogoCache = new Map()

function headerLogoOf(path) {
  const { mtimeMs, size } = statSync(path)
  const cached = headerLogoCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.logo
  let logo
  try {
    logo = readHeaderLogoSync(new Uint8Array(readFileSync(path)), ZLIB_CODEC)
  } catch {
    logo = null
  }
  headerLogoCache.set(path, { mtimeMs, size, logo })
  return logo
}

/**
 * The logo `definition`'s reference documents show in their page header — `{ bytes, contentType,
 * extension, document }` from the first of them (the shared `reference.docx` first) whose header
 * has one, as the Definitions page's Logo control reads it — or `null` when none does, in which case
 * its Instances are offered no Logo setting.
 */
export function definitionHeaderLogo(definition) {
  const templatesDir = definition?.definitionDir ? join(definition.definitionDir, 'templates') : null
  if (!templatesDir || !existsSync(templatesDir)) return null
  for (const name of sortReferenceDocxNames(readdirSync(templatesDir))) {
    const logo = headerLogoOf(join(templatesDir, name))
    if (logo) return { ...logo, document: name }
  }
  return null
}

/** Whether an Instance of `definition` is offered a Logo of its own: its reference documents carry a header logo. */
export function definitionOffersInstanceLogo(definition) {
  return Boolean(definitionHeaderLogo(definition))
}

/**
 * Why `image` (an upload's bytes) can't be stored as the logo of an Instance of `definition` — not a
 * PNG or JPEG, or a Definition that offers no Logo setting — or `null` when it can. Shared by
 * Instance creation and the Instance Settings write.
 */
export function instanceLogoProblem(definition, image) {
  const imageProblem = logoImageProblem(image ? new Uint8Array(image) : null)
  if (imageProblem) return imageProblem
  if (!definitionOffersInstanceLogo(definition)) return instanceLogoNotOfferedMessage(definition)
  return null
}

/**
 * The Instance's own logo for a render, read from `instanceDir` (the instance's folder on disk —
 * for a Provider-backed instance, the folder its assets were fetched into for the render): the bytes
 * of the image `record` names, or `null` when it names none or the file isn't there.
 */
export function instanceLogoBytes(instanceDir, record) {
  const path = instanceLogoPath(record)
  if (!path) return null
  const full = join(instanceDir, path)
  return existsSync(full) ? new Uint8Array(readFileSync(full)) : null
}

/**
 * A copy of the reference document at `referenceDocPath` with `logo` (an image's bytes) in place of
 * its header logo, or `null` when there is nothing to replace: no logo, no header picture, or bytes
 * that aren't a PNG or JPEG (the Definition's own logo then shows, as it would without one).
 */
export function referenceDocWithInstanceLogo(referenceDocPath, logo) {
  if (!referenceDocPath || !logo || logoImageProblem(logo)) return null
  try {
    const { docx, replaced } = replaceHeaderLogoSync(new Uint8Array(readFileSync(referenceDocPath)), logo, ZLIB_CODEC)
    return replaced > 0 ? docx : null
  } catch {
    return null
  }
}
