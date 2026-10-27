import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve, extname, isAbsolute, delimiter } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Eta } from 'eta'
import { artefactModuleIds, loadDefinition } from './definition.js'
import { parseCoverClassification } from '../web/lib/artefactFrontMatter.js'
import {
  readInstance,
  readModule,
  azureDevOpsOutPath,
  githubOutPath,
  githubAssetsDir,
  gitlabOutPath,
  gitlabAssetsDir,
  atlassianOutPath,
  atlassianAssetsDir,
  instanceDisplayName,
  renderedArtefactBasename,
  filenamePatternContext,
  instanceDefinitionVersion,
  AZURE_DEVOPS_WORKSPACE_ROOT,
  RENDER_MANIFEST_FILENAME,
  resolveRenderManifestUpdate,
} from './instance.js'
import { resolveAssetFileRefs, resolveRepoAssetFileRefs } from './assets.js'
import { headingNumberer } from './wordHeadingNumbering.js'
import { numberDiagrams } from '../web/lib/diagramCaptions.js'
import { drawMermaidInChromium } from './mermaidChromium.js'
import { AuthenticationError } from './providerErrors.js'
import { resolveContentStore } from './providerRegistry.js'
import { commitUrl } from './azureDevOpsFileUrl.js'
import { artefactFileUrl as githubArtefactFileUrl, commitUrl as githubCommitUrl } from './githubFileUrl.js'
import { artefactFileUrl as gitlabArtefactFileUrl, commitUrl as gitlabCommitUrl } from './gitlabFileUrl.js'
import { artefactFileUrl as atlassianArtefactFileUrl, commitUrl as atlassianCommitUrl } from './atlassianFileUrl.js'

// autoTrim: false is deliberate — Eta's own default trimming strips the newline after every interpolation tag, which runs the next heading onto the same line as the preceding paragraph. The cost is that suppressed optional sections leave blank-line runs behind; renderArtefact collapses those afterwards instead.
//
// functionHeader (WI #273 / R2): the blank-field guard `na()` used to be copy-pasted into
// four (then six) design templates. Injecting the one definition here as a function header
// puts it in scope for every template *and* every `include()`d partial, so the definition
// lives in exactly one place. Harmless for definitions/partials that never call it.
const NA_HELPER = "const na = (v) => (typeof v === 'string' && v.trim() !== '') ? v : '— n/a —';"

// #85 (ADR-0044): `date` fields store ISO 8601 (YYYY-MM-DD) on disk — unambiguous and
// diff-clean — but that's a poor read for a candidate-facing document, so templates get this
// helper to read it as unambiguous long-form English ("3 November 2026", day-month-year, no
// UK/US toggle needed since the month is spelled out) rather than storing a second, possibly
// disagreeing, formatted copy of the same value. Formatting only — never called automatically,
// and never changes what's on disk. A value that doesn't round-trip through Date.UTC (the same
// check lib/status.js's dateFormatWarnings uses) is returned unchanged rather than guessed at,
// since JS's own Date otherwise silently rolls a calendar impossibility like 2026-02-30 into a
// different, wrong date.
const FORMAT_DATE_HELPER =
  "const formatDate = (v) => { if (typeof v !== 'string' || v.trim() === '') return v; " +
  "const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(v.trim()); if (!m) return v; " +
  "const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]); " +
  "const dt = new Date(Date.UTC(y, mo - 1, d)); " +
  "if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return v; " +
  "return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };"
const eta = new Eta({ autoTrim: false, functionHeader: NA_HELPER + FORMAT_DATE_HELPER })

function findArtefactSpec(definition, artefactId) {
  const artefact = definition.artefacts.find((a) => a.id === artefactId)
  if (!artefact) {
    throw new Error(`Definition "${definition.id}" has no artefact "${artefactId}"`)
  }
  return artefact
}

// #88 (ADR-0045 §7): the local-disk half of the render manifest — applied only for a true local
// instance's own persisted `out/`, never for the local scratch copy a Provider-backed render also
// happens to write there (`compileArtefact`'s own doc comment: that copy is a build detail, not
// what the instance's render is "of"). `outDir` is assumed to already exist (every non-dry-run,
// non-deliverToClient `compileArtefact` call creates it before this runs). Every failure mode —
// a manifest that can't be read, a stale file that's already gone, a write that fails — is
// swallowed rather than thrown: per #88's own acceptance criteria, a manifest problem degrades to
// pre-#88 behaviour (the new file lands; nothing else happens) rather than failing the render.
function applyLocalRenderManifest(outDir, artefactId, newFilename) {
  const manifestPath = join(outDir, RENDER_MANIFEST_FILENAME)
  let manifestRaw
  try {
    manifestRaw = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined
  } catch {
    manifestRaw = undefined
  }
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(manifestRaw, artefactId, newFilename)
  if (staleFilename) {
    try {
      rmSync(join(outDir, staleFilename), { force: true })
    } catch {
      // Deletion failing (permissions, already gone) must not fail the render — the new file is
      // already on disk; the stale one is a cleanup nicety, not a correctness requirement.
    }
  }
  if (changed) {
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    } catch {
      // Same reasoning as above — a manifest that fails to write just means the next render
      // can't find a previous filename either, i.e. pre-#88 behaviour, not a failed render.
    }
  }
}

// #88 (ADR-0045 §7): the one seam every Provider's *final* push goes through — the native
// two-push path's second (Document-Control-complete) push below, and the WASM render path's own
// `finishXWasmRender` leg, which lands the browser's own converted bytes at exactly the same spot
// the native path's second push would have. `path` is the artefact's own out/ path (already
// slug/instance/pattern-resolved by the caller); the manifest lives alongside it in the same
// directory, keyed by `artefactId`, so this needs no separate slug or workspace-root knowledge of
// its own. A manifest that can't be read (missing, or the Provider errors reading it) degrades to
// "no previous filename known" — the new file still lands, nothing is deleted, matching
// pre-#88 behaviour — rather than failing the render.
//
// The new artefact file, the manifest update (only when the recorded filename actually changed —
// #88's "no spurious commit" requirement), and the deletion of whatever file the manifest named
// before (when that differs from this render's own filename) all go through one `client.writeFiles`
// call — one push, one commit, so a partial failure can't leave the new file live and the old one
// still lying around, or vice versa.
async function pushFinalRenderedArtefact(client, { branch, artefactId, path, bytes, message }) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const manifestPath = dir ? `${dir}/${RENDER_MANIFEST_FILENAME}` : RENDER_MANIFEST_FILENAME

  let manifestRaw
  try {
    manifestRaw = await client.getFileContent(manifestPath, { branch })
  } catch {
    manifestRaw = undefined
  }

  const newFilename = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(manifestRaw, artefactId, newFilename)

  const files = [{ path, content: bytes.toString('base64'), contentType: 'base64encoded' }]
  if (changed) {
    files.push({ path: manifestPath, content: JSON.stringify(manifest, null, 2), contentType: 'rawtext' })
  }
  const deletePaths = staleFilename ? [dir ? `${dir}/${staleFilename}` : staleFilename] : []

  await client.writeFiles(files, { branch, message, deletePaths })
}

/**
 * reviewSummary shape (single source of truth — consumed by lib/render.js's
 * pipeline-injected Document Control + Review & sign-off block, built by
 * lib/server.js's render routes from reviewStatus.js / stageReview.js /
 * stageApproval.js / work-item + PR data, and documented here for both):
 *
 * {
 *   version: string,            // e.g. "design v1 · Detailed Design"
 *   stageTitle: string,         // stage title for the artefact's own gate
 *   date: string,               // YYYY-MM-DD — same value the old footer used (commit.date)
 *   commit: { hash: string, url?: string, date?: string }, // short hash, hyperlinked for workspace-backed, plain for local
 *   gateStatus: string,         // Draft | In review | Changes requested | Approved | Passed (artefact's own gate)
 *   rows: [{ name, role, date, process, status, reference: { text, url? } }] // one per review + one per sign-off for this gate only; Pending when none
 * }
 *
 * `compileArtefact` stays pure — no network calls or
 * reviewStatus/stageReview/stageApproval imports — data arrives via
 * `options.reviewSummary`; commit hash/url/date may be merged from
 * `options.commit` / `options.azureDevOps` when the caller didn't already
 * populate them (the Azure-DevOps-backed two-push flow only knows the hash
 * after its first push).
 */

function escapePipe(value) {
  return String(value ?? '').replace(/\|/g, '\\|')
}

function buildDocumentControlMarkdown(reviewSummary, definitionDir) {
  if (!reviewSummary) return ''
  // Prefer the shared Eta partial when it exists (design definition's
  // templates/_documentControl.md.tmpl) — keeps the two-table layout in one
  // place rather than duplicated inline, satisfying the "shared partial
  // referenced by the pipeline" requirement. Fall back to inline rendering
  // for any definition that hasn't shipped the partial yet (e.g. the
  // temporary "another-definition" copies tests create) so no definition
  // loses its commit reference.
  const partialCandidates = []
  if (definitionDir) partialCandidates.push(join(definitionDir, 'templates', '_documentControl.md.tmpl'))
  partialCandidates.push('definitions/design/1/templates/_documentControl.md.tmpl')
  for (const p of partialCandidates) {
    try {
      if (existsSync(p)) {
        const src = readFileSync(p, 'utf8')
        // The partial already contains headings and the commit hyperlink logic;
        // ensure at least one Pending row when caller gave none, same as inline.
        const normalized = {
          ...reviewSummary,
          rows: reviewSummary.rows?.length
            ? reviewSummary.rows
            : [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
        }
        // eta autoTrim false keeps heading newlines intact
        return eta.renderString(src, normalized).replace(/\n{3,}/g, '\n\n')
      }
    } catch {
      // fall through to inline
    }
  }

  const commit = reviewSummary.commit ?? {}
  const commitCell = commit.url
    ? `[\`${commit.hash}\`](${commit.url})`
    : commit.hash
      ? `\`${commit.hash}\``
      : ''
  const version = reviewSummary.version ?? ''
  const date = reviewSummary.date ?? commit.date ?? ''
  const gateStatus = reviewSummary.gateStatus ?? 'Draft'
  const rows = reviewSummary.rows?.length
    ? reviewSummary.rows
    : [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }]

  let docControl = `## Document Control\n\n| Field | Value |\n|---|---|\n| Version | ${escapePipe(version)} |\n| Date | ${escapePipe(date)} |\n| Commit | ${commitCell} |\n| Status | ${escapePipe(gateStatus)} |\n`
  let reviewBlock = `## Review & sign-off\n\n| Name | Role / Title | Date | Review process | Status | Reference |\n|---|---|---|---|---|---|\n`
  for (const r of rows) {
    const refCell = r.reference?.url ? `[${r.reference.text}](${r.reference.url})` : (r.reference?.text ?? '')
    reviewBlock += `| ${escapePipe(r.name)} | ${escapePipe(r.role)} | ${escapePipe(r.date)} | ${escapePipe(r.process)} | ${escapePipe(r.status)} | ${escapePipe(refCell)} |\n`
  }
  return `${docControl}\n${reviewBlock}`
}

// Puts `block` straight under the document's first H1 (its title), or at the very top when it has
// none — where Document Control has always gone (WI233).
function insertUnderTitle(markdown, block) {
  const lines = markdown.split('\n')
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l))
  if (titleIdx !== -1) {
    const before = lines.slice(0, titleIdx + 1).join('\n')
    const after = lines.slice(titleIdx + 1).join('\n')
    return `${before}\n\n${block}\n${after}`.replace(/\n{3,}/g, '\n\n')
  }
  return `${block}\n\n${markdown}`.replace(/\n{3,}/g, '\n\n')
}

