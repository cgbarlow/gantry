// #281 (map #238, decided in #245): citing a **Source document** from module content, and the optional Sources appendix.
//
// A citation is an ordinary Markdown link whose address is `source:<id>`, the id being the fixed id in `sources/manifest.yaml`:
//
//     [Client brief, p. 4](source:client-brief)
//
// #319 (docs/adr/0072): a citation of a code repository may carry the file and the commit it was read at after the id, as a query
// (web/lib/sourceRepository.js): `[orders service](source:billing-api?path=src/orders.ts&commit=3f2a9c1…)`. Every other citation is unchanged.
//
// In the editor the link is clickable and opens the document (web/lib/markdownPreview.js). Word readers usually have no repo access, so the Word render prints it as plain "(Client brief, p. 4)" with no hyperlink. The exported `.md` keeps the link as written, as it keeps a diagram caption's syntax. Only a link is a citation: an image (`![…](source:…)`) is not, and neither is anything inside a code span or a fenced code block.
//
// An Artefact whose Definition sets `source-appendix: true` ends with a Sources list of the documents it cites: each with its title, original filename and upload date (or, #318, for a page fetched from a web address, its address and "retrieved <date>"). A removed document is still listed, marked removed. With the key off (its default) there is no list.
//
// #319: a repository's row gives its title, its web address, its branch and the commits the Artefact cites it at.
//
// Pure (no DOM, no Node built-ins), so the server's compile step (lib/render.js), the Definition checks (lib/definition.js, web/lib/localStatus.js) and the browser (web/app.js) share one copy of the syntax, as web/lib/diagramCaptions.js does.

import { isRepositorySource, normalizeSourceRepository, parseSourceAddress, repositoryCitationQuery, repositoryWebAddress, shortCommit } from './sourceRepository.js'

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// Either a code span (kept as it is) or a citation. A code span's backtick run is matched with its own length, so ``a `b` c`` is one span. The link text may hold backslash escapes (`\]`) and may not span a line.
// #319: the id may be followed by `?path=…&commit=…` (a repository's file and commit).
const CITATION_OR_CODE = /(`+)(?:(?!\1)[\s\S])*?\1(?!`)|(?<!!)\[((?:[^\]\\\n]|\\.)*)\]\(source:([A-Za-z0-9][A-Za-z0-9_-]*)((?:\?[^\s)]*)?)\)/g