// --- Front matter: cover page and table of contents (#194, ADR-0052) ---
// Both are opt-in per Artefact (`cover-page: true`, `table-of-contents: true`) and built here, in the
// compile step every render path shares, as plain Pandoc Markdown — so the native Pandoc render (CLI,
// server) and the browser's pandoc-wasm get them from the same text with no change to either's
// arguments. Paragraph styles are named with Pandoc's `custom-style`, so an organisation's reference
// .docx styles them like any other paragraph: `Title`, `Subtitle` and `TOC Heading` are built-in
// Word styles every reference document already has, and `Cover Classification`, `Cover Details` and
// `Cover Purpose` are created on the fly (based on Body Text) when the reference document doesn't
// define them. Word-only parts — page breaks and the TOC field — are raw OpenXML blocks, which Pandoc
// passes into the .docx and leaves out of any other output.
const PAGE_BREAK_MARKDOWN = '```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```'

// A Word TOC field over heading levels 1–3 (`\o "1-3"`), hyperlinked (`\h`), without page numbers in
// web view (`\z`), and including paragraphs with an outline level (`\u`). Pandoc's own TOC option was
// not used: it puts the table before everything the template produces, so before Document Control,
// and would have to be added to both render paths' arguments (ADR-0052). `w:dirty="true"` marks the
// field as needing an update, so Word rebuilds it from the document's headings when the document is
// opened — the same flag Pandoc's own TOC uses. The Word conversion gets the field filled in with the
// document's headings (prefillTableOfContents, #206), so a viewer that doesn't update fields still
// shows the contents; the placeholder is what the exported `.md` carries, and what Word shows when
// there are no headings to list.
const TOC_FIELD_BEGIN =
  '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
const TOC_FIELD_END = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
const TOC_PLACEHOLDER_FIELD =
  `<w:p>${TOC_FIELD_BEGIN}<w:r><w:t>Open this document in Word, or update this field, to build the table of contents.</w:t></w:r>${TOC_FIELD_END}</w:p>`
const TABLE_OF_CONTENTS_MARKDOWN = [
  '::: {custom-style="TOC Heading"}\nTable of Contents\n:::',
  '```{=openxml}\n' + TOC_PLACEHOLDER_FIELD + '\n```',
  PAGE_BREAK_MARKDOWN,
].join('\n\n')

// One line of cover text: whitespace (newlines included) collapsed, so a value can't open a new block.
function coverLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function coverParagraph(style, text) {
  return `::: {custom-style="${style}"}\n${text}\n:::`
}

// The cover: classification (when the Artefact names a Field for it and that Field has a value),
// title, version, status, author and purpose, then a page break — and never any section content or
// diagram, since it reads only the instance record, the Artefact spec and the Document Control values.
// The title is the instance's display name (its name, or its slug title-cased) and the subtitle the
// Artefact's own title, the document type. Version and status are the values the Document Control
// table prints, so the two never disagree; the author is the instance's Assignee (ADR-0009). Any part
// that has no value is left out rather than printed blank.
function buildCoverPageMarkdown(artefact, instance, modules, reviewSummary) {
  const named = parseCoverClassification(artefact.coverClassification)
  const classification = named ? coverLine(modules?.[named.moduleId]?.[named.fieldId]) : ''
  const details = [
    ['Version', coverLine(reviewSummary?.version)],
    ['Status', coverLine(reviewSummary?.gateStatus)],
    ['Author', coverLine(instance.assignee)],
  ].filter(([, value]) => value).map(([label, value]) => `**${label}:** ${value}`)
  const purpose = coverLine(artefact.purpose)
  return [
    classification ? coverParagraph('Cover Classification', classification) : null,
    coverParagraph('Title', instanceDisplayName(instance)),
    coverParagraph('Subtitle', coverLine(artefact.title)),
    details.length ? coverParagraph('Cover Details', details.join('\n\n')) : null,
    purpose ? coverParagraph('Cover Purpose', purpose) : null,
    PAGE_BREAK_MARKDOWN,
  ].filter(Boolean).join('\n\n')
}

// Assembles the document's front matter around the compiled template output. With a cover, the cover
// is the title page, so Document Control and the table of contents follow it and everything the
// template produced (its own H1 included) comes after them, unchanged. Without one, the template's H1
// stays the document's title and the front matter goes straight under it, where Document Control has
// always gone — so with `document-control: false` the table of contents is the first thing under the
// title. With neither key this is exactly the Document Control injection every render has always had.
// `documentControl` is the Document Control block (empty for none), built by the caller, which hands
// the Word conversion its own copy (see compileArtefact).
function assembleFrontMatter(resolved, artefact, instance, modules, reviewSummary, documentControl) {
  const tableOfContents = artefact.tableOfContents === true ? TABLE_OF_CONTENTS_MARKDOWN : ''
  if (artefact.coverPage === true) {
    const cover = buildCoverPageMarkdown(artefact, instance, modules, reviewSummary)
    return [cover, documentControl, tableOfContents, resolved].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n')
  }
  if (!tableOfContents) return documentControl ? insertUnderTitle(resolved, documentControl) : resolved
  return insertUnderTitle(resolved, documentControl ? `${documentControl}\n${tableOfContents}\n` : `${tableOfContents}\n`)
}

// --- Unnumbered headings (#197, ADR-0056) ---
// A reference document can number its headings (design v3's numbers Heading 1–3 as 1 / 1.1 / 1.1.1),
// and Word then numbers every paragraph in those styles — Document Control and Review & sign-off
// included. Pandoc's Markdown says "not this one" with the `.unnumbered` class (or its shorthand
// `{-}`), but Pandoc's Word writer ignores the class: it has no way to switch a heading's list
// numbering off. So, for the Word conversion only, an `.unnumbered` ATX heading is written as the
// same heading paragraph in raw OpenXML with its numbering switched off (`numId` 0), which Word
// honours whatever the reference document numbers. Raw OpenXML is how the cover and the table of
// contents already reach Word (ADR-0052), so both render paths get it from the same text, with no
// change to either's arguments. The exported `.md` keeps the heading as authored. Headings inside
// fenced code blocks are left alone. A document whose reference document numbers nothing looks
// exactly the same either way.
//
// The paragraph is the one Pandoc would have written, as far as raw OpenXML can: its inline Markdown
// (bold, italics, code, strikeout, links, backslash escapes) becomes the same runs and character
// styles, and it carries a bookmark named for its `{#id}` — or, without one, for the identifier
// Pandoc would have given it — so a link to it still lands on it. Raw OpenXML can't add a
// relationship, so an external link is a HYPERLINK field rather than Pandoc's relationship link; it
// looks and works the same. Where another heading in the document would take the same identifier,
// it is left to that one.
//
// Where it applies is decided in compileArtefact: the whole document for an Artefact that opts into
// design v3's Word front matter, and only the Document Control partial for any other (#192 audit).
const UNNUMBERED_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]+\{([^{}]*)\}[ \t]*$/
const ATX_HEADING = /^#{1,6}[ \t]+(.*?)(?:[ \t]+\{([^{}]*)\})?[ \t]*$/
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/
const BOOKMARK_ID_BASE = 1000000

function xmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function xmlAttribute(text) {
  return xmlText(text).replace(/"/g, '&quot;')
}

function xmlDecode(text) {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// Where the delimiter run opened at `from` closes, or -1: the next unescaped `delimiter` outside a
// code span, that isn't part of a longer run of the same character, with something in between.
function closingDelimiter(src, from, delimiter) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') {
      i++
      continue
    }
    if (src[i] === '`') {
      const tick = /^`+/.exec(src.slice(i))[0]
      const end = codeSpanEnd(src, i, tick.length)
      if (end > 0) i = end - 1
      else i += tick.length - 1
      continue
    }
    if (!src.startsWith(delimiter, i) || i === from) continue
    const ch = delimiter[0]
    if (src[i + delimiter.length] === ch || src[i - 1] === ch) continue
    if (/\s/.test(src[i - 1])) continue
    if (ch === '_' && /[\p{L}\p{N}]/u.test(src[i + delimiter.length] ?? '')) continue
    return i
  }
  return -1
}

// The index just past the code span whose opening backtick run (of `length`) starts at `start`.
function codeSpanEnd(src, start, length) {
  let i = start + length
  while (i < src.length) {
    const next = src.indexOf('`', i)
    if (next < 0) return -1
    const run = /^`+/.exec(src.slice(next))[0]
    if (run.length === length) return next + length
    i = next + run.length
  }
  return -1
}

// The index of the bracket that closes the one at `open`, or -1.
function closingBracket(src, open, [left, right]) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') i++
    else if (src[i] === left) depth++
    else if (src[i] === right && --depth === 0) return i
  }
  return -1
}

// A heading's inline Markdown as a small tree: text, code, strong, emph, strike and link nodes.
// Anything it doesn't recognise stays text, as Pandoc would print it.
function parseInline(src) {
  const nodes = []
  let text = ''
  const flush = () => {
    if (text) nodes.push({ type: 'text', value: text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && ASCII_PUNCTUATION.test(src[i + 1] ?? '')) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const tick = /^`+/.exec(src.slice(i))[0]
      const end = codeSpanEnd(src, i, tick.length)
      if (end < 0) {
        text += tick
        i += tick.length
        continue
      }
      let code = src.slice(i + tick.length, end - tick.length).replace(/\n/g, ' ')
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
      flush()
      nodes.push({ type: 'code', value: code })
      i = end
      continue
    }
    if (ch === '[') {
      const close = closingBracket(src, i, '[]')
      const end = close > 0 && src[close + 1] === '(' ? closingBracket(src, close + 1, '()') : -1
      if (end > 0) {
        const target = src.slice(close + 2, end).trim().replace(/[ \t]+(?:"[^"]*"|'[^']*')$/, '')
        flush()
        nodes.push({ type: 'link', url: target.replace(/^<(.*)>$/, '$1'), children: parseInline(src.slice(i + 1, close)) })
        i = end + 1
        continue
      }
    }
    if (ch === '<') {
      const autolink = /^<((?:https?|ftp|mailto):[^\s<>]+)>/i.exec(src.slice(i))
      if (autolink) {
        flush()
        nodes.push({ type: 'link', url: autolink[1], children: [{ type: 'text', value: autolink[1] }] })
        i += autolink[0].length
        continue
      }
    }
    const delimiter = ['**', '__', '~~', '*', '_'].find((d) => src.startsWith(d, i))
    if (delimiter && !/\s/.test(src[i + delimiter.length] ?? ' ') && !(delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(src[i - 1] ?? ''))) {
      const close = closingDelimiter(src, i + delimiter.length, delimiter)
      if (close > 0) {
        flush()
        const type = delimiter === '~~' ? 'strike' : delimiter.length === 2 ? 'strong' : 'emph'
        nodes.push({ type, children: parseInline(src.slice(i + delimiter.length, close)) })
        i = close + delimiter.length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return nodes
}

function plainText(nodes) {
  return nodes.map((node) => (node.children ? plainText(node.children) : node.value)).join('')
}

// Pandoc's `auto_identifiers`: the heading's text without formatting, only letters, digits, `_`, `-`
// and `.`, its words joined by `-`, lower-cased, from its first letter on; `section` if nothing's left.
function pandocIdentifier(nodes) {
  const id = plainText(nodes)
    .replace(/[^\p{L}\p{N}_\-.\s]/gu, '')
    .trim()
    .split(/\s+/)
    .join('-')
    .toLowerCase()
    .replace(/^[^\p{L}]*/u, '')
  return id || 'section'
}

function wordRun(text, format) {
  const style = format.link ? 'Hyperlink' : format.code ? 'VerbatimChar' : null
  const rPr = [
    style ? `<w:rStyle w:val="${style}"/>` : '',
    format.strong ? '<w:b/><w:bCs/>' : '',
    format.emph ? '<w:i/><w:iCs/>' : '',
    format.strike ? '<w:strike/>' : '',
  ].join('')
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`
}

function wordRuns(nodes, format = {}) {
  return nodes
    .map((node) => {
      if (node.type === 'text') return wordRun(node.value, format)
      if (node.type === 'code') return wordRun(node.value, { ...format, code: true })
      if (node.type !== 'link') return wordRuns(node.children, { ...format, [node.type]: true })
      if (format.link) return wordRuns(node.children, format)
      const label = wordRuns(node.children, { ...format, link: true })
      if (node.url.startsWith('#')) return `<w:hyperlink w:anchor="${xmlAttribute(node.url.slice(1))}">${label}</w:hyperlink>`
      const url = xmlText(node.url.replace(/"/g, '%22'))
      return (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        `<w:r><w:instrText xml:space="preserve"> HYPERLINK "${url}" </w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${label}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
      )
    })
    .join('')
}

// Calls `visit(line)` for every line outside a fenced code block and returns what it maps them to.
function mapOutsideFences(markdown, visit) {
  let fence = null
  return markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
      return line
    }
    if (marker) {
      fence = marker
      return line
    }
    return visit(line)
  })
}

const headingAttributes = (attributes) => (attributes ?? '').trim().split(/\s+/).filter(Boolean)
const explicitId = (attributes) => headingAttributes(attributes).find((a) => a.startsWith('#'))?.slice(1)
const isUnnumbered = (attributes) => headingAttributes(attributes).some((a) => a === '.unnumbered' || a === '-')

// `document` is the whole document `markdown` is part of, when it is only a part (the Document
// Control block): its headings are the ones an identifier must not clash with.
export function unnumberedHeadingsForWord(markdown, { document = markdown } = {}) {
  // Every heading's identifier, as Pandoc would see them, so an unnumbered heading never takes one
  // that another heading has too.
  const identifiers = new Map()
  mapOutsideFences(document, (line) => {
    const heading = ATX_HEADING.exec(line)
    if (heading) {
      const id = explicitId(heading[2]) ?? pandocIdentifier(parseInline(heading[1]))
      identifiers.set(id, (identifiers.get(id) ?? 0) + 1)
    }
    return line
  })
  let bookmark = BOOKMARK_ID_BASE
  return mapOutsideFences(markdown, (line) => {
    const heading = UNNUMBERED_HEADING.exec(line)
    if (!heading || !isUnnumbered(heading[3])) return line
    const [, hashes, text, attributes] = heading
    const inline = parseInline(text)
    const given = explicitId(attributes)
    const auto = pandocIdentifier(inline)
    const id = given ?? (identifiers.get(auto) === 1 ? auto : null)
    const runs = wordRuns(inline)
    const content = id ? `<w:bookmarkStart w:id="${bookmark}" w:name="${xmlAttribute(id)}"/>${runs}<w:bookmarkEnd w:id="${bookmark++}"/>` : runs
    return (
      '\n```{=openxml}\n' +
      `<w:p><w:pPr><w:pStyle w:val="Heading${hashes.length}"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>${content}</w:p>\n` +
      '```\n'
    )
  }).join('\n')
}

// --- The table of contents, filled in (#206, ADR-0052 amendment) ---
// Word rebuilds the TOC field when it opens the document (it is marked dirty), but a viewer that
// doesn't update fields — a preview, a web viewer, another editor — shows whatever the field's result
// already holds. So the Word conversion's Markdown gets the result Word itself would build, less the
// page numbers (they need a page layout, which only a word processor has): one paragraph per heading
// at levels 1–3, in document order, in Word's `TOC 1`–`TOC 3` styles, each an internal link to its
// heading's bookmark, and each heading's number when the reference document numbers headings. It is
// built from the text Pandoc is about to convert, so it lists the headings Pandoc will write, under
// the bookmarks Pandoc will give them: a heading's `{#id}`, or else Pandoc's automatic identifier,
// made unique the way Pandoc makes it (`-1`, `-2`, …). `.unnumbered` headings are already raw OpenXML
// by now (unnumberedHeadingsForWord), and are listed with the bookmark and text written there.
//
// Not listed, as Pandoc writes no heading for them: heading-like lines in fenced code, in HTML
// comments, or that only continue a paragraph. Headings inside list items or block quotes aren't
// listed either, though Word would list them; templates and Fields don't put headings there.

// Pandoc's `smart` extension, as it changes a heading's text: dashes, ellipses, curly quotes and
// apostrophes. Code spans keep their characters. The identifier and the listed text are both taken
// from the result, as Pandoc takes them.
function smartText(nodes) {
  const code = []
  const raw = (list) => list.map((node) => (node.type === 'code' ? `\u{F0000}${code.push(node.value) - 1}\u{F0001}` : node.children ? raw(node.children) : node.value)).join('')
  let text = raw(nodes).replace(/---/g, '—').replace(/--/g, '–').replace(/\.\.\./g, '…')
  for (const [quote, open, close] of [['"', '“', '”'], ["'", '‘', '’']]) {
    const pattern = new RegExp(`(^|[\\s([{\\u2013\\u2014])${quote}(?=\\S)([^${quote}]*?\\S)${quote}(?![\\p{L}\\p{N}])`, 'gu')
    text = text.replace(pattern, (_, before, inner) => `${before}${open}${inner}${close}`)
  }
  text = text.replace(/(?<=\S)'/g, '’')
  return text.replace(/\u{F0000}(\d+)\u{F0001}/gu, (_, i) => code[Number(i)])
}

// The bookmark name Pandoc's Word writer gives an identifier: the identifier itself, unless it is
// longer than Word's 40-character limit or doesn't start with a letter, when it is "X" and the SHA-1
// of the identifier (Pandoc's `toBookmarkName`). Pandoc rewrites its own links the same way.
function pandocBookmarkName(id) {
  if (/^\p{L}/u.test(id) && [...id].length <= 40) return id
  return `X${createHash('sha1').update(id, 'utf8').digest('hex').slice(1)}`
}

const SETEXT_UNDERLINE = /^(=+|-+)[ \t]*$/
const NOT_A_SETEXT_TITLE = /^(?: {4}|\t|[-*+][ \t]|>|\||:{3}|<|\d+[.)][ \t]|#|\s*$)/

// Every heading Word will see in `markdown` (the Word conversion's), in order: `{ level, text,
// anchor, unnumbered }`, `anchor` being the bookmark the heading carries (null when it has none).
function wordHeadings(markdown) {
  const lines = markdown.split('\n')
  const used = new Set()
  const headings = []
  const pandocHeading = (level, source) => {
    const attributes = /[ \t]+\{([^{}]*)\}[ \t]*$/.exec(source)
    const content = (attributes ? source.slice(0, attributes.index) : source).replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim()
    const text = smartText(parseInline(content))
    let anchor = explicitId(attributes?.[1])
    if (anchor === undefined) {
      const base = pandocIdentifier([{ type: 'text', value: text }])
      anchor = base
      for (let n = 1; used.has(anchor); n++) anchor = `${base}-${n}`
    }
    used.add(anchor)
    headings.push({ level, text, anchor: anchor ? pandocBookmarkName(anchor) : null, unnumbered: false })
  }
  // A raw OpenXML block's heading paragraphs — design v3's `.unnumbered` headings — as written there.
  const rawHeadings = (xml) => {
    for (const [paragraph] of xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)) {
      const level = /<w:pStyle w:val="Heading(\d)"\/>/.exec(paragraph)?.[1]
      if (!level) continue
      const bookmark = /<w:bookmarkStart w:id="\d+" w:name="([^"]*)"\/>/.exec(paragraph)?.[1]
      headings.push({
        level: Number(level),
        text: xmlDecode([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
        anchor: bookmark === undefined ? null : xmlDecode(bookmark),
        unnumbered: /<w:numId w:val="0"\/>/.test(paragraph),
      })
    }
  }
  // Whether the line before can end a block, so that this one can start one: Pandoc wants a blank
  // line before a heading, except after another heading, a fence, or at the very start.
  let blockStart = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`).test(l))
      const close = end < 0 ? lines.length : end
      if (/^\s*\{=openxml\}\s*$/.test(fence[2])) rawHeadings(lines.slice(i + 1, close).join('\n'))
      i = close
      blockStart = true
      continue
    }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++
      blockStart = true
      continue
    }
    const atx = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
    if (atx && blockStart) {
      pandocHeading(atx[1].length, atx[2] ?? '')
      blockStart = true
      continue
    }
    if (blockStart && !NOT_A_SETEXT_TITLE.test(line) && SETEXT_UNDERLINE.test(lines[i + 1] ?? '')) {
      pandocHeading(lines[i + 1].startsWith('=') ? 1 : 2, line.trim())
      i++
      blockStart = true
      continue
    }
    blockStart = line.trim() === '' || /^ {0,3}:{3,}/.test(line)
  }
  return headings
}

function tableOfContentsEntry({ level, text, anchor }, number) {
  // A numbered entry's text starts at a tab stop past its number, as Word lays its own entries out.
  const tabs = number?.suffix === '\t' ? `<w:tabs><w:tab w:val="left" w:pos="${440 * level}"/></w:tabs>` : ''
  const run = (t) => `<w:r><w:t xml:space="preserve">${xmlText(t)}</w:t></w:r>`
  const label = number ? `${run(number.text)}${number.suffix === '\t' ? '<w:r><w:tab/></w:r>' : number.suffix ? run(number.suffix) : ''}${run(text)}` : run(text)
  const linked = anchor ? `<w:hyperlink w:anchor="${xmlAttribute(anchor)}" w:history="1">${label}</w:hyperlink>` : label
  return { pPr: `<w:pPr><w:pStyle w:val="TOC${level}"/>${tabs}</w:pPr>`, content: linked }
}

// Fills the TOC field in `docxMarkdown` with its entries: the field opens in the first entry's
// paragraph and closes in the last one's, as in a table of contents Word has built. `referenceDocPath`
// is the reference document the conversion uses, which decides the headings' numbers. With no
// heading to list, the field keeps its placeholder.
export function prefillTableOfContents(docxMarkdown, referenceDocPath) {
  if (!docxMarkdown.includes(TOC_PLACEHOLDER_FIELD)) return docxMarkdown
  const numberHeading = headingNumberer(referenceDocPath)
  const entries = wordHeadings(docxMarkdown).flatMap((heading) => {
    const number = numberHeading(heading.level, heading)
    return heading.level <= 3 ? [tableOfContentsEntry(heading, number)] : []
  })
  if (!entries.length) return docxMarkdown
  const field = entries
    .map(({ pPr, content }, i) => `<w:p>${pPr}${i === 0 ? TOC_FIELD_BEGIN : ''}${content}${i === entries.length - 1 ? TOC_FIELD_END : ''}</w:p>`)
    .join('')
  return docxMarkdown.replace(TOC_PLACEHOLDER_FIELD, () => field)
}

// AB#345: the zip-release pipeline (azure-pipelines.zip-release.yml, WI #312) packages a
// Git-free distributable — by design there is never a .git directory at the install dir a
// zip-release instance runs from. Its staging step stamps the source commit it packaged into
// this file at the root of the staged output, so a zip-release install can name a genuine,
// package-time commit instead of either shelling out to a `git` that can't exist there or
// falling all the way back to "unknown". A normal git-clone install never has this file, so
// it always falls through to the live `git` lookup below, unchanged.
const BUILD_INFO_FILENAME = '.build-info.json'

function buildInfoCommit(cwd) {
  const path = join(cwd ?? process.cwd(), BUILD_INFO_FILENAME)
  if (!existsSync(path)) return null
  try {
    const info = JSON.parse(readFileSync(path, 'utf8'))
    if (!info || typeof info.hash !== 'string' || !info.hash) return null
    return { hash: info.hash, date: typeof info.date === 'string' ? info.date : null }
  } catch {
    // Malformed stamp file — fall through to the live git lookup rather than fail the render over it.
    return null
  }
}

// Local-instance source of the footer's commit info (#98): the current repo's HEAD at render time, via a plain read-only `git` call — the simplest available source when there's no push response to read it from instead (see commitInfoFromPush, the Azure-DevOps-backed equivalent, below), and no `.build-info.json` stamp (above) to read it from instead. `cwd` defaults to the process's own working directory — the gantry repo itself, since local instances live inside it — but is overridable so tests can point this at a scratch repo instead of asserting against whatever commit this repo's HEAD happens to be at test-run time.
//
// A missing/uninitialised git repo must never fail a local render (AB#345 — zip-release
// installs, WI #312, never have one): `git`'s own "not a git repository" failure is caught
// specifically and turned into an "unknown" commit sentinel so the render still succeeds;
// the Document Control table then shows `unknown` in place of a hash. Any other/unexpected
// git failure (e.g. git not installed, a corrupt repo) still rethrows as one clear,
// actionable error rather than git's own raw stderr. `stdio: ['ignore', 'pipe', 'pipe']` is
// deliberate, not just `encoding` — execFileSync's default stdio *inherits* the child's
// stderr straight to this process's own, so without overriding it, git's raw error text
// would still print directly to the terminal even though the thrown JS error's own message
// is clean.
function localHeadCommitInfo({ cwd } = {}) {
  const stamped = buildInfoCommit(cwd)
  if (stamped) return stamped

  const runGit = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    return {
      hash: runGit(['rev-parse', '--short', 'HEAD']),
      date: runGit(['log', '-1', '--format=%cs']),
    }
  } catch (err) {
    const stderr = (err.stderr || err.message || '').toString()
    if (/not a git repository/i.test(stderr)) {
      return { hash: 'unknown', date: null }
    }
    throw new Error(
      `Cannot determine the local git commit for this render's Document Control (was footer) (needs a git checkout with at least one ` +
        `commit at ${cwd ?? 'the current working directory'}): ${stderr.trim()}`
    )
  }
}