/** Runs `change(segment)` over the parts of `markdown` that are not fenced code blocks, and leaves the fenced blocks alone. */
function mapOutsideFences(markdown, change) {
  const lines = String(markdown ?? '').split('\n')
  const out = []
  let prose = []
  let fence = null
  const flush = () => {
    if (prose.length) out.push(change(prose.join('\n')))
    prose = []
  }
  for (const line of lines) {
    const m = FENCE.exec(line)
    if (fence) {
      out.push(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null
    } else if (m) {
      flush()
      out.push(line)
      fence = m[1]
    } else {
      prose.push(line)
    }
  }
  flush()
  return out.join('\n')
}

const unescapeText = (text) => text.replace(/\\(.)/g, '$1')

// A repository citation's `{ path?, commit? }`, from the query after its id.
const locationOf = (id, query) => {
  if (!query) return {}
  const { id: _id, ...rest } = parseSourceAddress(`source:${id}${query}`) ?? {}
  return rest
}

function replaceCitations(markdown, replace) {
  return mapOutsideFences(markdown, (segment) =>
    segment.replace(CITATION_OR_CODE, (match, tick, text, id, query) => (tick ? match : replace({ match, text, id, ...locationOf(id, query) })))
  )
}

/** Every citation in `markdown`, in order: `[{ id, text, path?, commit? }]` with the link text as the author wrote it (escapes removed); `path` and `commit` (#319) only on a repository citation that names them. */
export function findSourceCitations(markdown) {
  const found = []
  replaceCitations(markdown, ({ match, text, id, path, commit }) => {
    found.push({ id, text: unescapeText(text), ...(path ? { path } : {}), ...(commit ? { commit } : {}) })
    return match
  })
  return found
}

/** #319: the commits `markdown` cites document `id` at, in the order first cited. */
export function citedCommits(markdown, id) {
  return [...new Set(findSourceCitations(markdown).filter((c) => c.id === id && c.commit).map((c) => c.commit))]
}

/** The distinct ids `markdown` cites, in the order they are first cited. */
export function citedSourceIds(markdown) {
  return [...new Set(findSourceCitations(markdown).map((c) => c.id))]
}

/**
 * The text the Word document prints for a citation: the link text in parentheses, with no link. An empty link text falls back on `titleFor(id)` (the document's title), then on the id.
 * `markdown` is returned unchanged where it holds no citation.
 */
export function sourceCitationsForWord(markdown, titleFor) {
  return replaceCitations(markdown, ({ text, id }) => {
    const label = text.trim() ? text.trim() : (titleFor?.(id) ?? id)
    return `(${label})`
  })
}

/** The citation to paste into a field for a document: `[Client brief](source:client-brief)`. #319: for a repository, `at` (`{ path, commit }`) names the file and the commit it was read at, and the file is the link's text. */
export function sourceCitationFor(entry, at = {}) {
  const label = at.path ? `${entry?.title ?? entry?.id}, ${at.path}` : (entry?.title ?? entry?.id)
  const title = String(label ?? '').replace(/([\\[\]])/g, '\\$1')
  return `[${title}](source:${entry.id}${repositoryCitationQuery(at)})`
}

/**
 * `markdown` with every citation of document `fromId` pointing at `to` instead (#298, "re-cite"): `[Old brief, p. 4](source:old)` becomes
 * `[New brief](source:new)`. The page or slide is dropped, because it belonged to the old document; the title is the new document's.
 * Citations of other documents, code spans and fenced code are left as they are. Returns the text unchanged where it cites nothing of `fromId`.
 */
export function recitedMarkdown(markdown, fromId, to) {
  return replaceCitations(markdown, ({ match, id }) => (id === fromId ? sourceCitationFor(to) : match))
}

// --- The Definition's `source-appendix` switch ----------------------------------------------------------------------

/**
 * The problem with an Artefact's `source-appendix:` switch, or `null`. A plain boolean, like `diagram-captions` (ADR-0053): anything else ("yes", 1) is reported rather than guessed at. The render honours only a real `true`, so a near-miss leaves the list out, as it always was. `value` is the key read under either spelling (camelCase in memory, kebab-case on disk).
 *
 * @param {string} artefactId
 * @param {unknown} value
 * @returns {{ type: string, message: string }|null}
 */
export function sourceAppendixProblem(artefactId, value) {
  if (value === undefined || typeof value === 'boolean') return null
  return {
    type: 'invalid-source-appendix',
    message: `Artefact "${artefactId}" sets "source-appendix" to ${JSON.stringify(value)} — it must be true or false`,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "4 Mar 2026" from an ISO time, in UTC so the same date prints wherever the render runs; '' for anything unreadable. */
function appendixDate(iso) {
  const date = new Date(iso ?? '')
  return Number.isNaN(date.getTime()) ? '' : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

const cell = (text) => String(text ?? '').replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim()

export const SOURCE_APPENDIX_HEADING = 'Sources'

/**
 * The Sources list an Artefact ends with: a heading and a table of the documents `markdown` cites, in the order they are first cited, each with its title, original filename and upload date. #318: a document fetched from a web address (it has an `origin`) shows the address and "retrieved <date>" in place of the filename and upload date. A removed document is listed too, marked "(removed)". A cited id the manifest does not list is left out (there is nothing to say about it), and `''` is returned when nothing is left, so an Artefact that cites nothing ends exactly as it did.
 *
 * @param {string} markdown  the compiled text of the Artefact
 * @param {{ id: string, title?: string, filename?: string, uploadedAt?: string, removedAt?: string, origin?: { address: string, fetchedAt: string } }[]} entries  the Instance's manifest
 */
export function buildSourceAppendix(markdown, entries) {
  const byId = new Map((entries ?? []).map((e) => [e.id, e]))
  const rows = citedSourceIds(markdown)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((e) => {
      const title = `${cell(e.title || e.id)}${e.removedAt ? ' (removed)' : ''}`
      if (isRepositorySource(e)) {
        // #319: a code repository: its address, its branch and the commits this Artefact cites it at.
        const repository = normalizeSourceRepository(e.repository)
        const commits = citedCommits(markdown, e.id).map(shortCommit)
        return `| ${title} | ${cell(repositoryWebAddress(repository))} | branch ${cell(repository.branch)}${commits.length ? `, commit${commits.length === 1 ? '' : 's'} ${cell(commits.join(', '))}` : ''} |`
      }
      if (typeof e.origin?.address === 'string' && e.origin.address) return `| ${title} | ${cell(e.origin.address)} | retrieved ${appendixDate(e.origin.fetchedAt)} |`
      return `| ${title} | ${cell(e.filename)} | ${appendixDate(e.uploadedAt)} |`
    })
  if (!rows.length) return ''
  return `# ${SOURCE_APPENDIX_HEADING}\n\n| Document | File | Added |\n| --- | --- | --- |\n${rows.join('\n')}\n`
}