// Azure-DevOps-backed source of the Document Control commit info (#98, now relocated): read straight off the push response Azure DevOps already returns when the artefact is pushed (see renderArtefactFromAzureDevOps below) — never a separate call — since that response already carries the exact commit the push just created, before this function's caller re-pushes the artefact a second time with the Document Control block naming it.
function commitInfoFromPush(push) {
  const commit = push?.commits?.[0]
  if (!commit?.commitId) {
    throw new Error('Azure DevOps push response did not include a commit — cannot build the Document Control commit info')
  }
  // Real Azure DevOps push responses always carry at least one of these (committer/author date on the commit, or the push's own date) — this is a fail-loudly guard against a malformed/unexpected response, not a path any real render is expected to hit. Reusing the commit hash as a fake "date" here would be a strictly worse failure mode: a footer that silently claims a date has no meaningful value.
  const isoDate = commit.committer?.date ?? commit.author?.date ?? push.date
  if (!isoDate) {
    throw new Error(
      `Azure DevOps push response for commit ${commit.commitId} had no committer/author/push date — cannot build the Document Control commit info`
    )
  }
  return {
    hash: commit.commitId.slice(0, 7),
    fullHash: commit.commitId,
    date: isoDate.slice(0, 10),
  }
}

// WI260 — fetch repo assets for a workspace-backed render before invoking Pandoc. Mirrors lib/server.js's asset listing but writes locally so pandoc can embed. Shared by both pushes of the two-push flow. No-op when the assets folder doesn't exist yet.
async function fetchRepoAssetsForRender(slug, azureDevOps, instancesDir) {
  const branch = azureDevOps.branch ?? 'main'
  const client = resolveContentStore('azure-devops', azureDevOps)
  const assetsPath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets`
  let items = await client.listFolder(assetsPath, { branch })
  let files = items.filter((item) => !item.isFolder)
  // Also include assets that exist on main but not yet on the stage branch (branch created before asset was committed there) — prefer branch version when both exist.
  if (branch !== 'main') {
    const mainItems = await client.listFolder(assetsPath, { branch: 'main' })
    const branchPaths = new Set(files.map((f) => f.path))
    for (const item of mainItems) {
      if (!item.isFolder && !branchPaths.has(item.path)) {
        files.push({ ...item, _branch: 'main' })
      }
    }
  }
  if (files.length === 0) return
  const localAssetsDir = join(instancesDir, slug, 'assets')
  mkdirSync(localAssetsDir, { recursive: true })
  for (const item of files) {
    const filename = item.path.split('/').pop()
    const fetchBranch = item._branch ?? branch
    const content = await client.getFileContent(item.path, { branch: fetchBranch })
    const ext = extname(filename).toLowerCase()
    const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg'
    let buffer
    const cleaned = content.replace(/\s/g, '')
    const looksBase64 = cleaned.length % 4 === 0 && cleaned.length > 0 && /^[A-Za-z0-9+/=]+$/.test(cleaned)
    if (isImage && looksBase64) {
      try {
        buffer = Buffer.from(content, 'base64')
        // Validate round-trip to avoid misclassifying short text as base64
        if (buffer.toString('base64').replace(/\s/g, '') !== cleaned) {
          buffer = Buffer.from(content, 'utf8')
        }
      } catch {
        buffer = Buffer.from(content, 'utf8')
      }
    } else {
      buffer = Buffer.from(content, 'utf8')
    }
    writeFileSync(join(localAssetsDir, filename), buffer)
  }
}

// #16 — the GitHub twin of fetchRepoAssetsForRender above, for a render against a GitHub-backed
// instance: same "materialise the repo's assets/ dir onto local disk before Pandoc runs" job, but
// simpler — no stage-branch-vs-main union fetch, since GitHub stage branches (#12) don't exist yet and
// every GitHub read/write here targets `main` (or `options.github.branch`, once #12 lands) directly.
async function fetchGitHubAssetsForRender(slug, github, instancesDir) {
  const branch = github.branch ?? 'main'
  const client = resolveContentStore('github', github)
  const items = await client.listFolder(githubAssetsDir(slug), { branch })
  const files = items.filter((item) => !item.isFolder)
  if (files.length === 0) return
  const localAssetsDir = join(instancesDir, slug, 'assets')
  mkdirSync(localAssetsDir, { recursive: true })
  for (const item of files) {
    const filename = item.path.split('/').pop()
    const bytes = await client.getFileBytes(item.path, { branch })
    writeFileSync(join(localAssetsDir, filename), bytes)
  }
}

// #31 — the GitLab twin of fetchGitHubAssetsForRender above: same "materialise the repo's assets/ dir
// onto local disk before Pandoc runs" job, same simplicity rationale (no GitLab stage branches yet,
// #29, so every read here targets `main` or `options.gitlab.branch` directly).
async function fetchGitLabAssetsForRender(slug, gitlab, instancesDir) {
  const branch = gitlab.branch ?? 'main'
  const client = resolveContentStore('gitlab', gitlab)
  const items = await client.listFolder(gitlabAssetsDir(slug), { branch })
  const files = items.filter((item) => !item.isFolder)
  if (files.length === 0) return
  const localAssetsDir = join(instancesDir, slug, 'assets')
  mkdirSync(localAssetsDir, { recursive: true })
  for (const item of files) {
    const filename = item.path.split('/').pop()
    const bytes = await client.getFileBytes(item.path, { branch })
    writeFileSync(join(localAssetsDir, filename), bytes)
  }
}

// #43 — the Atlassian (Bitbucket-backed) twin of fetchGitLabAssetsForRender above: same "materialise
// the repo's assets/ dir onto local disk before Pandoc runs" job, same simplicity rationale (no
// per-stage-branch wiring into this render path yet, mirroring GitLab's own pre-#33/#34 state) — every
// read here targets `main` or `options.atlassian.branch` directly. Only ever talks to Bitbucket, never
// Jira — an instance's assets are content-store data (ADR-0042).
async function fetchAtlassianAssetsForRender(slug, atlassian, instancesDir) {
  const branch = atlassian.branch ?? 'main'
  const client = resolveContentStore('atlassian', atlassian)
  const items = await client.listFolder(atlassianAssetsDir(slug), { branch })
  const files = items.filter((item) => !item.isFolder)
  if (files.length === 0) return
  const localAssetsDir = join(instancesDir, slug, 'assets')
  mkdirSync(localAssetsDir, { recursive: true })
  for (const item of files) {
    const filename = item.path.split('/').pop()
    const bytes = await client.getFileBytes(item.path, { branch })
    writeFileSync(join(localAssetsDir, filename), bytes)
  }
}

// Compiles the artefact's template against already-fetched instance/module data and (unless `dryRun`) converts the result to a .docx via pandoc. Shared by the local and Azure-DevOps-backed paths below — they differ only in *how* `instance`/`modules` were fetched, never in this part. Rendered output always lands under the local `instancesDir`/`slug`/`out` first — pandoc needs a real file on disk to write to, and for a local instance that local copy is the whole story. For an Azure-DevOps-backed instance it's a build scratch step only: `renderArtefactFromAzureDevOps` (below) pushes the resulting `.docx` on to the Azure DevOps repo afterwards, so the artefact ends up living alongside the instance data it was rendered from, not stranded on whichever machine `gantry serve` happens to be running on.
function compileArtefact(slug, artefact, instance, modules, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  // Version-aware: definition carries its own resolved directory (definitions/<id>/<n>)
  const definitionForTemplate = options.definition
  const templateBase = definitionForTemplate?.definitionDir ?? join(definitionsDir, instance.definition)
  const templatePath = join(templateBase, artefact.template)
  const templateSource = readFileSync(templatePath, 'utf8')
  // views (WI #273 / R2): scope the renderer to this definition's own directory so a
  // template can `include('templates/_partial.md.tmpl', …)` to pull in blocks shared
  // between artefacts (Introduction optional fields, recovery-plan detail, …) instead
  // of copy-pasting them. Per-render because the directory varies by definition/version.
  const templateEta = eta.withConfig({ views: resolve(templateBase) })
  const compiled = templateEta.renderString(templateSource, { instance, modules }).replace(/\n{3,}/g, '\n\n')
  // A module field's markdown may hand-type or have inserted (#80) an `asset:<id>` reference at any paragraph position — resolve it to the asset's real file in the instance's assets/ directory now, in place, so pandoc embeds the actual image at that same position rather than leaving a broken/literal "asset:<id>" link in the compiled artefact.
  let resolved = resolveAssetFileRefs(compiled, slug, { instancesDir })
  // WI260 repo-as-asset-store: for workspace-backed instances also rewrite relative `../assets/<name>` / `assets/<name>` refs to the absolute local path where fetchRepoAssetsForRender/fetchGitHubAssetsForRender materialised the repo files, so pandoc embeds them the same way it does `asset:<id>` for local instances. Local-instance path stays byte-for-byte unchanged (guarded by options.azureDevOps/options.github).
  if (options.azureDevOps) {
    resolved = resolveRepoAssetFileRefs(resolved, slug, { instancesDir })
  } else if (options.github) {
    // #16 — a GitHub repo-asset has no separate `source` to cite (unlike the asset:<id> manifest
    // convention above), so its citation is the committed file's own GitHub web address, honouring
    // any enterprise baseUrl (lib/githubFileUrl.js).
    resolved = resolveRepoAssetFileRefs(resolved, slug, {
      instancesDir,
      citationUrl: (filename) => githubArtefactFileUrl(options.github, `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets/${filename}`, options.github.branch ?? 'main'),
    })
  } else if (options.gitlab) {
    // #31 — the GitLab twin of the GitHub branch above: same "the committed file cites itself" logic,
    // honouring any self-hosted baseUrl (lib/gitlabFileUrl.js).
    resolved = resolveRepoAssetFileRefs(resolved, slug, {
      instancesDir,
      citationUrl: (filename) => gitlabArtefactFileUrl(options.gitlab, `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets/${filename}`, options.gitlab.branch ?? 'main'),
    })
  } else if (options.atlassian) {
    // #43 — the Atlassian (Bitbucket-backed) twin of the GitLab branch above: same "the committed file
    // cites itself" logic, over Bitbucket Cloud's own fixed web host (lib/atlassianFileUrl.js — no
    // self-hosted baseUrl to honour, ADR-0042: Atlassian v1 is Cloud-only).
    resolved = resolveRepoAssetFileRefs(resolved, slug, {
      instancesDir,
      citationUrl: (filename) => atlassianArtefactFileUrl(options.atlassian, `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets/${filename}`, options.atlassian.branch ?? 'main'),
    })
  }

  // --- Document Control + Review & sign-off injection (WI233) ---
  // Pipeline-injected for *every* definition, not just "design" — this is what
  // carries the commit hash/date that appendFooter() used to, so no definition
  // loses its commit reference. Driven by `options.reviewSummary` (assembled
  // by lib/server.js's render routes from reviewStatus/stageReview/stageApproval
  // + work-item/PR data); compileArtefact itself stays pure with no new network
  // calls or reviewStatus imports.
  // Fallback for callers that didn't build a reviewSummary (CLI, tests, or a
  // non-design definition): synthesize a minimal one from the commit info
  // already available so the commit hash/date still lands in the Document
  // Control table.
  let reviewSummary = options.reviewSummary ?? null
  if (!reviewSummary && options.commit) {
    const stageForArtefact = definitionForTemplate?.stages?.find((s) => s.gate === artefact.gate) ?? null
    const versionStr = `${definitionForTemplate.id} v${definitionForTemplate.version} · ${stageForArtefact ? stageForArtefact.title : artefact.title}`
    const commitUrlStr = options.commit.fullHash
      ? options.azureDevOps
        ? commitUrl(options.azureDevOps, options.commit.fullHash)
        : options.github
          ? githubCommitUrl(options.github, options.commit.fullHash)
          : options.gitlab
            ? gitlabCommitUrl(options.gitlab, options.commit.fullHash)
            : options.atlassian
              ? atlassianCommitUrl(options.atlassian, options.commit.fullHash)
              : undefined
      : undefined
    reviewSummary = {
      version: versionStr,
      stageTitle: stageForArtefact?.title ?? artefact.title,
      date: options.commit.date,
      commit: { hash: options.commit.hash, url: commitUrlStr, date: options.commit.date },
      gateStatus: 'Draft',
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  } else if (reviewSummary && options.commit) {
    // Merge commit info from the render's own commit source (localHeadCommitInfo
    // or commitInfoFromPush) when the server-built summary didn't yet know it.
    const commitHash = options.commit.hash
    const commitUrlStr = options.commit.fullHash
      ? options.azureDevOps
        ? commitUrl(options.azureDevOps, options.commit.fullHash)
        : options.github
          ? githubCommitUrl(options.github, options.commit.fullHash)
          : options.gitlab
            ? gitlabCommitUrl(options.gitlab, options.commit.fullHash)
            : options.atlassian
              ? atlassianCommitUrl(options.atlassian, options.commit.fullHash)
              : undefined
      : undefined
    if (!reviewSummary.commit?.hash && commitHash) {
      reviewSummary = {
        ...reviewSummary,
        commit: { hash: commitHash, url: commitUrlStr ?? reviewSummary.commit?.url, date: options.commit.date },
      }
    } else if (commitUrlStr && !reviewSummary.commit?.url) {
      reviewSummary = { ...reviewSummary, commit: { ...reviewSummary.commit, url: commitUrlStr } }
    }
    if (!reviewSummary.date && options.commit.date) {
      reviewSummary = { ...reviewSummary, date: options.commit.date }
    }
    if (!reviewSummary.commit?.date && options.commit.date) {
      reviewSummary = { ...reviewSummary, commit: { ...reviewSummary.commit, date: options.commit.date } }
    }
  } else if (reviewSummary && !reviewSummary.rows?.length) {
    reviewSummary = {
      ...reviewSummary,
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  } else if (!reviewSummary && definitionForTemplate) {
    // No commit yet (e.g. Azure-DevOps dry-run) — still inject a block so the
    // artefact never loses its commit reference site; commit cell just stays empty.
    const stageForArtefact = definitionForTemplate?.stages?.find((s) => s.gate === artefact.gate) ?? null
    const versionStr = `${definitionForTemplate.id} v${definitionForTemplate.version} · ${stageForArtefact ? stageForArtefact.title : artefact.title}`
    reviewSummary = {
      version: versionStr,
      stageTitle: stageForArtefact?.title ?? artefact.title,
      date: new Date().toISOString().slice(0, 10),
      commit: { hash: '', url: '', date: '' },
      gateStatus: 'Draft',
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  }

  const definitionDirForPartial = definitionForTemplate?.definitionDir
  // #150 (ADR-0049): an Artefact that sets `document-control: false` — a document written for
  // someone outside the organisation — gets neither table; its H1 and body stay as compiled. Every
  // render path (local, each Provider's two pushes, WASM prepare, CLI, stage-approval auto-render)
  // compiles through here, so this one check covers them all. The block's contents above are still
  // assembled so the commit/review plumbing is unchanged for every other Artefact.
  // #194 (ADR-0052): the same holds for the opt-in cover page and table of contents, which
  // assembleFrontMatter places around Document Control.
  // #150 (ADR-0049): no tables for an Artefact that opts out; none either when there is no summary
  // to print or the Definition ships an empty `_documentControl.md.tmpl`.
  const documentControl = artefact.documentControl === false || !reviewSummary ? '' : buildDocumentControlMarkdown(reviewSummary, definitionDirForPartial)
  const markdown = assembleFrontMatter(resolved, artefact, instance, modules, reviewSummary, documentControl)

  // Artefact-aware reference doc resolution (WI153): the `design` definition's
  // five artefacts previously shared one `reference.docx` that was built
  // directly from the TAC HLD source template, so every artefact inherited
  // HLD's hardcoded footer "Technical Architecture Committee – High Level
  // Solution Design". Resolve by artefact first (`reference-<artefact>.docx`),
  // falling back to the definition-level `reference.docx` for definitions
  // that have not yet split their template per artefact.
  // Current footer policy per WI153 triage:
  //  - hld: keeps TAC footer (correct for that artefact)
  //  - soap / as-built: no committee-specific footer (defensible, matches
  //    domain docs — SOAP is Business Case, as-built is "for noting")
  //  - sad / ssad: placeholder (no committee text) until the ARB/TAC vs
  //    Design Authority decision is made — distinct files exist so that
  //    decision can land without further code changes.
  //
  // Resolved unconditionally (even on a dry run, WI314) — the WASM Pandoc render path
  // (web/lib/pandocWasm.js) needs to know which reference-doc file to fetch and inject
  // into its own virtual filesystem before it can convert, and dryRun is exactly the mode
  // the server-side "compile" helpers (lib/localWorkspace.js, lib/server.js's Azure-DevOps
  // wasm-prepare route) use to hand that markdown + reference-doc identity to the browser
  // without ever invoking native pandoc themselves. Resolved before the Word conversion's
  // markdown below, whose filled-in table of contents (#206) reads the headings' numbering from it.
  const templateBaseForRef = definitionForTemplate?.definitionDir ?? join(definitionsDir, instance.definition)
  const artefactReferenceDoc = join(templateBaseForRef, 'templates', `reference-${artefact.id}.docx`)
  const defaultReferenceDoc = join(templateBaseForRef, 'templates', 'reference.docx')
  const referenceDoc = existsSync(artefactReferenceDoc) ? artefactReferenceDoc : defaultReferenceDoc
  const referenceDocPath = existsSync(referenceDoc) ? referenceDoc : null

  // #195 (ADR-0053): the markdown the Word document is converted from. For an Artefact that opts in
  // (`diagram-captions: true`), every diagram is numbered in one sequence and given its
  // "Diagram N. <title>" caption; every other Artefact — design v1 and v2 among them — is converted
  // from exactly the markdown it always was. `markdown` itself stays as authored: it is the exported
  // `.md`, which keeps each fence's caption syntax intact (and its source, as ADR-0030 already had
  // it). Numbering here, in the one compile step, is what keeps the native / CLI conversion below
  // and the browser's WASM conversion (handed `docxMarkdown` by every prepare route) numbering the
  // same diagrams the same way. Only a real `true` counts, as `document-control` honours only `false`.
  // #197 (ADR-0056): a heading marked `.unnumbered` keeps its number out of Word too — but only where
  // a Definition asked for that. An Artefact that opts into any of design v3's Word front matter
  // (`cover-page`, `table-of-contents` or `diagram-captions`) has every such heading rewritten. Any
  // other Artefact — design v1 and v2 and recruitment-onboarding among them — has only its Document
  // Control partial's rewritten (theirs mark nothing), and an author's own `{.unnumbered}` heading
  // reaches Pandoc exactly as it always did, so its Word text is the `.md`'s, byte for byte.
  const wordFrontMatter = artefact.coverPage === true || artefact.tableOfContents === true || artefact.diagramCaptions === true
  // #206: with `table-of-contents: true`, the TOC field is filled in with the headings of exactly
  // this Markdown, numbered as the reference document resolved above numbers them.
  const docxMarkdown = wordFrontMatter
    ? prefillTableOfContents(unnumberedHeadingsForWord(artefact.diagramCaptions === true ? numberDiagrams(markdown) : markdown), referenceDocPath)
    : assembleFrontMatter(resolved, artefact, instance, modules, reviewSummary, documentControl && unnumberedHeadingsForWord(documentControl, { document: markdown }))

  const outDir = join(instancesDir, slug, 'out')
  // WI226: output basename is "<Instance name> - <Full artefact title>", not
  // "<artefactId>" — unless the artefact declares its own `filename:` pattern
  // (#87, ADR-0045), in which case it names itself from this same instance's
  // module data instead. The reference-doc lookup above stays keyed on artefact.id.
  const basename = renderedArtefactBasename(
    instanceDisplayName(instance),
    artefact.title,
    filenamePatternContext(artefact, modules, instance.slug)
  )
  const mdPath = join(outDir, `${basename}.md`)
  const docxPath = join(outDir, `${basename}.docx`)


  // WI #359 — which output(s) a render actually persists. `'docx'` (the default, and every
  // caller that predates this option) produces only the `.docx`; `'md'` produces only the
  // `.md`. `markdown` (the compiled string) is always returned regardless, so a caller that
  // only needs the text never has to read either file back off disk. `mdPath`/`docxPath` on
  // the returned object are `null` when that format wasn't produced this render — a signal to
  // callers, not just an unwritten file — so nothing downstream can accidentally read a file
  // that (by design) was never created.
  const format = options.format === 'md' ? 'md' : 'docx'

  if (options.dryRun) {
    return { markdown, docxMarkdown, mdPath, docxPath, basename, referenceDocPath, dryRun: true, format }
  }

  // WI #360 — a server-hosted (directory-backed) instance's render is delivered straight to
  // the browser as a download instead of being persisted under the instance's own `out/`
  // directory at all. `deliverToClient` never touches `outDir` — not even to create it — and
  // for `'docx'` the final file is produced in a scratch temp location, read back into memory,
  // and removed, exactly like the existing scratch `.md` handling below does for the
  // docx-only case. Azure-DevOps-backed and local-workspace (ADR-0029) rendering never pass
  // this option and are completely unaffected.
  const deliverToClient = options.deliverToClient === true

  if (format === 'md') {
    if (deliverToClient) {
      return { markdown, mdPath: null, docxPath: null, basename, referenceDocPath, dryRun: false, format }
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(mdPath, markdown)
    return { markdown, mdPath, docxPath: null, basename, referenceDocPath, dryRun: false, format }
  }

  // format === 'docx': pandoc needs a real `.md` file to convert from, but that file is only
  // ever an implementation detail of producing the `.docx` here — it must not land in the
  // instance's own `out/` directory (that would silently "persist" markdown a docx-only render
  // was never asked to keep). Compile it to a scratch temp file instead, convert, then remove
  // the scratch file — `outDir` never holds a `.md` for a docx-only render.
  const scratchMdPath = join(tmpdir(), `gantry-render-${randomUUID()}.md`)
  // #198 (ADR-0055): `gantry render` hands over this same `docxMarkdown` with its Mermaid blocks
  // already drawn (`renderArtefactWithDiagrams` below): image references to PNGs in a scratch
  // directory, which Pandoc finds through `--resource-path`. Every other caller converts
  // `docxMarkdown` itself, as before.
  writeFileSync(scratchMdPath, options.drawnDiagrams?.markdown ?? docxMarkdown)
  // WI #360: when delivering to the client, the `.docx` itself is also just a scratch file —
  // never written into `outDir` — read back into memory and removed once its bytes are in hand.
  const targetDocxPath = deliverToClient ? join(tmpdir(), `gantry-render-${randomUUID()}.docx`) : docxPath
  if (!deliverToClient) {
    mkdirSync(outDir, { recursive: true })
  }
  try {
    const args = ['-f', 'markdown', '-t', 'docx']
    if (referenceDocPath) {
      args.push('--reference-doc', referenceDocPath)
    }
    // WI260: for workspace-backed, also pass --resource-path so relative image refs that weren't rewritten (or bonus asset:<id> resolved against repo) still resolve against the materialised assets dir. Local path unchanged.
    const resourcePaths = []
    if (options.azureDevOps || options.github) {
      const assetsDir = join(instancesDir, slug, 'assets')
      if (existsSync(assetsDir)) {
        resourcePaths.push(resolve(assetsDir))
      }
    }
    // #198: the drawn Mermaid PNGs, by the bare names the browser export gives them. Pandoc's
    // default resource path, the working directory, is kept ahead of them.
    if (options.drawnDiagrams) {
      resourcePaths.push('.', resolve(options.drawnDiagrams.dir))
    }
    if (resourcePaths.length) {
      args.push('--resource-path', resourcePaths.join(delimiter))
    }
    args.push('-o', targetDocxPath, scratchMdPath)
    execFileSync('pandoc', args)
    if (deliverToClient) {
      const docxBytes = readFileSync(targetDocxPath)
      return { markdown, docxMarkdown, mdPath: null, docxPath: null, docxBytes, basename, referenceDocPath, dryRun: false, format }
    }
  } finally {
    rmSync(scratchMdPath, { force: true })
    if (deliverToClient) rmSync(targetDocxPath, { force: true })
  }

  return { markdown, docxMarkdown, mdPath: null, docxPath, basename, referenceDocPath, dryRun: false, format }
}

// WI #367 — the browser-side (pandoc-wasm) render leg's counterpart to the `--resource-path` the
// native leg gives the `pandoc` subprocess.
//
// `resolveAssetFileRefs`/`resolveRepoAssetFileRefs` rewrite every `asset:<id>` and `assets/<name>`
// reference to an **absolute path on the machine running `gantry serve`**, which is exactly what the
// native leg needs and exactly what the WASM leg cannot use: pandoc-wasm runs in the browser against
// a virtual filesystem, so an absolute server path resolves to nothing and Pandoc drops the image
// silently — no warning, no error, just a .docx with the picture missing. Mermaid diagrams survived
// only because web/lib/mermaid.js renders those in the browser and hands Pandoc the PNG bytes
// directly; nothing was doing the same for an author's own uploaded images.
//
// This reads each referenced file server-side and rewrites the reference to a bare virtual filename,
// so the prepare route can ship the bytes alongside the markdown and the browser can put them in
// Pandoc's virtual filesystem under exactly those names. A reference that doesn't resolve to a real
// file on disk is left untouched — it was already not going to embed, and mangling it here would
// only make the eventual output harder to explain.
//
// @returns {{ markdown: string, files: Record<string, string> }} rewritten markdown, and the
//   referenced files' bytes as base64 keyed by the virtual filename the markdown now points at.
export function externaliseImagesForWasm(markdown) {
  const files = {}
  const virtualNameByPath = new Map()
  const rewritten = (markdown ?? '').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, rawTarget) => {
    const target = rawTarget.trim().replace(/^<(.*)>$/, '$1')
    if (!isAbsolute(target)) return match
    let bytes
    try {
      if (!statSync(target).isFile()) return match
      bytes = readFileSync(target)
    } catch {
      return match
    }
    // One virtual name per distinct source path — the same image referenced twice is shipped once.
    let name = virtualNameByPath.get(target)
    if (!name) {
      name = `gantry-asset-${virtualNameByPath.size + 1}${extname(target).toLowerCase()}`
      virtualNameByPath.set(target, name)
      files[name] = bytes.toString('base64')
    }
    return `![${alt}](${name})`
  })
  return { markdown: rewritten, files }
}

/**
 * `gantry render <slug> <artefactId>`: compiles the artefact's template against the instance's required module data, then (unless `dryRun`) converts the resulting Markdown to a .docx via pandoc.
 *
 * With `options.azureDevOps` supplied, reads the instance/module data from that Azure DevOps repo instead of the local filesystem (see renderArtefactFromAzureDevOps below) and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 */
export function renderArtefact(slug, artefactId, options = {}) {
  if (options.azureDevOps) {
    return renderArtefactFromAzureDevOps(slug, artefactId, options)
  }
  if (options.github) {
    return renderArtefactFromGitHub(slug, artefactId, options)
  }
  if (options.gitlab) {
    return renderArtefactFromGitLab(slug, artefactId, options)
  }
  if (options.atlassian) {
    return renderArtefactFromAtlassian(slug, artefactId, options)
  }

  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = readModule(definition, slug, moduleId, { instancesDir }).fields
  }

  // #98: sourced via a plain `git` call against this repo's own current HEAD — never a network call — since a local instance's render never pushes anything the footer could otherwise be sourced from.
  const commit = options.commit ?? localHeadCommitInfo({ cwd: options.repoDir })
  const result = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  // #88 (ADR-0045 §7): only for a real, persisted local render — a dry run writes nothing, and
  // deliverToClient (WI #360) never creates `out/` at all, so both leave mdPath/docxPath null and
  // there is nothing for a manifest to track.
  if (!result.dryRun) {
    const persistedPath = result.docxPath ?? result.mdPath
    if (persistedPath) {
      applyLocalRenderManifest(join(instancesDir, slug, 'out'), artefact.id, `${result.basename}.${result.format}`)
    }
  }
  return result
}

/**
 * `gantry render`'s own path (#198, docs/adr/0055): `renderArtefact` for a local instance, with
 * each Mermaid diagram drawn into the `.docx` as the browser export draws it, in the optional
 * headless Chromium (`drawMermaidInChromium`, lib/mermaidChromium.js). Without Chromium the render
 * is exactly `renderArtefact`'s, diagrams left as source, and `warning` says how to install it.
 *
 * Drawing is asynchronous and `renderArtefact` is not, so the Artefact is compiled twice: a dry run
 * to get the Word-bound markdown to draw, then the real render, which converts the drawn markdown.
 * Both compile the same files at the same commit, so they agree. A dry run, an `.md`-only render,
 * and a document with no Mermaid block never start Chromium.
 *
 * @returns {Promise<object>} `renderArtefact`'s result, plus `warning` (a string, or null)
 */
export async function renderArtefactWithDiagrams(slug, artefactId, options = {}) {
  if (options.dryRun || options.format === 'md') {
    return { ...renderArtefact(slug, artefactId, options), warning: null }
  }
  const commit = options.commit ?? localHeadCommitInfo({ cwd: options.repoDir })
  const { docxMarkdown } = renderArtefact(slug, artefactId, { ...options, commit, dryRun: true })
  const drawn = await drawMermaidInChromium(docxMarkdown)
  const names = Object.keys(drawn.files)
  if (names.length === 0) {
    return { ...renderArtefact(slug, artefactId, { ...options, commit }), warning: drawn.warning }
  }
  const dir = mkdtempSync(join(tmpdir(), 'gantry-mermaid-'))
  try {
    for (const name of names) writeFileSync(join(dir, name), drawn.files[name])
    const result = renderArtefact(slug, artefactId, { ...options, commit, drawnDiagrams: { markdown: drawn.markdown, dir } })
    return { ...result, warning: drawn.warning }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The Azure-DevOps-backed half of renderArtefact (#86) — the exact same template compile/pandoc step as the local path (compileArtefact above), over instance/module data read from Azure DevOps instead of disk. Unlike the local path, the rendered `.docx` doesn't stop at the local scratch copy: it's pushed on to the same Azure DevOps repo the instance itself lives in, at `gantry-workspace/<slug>/out/<basename>.docx` (WI226; `<basename>` is `<Instance name> - <Full artefact title>` by default, or the artefact's own `filename:` pattern resolved against this instance's content when it declares one — #87, ADR-0045, via `renderedArtefactBasename`) on `options.azureDevOps.branch` (falling through to the client's own `'main'` default when omitted — #118), overwriting any previous render of that artefact on that same branch (the repo's own history is the audit trail — no reason to also keep every past render as a distinct file). A dry run never reaches this — `compileArtefact` returns before writing anything, local or remote.
//
// The footer's commit hash/date (#98) can only be known once Azure DevOps has actually assigned them — neither is predictable client-side before a push completes — so getting an accurate, self-consistent footer into the pushed artefact itself takes two pushes: an initial, footer-less push (identical to this function's pre-#98 behaviour) purely to learn its own resulting commit from the response Azure DevOps already returns (never a separate call/round-trip to look that commit back up some other way), followed by a second push of the same path that overwrites it with the footer naming that commit. The instance/module data itself is only read once — both pushes recompile the one already-fetched `instance`/`modules` data, not two separate reads.
//
// Known, accepted limitation: a commit can never truthfully name its own hash inside its own content (the hash is computed from the content), so the footer names the *first* (content-establishing) push's commit, not the file's own literal newest commit in the repo's history — that's always the second (footer-only) push, one commit later. Anyone reading this file's blame/history in Azure DevOps will see that second commit as the most recent touch to the path. This is also not atomic: if the second push fails after the first succeeds, the repo is left holding the first push's footer-less content with no automatic rollback (see the catch below) — a subsequent successful render corrects it, but nothing does so automatically.

/**
 * Renders every artefact belonging to `stage`'s own gate against an Azure-DevOps-backed instance, committing each rendered .docx to `options.azureDevOps.branch` — the render-on-save half of ADR-0014's "gantry renders the artefact and commits it to the branch automatically on every save throughout the stage, so the PR's diff always includes both the module files and the actual generated document, not just markdown." Saves no longer call this (WI #376, ADR-0034: documents render only when the author clicks Render); lib/stageApproval.js still does, passing its own already-resolved `options.azureDevOps.branch` — never a fresh branch resolution of its own. An artefact whose template doesn't exist yet is skipped up front, the same filter `buildInstanceResponse` (lib/server.js) already applies when deciding which artefacts to *offer* for manual rendering.
 *
 * Never throws for a rendering-specific problem: a module save that already landed must not be reported as failed just because rendering one of its stage's artefacts ran into trouble afterwards. Two distinct non-error outcomes are reported per artefact instead of one another:
 * - `{ artefactId, rendered: false, skipped: true, reason }` — the artefact's own `requires` list names a module that hasn't been saved even once yet (`readModule`'s "no saved data" case). Entirely normal early in a stage — not every module needs to exist before the first save — so this is not a failure, just "nothing to render yet."
 * - `{ artefactId, rendered: false, error }` — a genuine problem (a real Azure DevOps failure, a missing/broken `pandoc`, etc.). Reported so a caller can surface it, but still doesn't stop the loop over the stage's other artefacts, or the module save this followed.
 *
 * `AuthenticationError` is the one exception to "never throws": it propagates immediately, exactly like every other Azure-DevOps-backed aggregation in this codebase (e.g. lib/status.js's `evaluateStageFromAzureDevOps`), so the server's credential-gating layer (`withAzureDevOpsCredential`) can still turn a rejected PAT into the structured "authentication required" response instead of it being silently folded into a 200 as a per-artefact error string.
 *
 * A successful render reports `{ artefactId, rendered: true, azureDevOpsPath, commit }`, mirroring `renderArtefactFromAzureDevOps`'s own successful return shape.
 */
export async function renderStageArtefacts(slug, definition, stage, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const templateBase = definition.definitionDir ?? join(definitionsDir, definition.id)
  const artefacts = definition.artefacts
    .filter((a) => a.gate === stage.gate)
    .filter((a) => existsSync(join(templateBase, a.template)))

  const results = []
  for (const artefact of artefacts) {
    try {
      const result = await renderArtefact(slug, artefact.id, options)
      results.push({ artefactId: artefact.id, rendered: true, azureDevOpsPath: result.azureDevOpsPath, commit: result.commit })
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      if (/has no saved data/.test(err.message)) {
        results.push({ artefactId: artefact.id, rendered: false, skipped: true, reason: err.message })
        continue
      }
      results.push({ artefactId: artefact.id, rendered: false, error: err.message })
    }
  }
  return results
}

// Shared setup for every Azure-DevOps-backed render below (native two-push, and the WI314
// WASM-prepare half): resolves the instance/definition/artefact/module data and materialises
// repo assets, all read-only work with no push of its own. Factored out so the WASM prepare
// path (below) doesn't have to duplicate — and risk drifting from — this exact sequence.
async function bootstrapAzureDevOpsRender(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps })).fields
  }

  // WI260: materialise repo assets before any compile so rewriting and --resource-path can resolve them; also before the second (Document Control) compile which reuses the same dir.
  await fetchRepoAssetsForRender(slug, options.azureDevOps, instancesDir)

  return { instance, definition, artefact, modules }
}

// Shared by both `renderArtefactFromAzureDevOps` and the WI314 `prepareAzureDevOpsWasmRender`
// below: pushes a footer-less draft `.docx` (native pandoc's own first-pass compile, in both
// callers) so Azure DevOps assigns it a commit, then parses that commit's hash/date out of the
// push response (`commitInfoFromPush`) — the only way to learn a commit that can then, itself,
// be truthfully named inside a *second* push's content (#98's constraint: a commit can't name
// its own hash). Factored out so the two callers' identical "the content push already landed;
// here's what's actually live" partial-failure framing can't drift between them.
async function pushDraftAndLearnCommit(client, azureDevOpsPath, artefactId, draftDocxPath, branch) {
  const draftBytes = readFileSync(draftDocxPath)
  const { push } = await client.writeFile(azureDevOpsPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefactId}`,
    branch,
  })
  try {
    return commitInfoFromPush(push)
  } catch (err) {
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefactId} and pushed it to Azure DevOps` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date Document Control: ${err.message}. ` +
        `${azureDevOpsPath} in Azure DevOps still has that Document-Control-less content — re-render to add the Document Control.`
    )
  }
}

async function renderArtefactFromAzureDevOps(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAzureDevOpsRender(slug, artefactId, options)

  const draft = await compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draft.dryRun) return draft

  // WI #359 — the two-push commit-learning trick (see this function's own doc comment above)
  // is format-agnostic: it just needs *some* file's bytes to push, learn a commit from, then
  // push again with that commit named in its content. Works identically whether that file is
  // the `.docx` (the default) or the `.md` (format: 'md') — only the extension and which of
  // `draft.docxPath`/`draft.mdPath` is non-null changes.
  const extension = draft.format === 'md' ? 'md' : 'docx'
  const draftFilePath = draft.format === 'md' ? draft.mdPath : draft.docxPath
  const azureDevOpsPath = azureDevOpsOutPath(slug, instanceDisplayName(instance), artefact.title, extension, filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('azure-devops', options.azureDevOps)
  const branch = options.azureDevOps.branch

  const commit = await pushDraftAndLearnCommit(client, azureDevOpsPath, artefact.id, draftFilePath, branch)

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  const finalBytes = readFileSync(result.format === 'md' ? result.mdPath : result.docxPath)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId: artefact.id,
      path: azureDevOpsPath,
      bytes: finalBytes,
      message: `Render ${artefact.id} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    // The first push already succeeded and is live in Azure DevOps at this point — this failure only affects adding the Document Control, not whether a render happened at all. Surfaced distinctly so a caller (and whoever reads the error) knows the repo is left holding Document-Control-less content at commit ${commit.hash} rather than assuming the render itself failed outright.
    throw new Error(
      `Rendered ${artefact.id} and pushed it to Azure DevOps as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${azureDevOpsPath} in Azure DevOps still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }

  return { ...result, azureDevOpsPath, commit }
}

// #16 — GitHub twin of bootstrapAzureDevOpsRender above: resolves the instance/definition/artefact/
// module data and materialises repo assets over the GitHub content store instead of Azure DevOps.
async function bootstrapGitHubRender(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = await readInstance(slug, { github: options.github })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { github: options.github })).fields
  }

  await fetchGitHubAssetsForRender(slug, options.github, instancesDir)

  return { instance, definition, artefact, modules }
}

// #16 — GitHub twin of pushDraftAndLearnCommit above: same footer-less-draft-push-then-learn-the-commit
// trick, over the GitHub content store. Reuses commitInfoFromPush unchanged — lib/githubClient.js's
// writeFiles shapes its push response (`commits: [{ commitId, committer: { date }, author: { date } }]`)
// to match Azure DevOps' own, precisely so this doesn't need its own parsing logic.
async function pushDraftAndLearnGitHubCommit(client, githubPath, artefactId, draftDocxPath, branch) {
  const draftBytes = readFileSync(draftDocxPath)
  const { push } = await client.writeFile(githubPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefactId}`,
    branch,
  })
  try {
    return commitInfoFromPush(push)
  } catch (err) {
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefactId} and pushed it to GitHub` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date Document Control: ${err.message}. ` +
        `${githubPath} in GitHub still has that Document-Control-less content — re-render to add the Document Control.`
    )
  }
}

// #16 — the GitHub twin of renderArtefactFromAzureDevOps above: same two-push commit-learning render,
// over the GitHub content store instead of Azure DevOps. No stage-branch resolution yet (#12) — every
// push targets `options.github.branch` verbatim (falling through to the client's own `'main'` default
// when the caller didn't supply one), the same "no branch lifecycle yet" contract lib/instance.js's
// #11 read/write paths already follow for a GitHub-backed instance.
async function renderArtefactFromGitHub(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapGitHubRender(slug, artefactId, options)

  const draft = await compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draft.dryRun) return draft

  const extension = draft.format === 'md' ? 'md' : 'docx'
  const draftFilePath = draft.format === 'md' ? draft.mdPath : draft.docxPath
  const githubPath = githubOutPath(slug, instanceDisplayName(instance), artefact.title, extension, filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('github', options.github)
  const branch = options.github.branch

  const commit = await pushDraftAndLearnGitHubCommit(client, githubPath, artefact.id, draftFilePath, branch)

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  const finalBytes = readFileSync(result.format === 'md' ? result.mdPath : result.docxPath)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId: artefact.id,
      path: githubPath,
      bytes: finalBytes,
      message: `Render ${artefact.id} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefact.id} and pushed it to GitHub as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${githubPath} in GitHub still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }

  return { ...result, githubPath, commit }
}

// #31 — GitLab twin of bootstrapGitHubRender above: resolves the instance/definition/artefact/module
// data and materialises repo assets over the GitLab content store instead.
async function bootstrapGitLabRender(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = await readInstance(slug, { gitlab: options.gitlab })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { gitlab: options.gitlab })).fields
  }

  await fetchGitLabAssetsForRender(slug, options.gitlab, instancesDir)

  return { instance, definition, artefact, modules }
}

// #31 — GitLab twin of pushDraftAndLearnGitHubCommit above: same footer-less-draft-push-then-learn-
// the-commit trick, over the GitLab content store. Reuses commitInfoFromPush unchanged —
// lib/gitlabClient.js's writeFiles shapes its push response
// (`commits: [{ commitId, committer: { date }, author: { date } }]`) to match Azure DevOps'/GitHub's
// own, precisely so this doesn't need its own parsing logic.
async function pushDraftAndLearnGitLabCommit(client, gitlabPath, artefactId, draftDocxPath, branch) {
  const draftBytes = readFileSync(draftDocxPath)
  const { push } = await client.writeFile(gitlabPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefactId}`,
    branch,
  })
  try {
    return commitInfoFromPush(push)
  } catch (err) {
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefactId} and pushed it to GitLab` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date Document Control: ${err.message}. ` +
        `${gitlabPath} in GitLab still has that Document-Control-less content — re-render to add the Document Control.`
    )
  }
}

// #31 — the GitLab twin of renderArtefactFromGitHub above: same two-push commit-learning render, over
// the GitLab content store instead. No stage-branch resolution yet (#29, mirroring GitHub's own #12)
// — every push targets `options.gitlab.branch` verbatim (falling through to the client's own `'main'`
// default when the caller didn't supply one), the same "no branch lifecycle yet" contract
// lib/instance.js's #26 read/write paths already follow for a GitLab-backed instance.
async function renderArtefactFromGitLab(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapGitLabRender(slug, artefactId, options)

  const draft = await compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draft.dryRun) return draft

  const extension = draft.format === 'md' ? 'md' : 'docx'
  const draftFilePath = draft.format === 'md' ? draft.mdPath : draft.docxPath
  const gitlabPath = gitlabOutPath(slug, instanceDisplayName(instance), artefact.title, extension, filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('gitlab', options.gitlab)
  const branch = options.gitlab.branch

  const commit = await pushDraftAndLearnGitLabCommit(client, gitlabPath, artefact.id, draftFilePath, branch)

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  const finalBytes = readFileSync(result.format === 'md' ? result.mdPath : result.docxPath)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId: artefact.id,
      path: gitlabPath,
      bytes: finalBytes,
      message: `Render ${artefact.id} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefact.id} and pushed it to GitLab as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${gitlabPath} in GitLab still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }

  return { ...result, gitlabPath, commit }
}

/**
 * WI314 — the Azure-DevOps-hosted half of the client-side WASM Pandoc render path, split
 * across two server round-trips so the browser (not this process) does the actual
 * markdown→docx conversion for the artefact anyone will ever open:
 *
 *  1. `prepareAzureDevOpsWasmRender` (this function) — identical to
 *     `renderArtefactFromAzureDevOps`'s own first push (still native `pandoc`, still
 *     footer-less): that pass is never seen by a user, immediately overwritten by the
 *     second push below, so its only job is learning the commit Azure DevOps assigns
 *     (#98's constraint: a commit can't truthfully name its own hash inside its own
 *     content). Keeping *that* one pass native — rather than round-tripping the browser a
 *     third time for content nobody reads — avoids doubling every WASM render's client-side
 *     conversion count for zero user-visible benefit. It then compiles (dry run, no pandoc)
 *     the *real* artefact — the one with an accurate Document Control commit cell — and
 *     hands its markdown plus the reference-doc bytes back to the caller (lib/server.js's
 *     route) to relay to the browser for conversion.
 *  2. `finishAzureDevOpsWasmRender` (below) — takes the browser's own WASM-converted bytes
 *     for that second compile and pushes them, exactly where the native path's own second
 *     push would have landed them.
 *
 * Never called for the `'native'` engine selection — that keeps calling
 * `renderArtefactFromAzureDevOps` exactly as before, both passes server-side, unconditionally.
 */
export async function prepareAzureDevOpsWasmRender(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAzureDevOpsRender(slug, artefactId, options)

  const draftPass1 = compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draftPass1.dryRun) return draftPass1

  const azureDevOpsPath = azureDevOpsOutPath(slug, instanceDisplayName(instance), artefact.title, 'docx', filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('azure-devops', options.azureDevOps)
  const branch = options.azureDevOps.branch

  const commit = await pushDraftAndLearnCommit(client, azureDevOpsPath, artefact.id, draftPass1.docxPath, branch)

  // Pass 2, dry run: the markdown the browser's own pandoc-wasm module converts into the
  // artefact's real, final bytes — identical to what the native path's own second
  // `compileArtefact` call produces, just without invoking `pandoc` in this process.
  const draftPass2 = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition, dryRun: true })

  return { ...draftPass2, commit, azureDevOpsPath, branch }
}

/**
 * The second half of the WI314 Azure-DevOps WASM render path: pushes the browser's own
 * WASM-converted bytes for `prepareAzureDevOpsWasmRender`'s pass-2 markdown, exactly where
 * `renderArtefactFromAzureDevOps`'s own second (Document-Control) push would land them —
 * same path, same branch, same commit-naming push message.
 *
 * `docxBytes` is a `Buffer`/`Uint8Array` — the caller (lib/server.js's route) is expected to
 * have already decoded it from whatever wire format (base64) the browser sent.
 */
export async function finishAzureDevOpsWasmRender(docxBytes, { azureDevOps, azureDevOpsPath, branch, commit, artefactId }) {
  const client = resolveContentStore('azure-devops', azureDevOps)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId,
      path: azureDevOpsPath,
      bytes: Buffer.from(docxBytes),
      message: `Render ${artefactId} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefactId} and pushed it to Azure DevOps as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${azureDevOpsPath} in Azure DevOps still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }
  return { azureDevOpsPath }
}

/**
 * #16 — the GitHub twin of prepareAzureDevOpsWasmRender above: identical two-pass shape (a
 * footer-less native-pandoc pass 1 purely to learn the commit GitHub assigns, then a dry-run pass 2
 * carrying an accurate Document Control), over the GitHub content store. `'wasm'` is
 * web/lib/renderEngine.js's own *default* engine, so this route is the one a GitHub-backed render
 * actually takes unless a user has switched to `'native'`.
 */
export async function prepareGitHubWasmRender(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapGitHubRender(slug, artefactId, options)

  const draftPass1 = compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draftPass1.dryRun) return draftPass1

  const githubPath = githubOutPath(slug, instanceDisplayName(instance), artefact.title, 'docx', filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('github', options.github)
  const branch = options.github.branch

  const commit = await pushDraftAndLearnGitHubCommit(client, githubPath, artefact.id, draftPass1.docxPath, branch)

  const draftPass2 = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition, dryRun: true })

  return { ...draftPass2, commit, githubPath, branch }
}

/**
 * #16 — the GitHub twin of finishAzureDevOpsWasmRender above: pushes the browser's own
 * WASM-converted bytes for prepareGitHubWasmRender's pass-2 markdown to the same path/branch/commit
 * message its own second push would have used.
 */
export async function finishGitHubWasmRender(docxBytes, { github, githubPath, branch, commit, artefactId }) {
  const client = resolveContentStore('github', github)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId,
      path: githubPath,
      bytes: Buffer.from(docxBytes),
      message: `Render ${artefactId} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefactId} and pushed it to GitHub as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${githubPath} in GitHub still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }
  return { githubPath }
}

/**
 * #31 — the GitLab twin of prepareAzureDevOpsWasmRender/prepareGitHubWasmRender above: identical
 * two-pass shape (a footer-less native-pandoc pass 1 purely to learn the commit GitLab assigns, then
 * a dry-run pass 2 carrying an accurate Document Control), over the GitLab content store.
 */
export async function prepareGitLabWasmRender(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapGitLabRender(slug, artefactId, options)

  const draftPass1 = compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draftPass1.dryRun) return draftPass1

  const gitlabPath = gitlabOutPath(slug, instanceDisplayName(instance), artefact.title, 'docx', filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('gitlab', options.gitlab)
  const branch = options.gitlab.branch

  const commit = await pushDraftAndLearnGitLabCommit(client, gitlabPath, artefact.id, draftPass1.docxPath, branch)

  const draftPass2 = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition, dryRun: true })

  return { ...draftPass2, commit, gitlabPath, branch }
}

/**
 * #31 — the GitLab twin of finishAzureDevOpsWasmRender/finishGitHubWasmRender above: pushes the
 * browser's own WASM-converted bytes for prepareGitLabWasmRender's pass-2 markdown to the same
 * path/branch/commit message its own second push would have used.
 */
export async function finishGitLabWasmRender(docxBytes, { gitlab, gitlabPath, branch, commit, artefactId }) {
  const client = resolveContentStore('gitlab', gitlab)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId,
      path: gitlabPath,
      bytes: Buffer.from(docxBytes),
      message: `Render ${artefactId} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefactId} and pushed it to GitLab as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${gitlabPath} in GitLab still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }
  return { gitlabPath }
}

// #43 — Atlassian (Bitbucket-backed) twin of bootstrapGitLabRender above: resolves the
// instance/definition/artefact/module data and materialises repo assets over the Bitbucket content
// store instead. Only ever talks to Bitbucket, never Jira (ADR-0042: an instance's own content is
// content-store data).
async function bootstrapAtlassianRender(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = await readInstance(slug, { atlassian: options.atlassian })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { atlassian: options.atlassian })).fields
  }

  await fetchAtlassianAssetsForRender(slug, options.atlassian, instancesDir)

  return { instance, definition, artefact, modules }
}

// #43 — Atlassian (Bitbucket-backed) twin of pushDraftAndLearnGitLabCommit above: same
// footer-less-draft-push-then-learn-the-commit trick, over the Bitbucket content store. Reuses
// commitInfoFromPush unchanged — lib/bitbucketClient.js's writeFiles shapes its push response
// (`commits: [{ commitId, committer: { date }, author: { date } }]`) to match every other provider's
// own, precisely so this doesn't need its own parsing logic.
async function pushDraftAndLearnAtlassianCommit(client, atlassianPath, artefactId, draftDocxPath, branch) {
  const draftBytes = readFileSync(draftDocxPath)
  const { push } = await client.writeFile(atlassianPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefactId}`,
    branch,
  })
  try {
    return commitInfoFromPush(push)
  } catch (err) {
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefactId} and pushed it to Bitbucket` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date Document Control: ${err.message}. ` +
        `${atlassianPath} in Bitbucket still has that Document-Control-less content — re-render to add the Document Control.`
    )
  }
}

// #43 — the Atlassian (Bitbucket-backed) twin of renderArtefactFromGitLab above: same two-push
// commit-learning render, over the Bitbucket content store instead. No per-stage branch resolution
// wired into this render path yet (`lib/bitbucketStageBranch.js` exists as its own module — wiring it
// into every render/write path is a later ticket's job, mirroring GitLab's own #33/#34) — every push
// targets `options.atlassian.branch` verbatim (falling through to the client's own `'main'` default
// when the caller didn't supply one).
async function renderArtefactFromAtlassian(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAtlassianRender(slug, artefactId, options)

  const draft = await compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draft.dryRun) return draft

  const extension = draft.format === 'md' ? 'md' : 'docx'
  const draftFilePath = draft.format === 'md' ? draft.mdPath : draft.docxPath
  const atlassianPath = atlassianOutPath(slug, instanceDisplayName(instance), artefact.title, extension, filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('atlassian', options.atlassian)
  const branch = options.atlassian.branch

  const commit = await pushDraftAndLearnAtlassianCommit(client, atlassianPath, artefact.id, draftFilePath, branch)

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  const finalBytes = readFileSync(result.format === 'md' ? result.mdPath : result.docxPath)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId: artefact.id,
      path: atlassianPath,
      bytes: finalBytes,
      message: `Render ${artefact.id} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefact.id} and pushed it to Bitbucket as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${atlassianPath} in Bitbucket still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }

  return { ...result, atlassianPath, commit }
}

/**
 * #43 — the Atlassian (Bitbucket-backed) twin of prepareGitLabWasmRender above: identical two-pass
 * shape (a footer-less native-pandoc pass 1 purely to learn the commit Bitbucket assigns, then a
 * dry-run pass 2 carrying an accurate Document Control), over the Bitbucket content store.
 */
export async function prepareAtlassianWasmRender(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAtlassianRender(slug, artefactId, options)

  const draftPass1 = compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draftPass1.dryRun) return draftPass1

  const atlassianPath = atlassianOutPath(slug, instanceDisplayName(instance), artefact.title, 'docx', filenamePatternContext(artefact, modules, instance.slug))
  const client = resolveContentStore('atlassian', options.atlassian)
  const branch = options.atlassian.branch

  const commit = await pushDraftAndLearnAtlassianCommit(client, atlassianPath, artefact.id, draftPass1.docxPath, branch)

  const draftPass2 = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition, dryRun: true })

  return { ...draftPass2, commit, atlassianPath, branch }
}

/**
 * #43 — the Atlassian (Bitbucket-backed) twin of finishGitLabWasmRender above: pushes the browser's
 * own WASM-converted bytes for prepareAtlassianWasmRender's pass-2 markdown to the same
 * path/branch/commit message its own second push would have used.
 */
export async function finishAtlassianWasmRender(docxBytes, { atlassian, atlassianPath, branch, commit, artefactId }) {
  const client = resolveContentStore('atlassian', atlassian)
  try {
    await pushFinalRenderedArtefact(client, {
      branch,
      artefactId,
      path: atlassianPath,
      bytes: Buffer.from(docxBytes),
      message: `Render ${artefactId} (commit-hash/date Document Control: ${commit.hash})`,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefactId} and pushed it to Bitbucket as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${atlassianPath} in Bitbucket still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }
  return { atlassianPath }
}
