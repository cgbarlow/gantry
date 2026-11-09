// #281 (map #238, decided in #245): citing a **Source document** from module content, and the optional Sources appendix.
//
// A citation is an ordinary Markdown link whose address is `source:<id>`, the id being the fixed id in `sources/manifest.yaml`:
//
//     [Client brief, p. 4](source:client-brief)
//
// #319 (docs/adr/0072): a citation of a code repository may carry the file and the commit it was read at after the id, as a query
// (web/lib/sourceRepository.js): `[orders service](source:billing-api?path=src/orders.ts&commit=3f2a9c1…)`. Every other citation is unchanged.
//
// In the editor the link is clickable and opens the document (web/lib/markdownPreview.js). Word readers usually have no repo access, so the Word render makes it a real footnote reading "Client brief, p. 4", with no hyperlink (#351, sourceCitationsForWord below), and a later citation of the same reference shows that footnote's number (#353). The exported `.md` keeps the link as written, as it keeps a diagram caption's syntax. Only a link is a citation: an image (`![…](source:…)`) is not, and neither is anything inside a code span or a fenced code block.
//
// An Artefact whose Definition sets `source-appendix: true` ends with a Sources list of the documents it cites: each with its title, original filename and upload date (or, #318, for a page fetched from a web address, its address and "retrieved <date>"). A removed document is still listed, marked removed. With the key off (its default) there is no list.
//
// #360: a cited document a newer one replaces (**This replaces…**, **Fetch again**) is marked "(replaced by <newer title>)", the newer title being its newest replacement's by the rule the Source documents panel uses (web/lib/sourceDocuments.js's replacedByMap). It reads "(replaced by a newer copy)" when the two share a title, as a page fetched again does. Once nothing cites it, it drops off the list like any other.
//
// #319: a repository's row gives its title, its web address, its branch and the commits the Artefact cites it at.
//
// Pure (no DOM, no Node built-ins), so the server's compile step (lib/render.js), the Definition checks (lib/definition.js, web/lib/localStatus.js) and the browser (web/app.js) share one copy of the syntax, as web/lib/diagramCaptions.js does.

import { replacedByMap } from './sourceDocuments.js'
import { isRepositorySource, normalizeSourceRepository, parseSourceAddress, repositoryCitationQuery, repositoryWebAddress, shortCommit } from './sourceRepository.js'

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// A code span as Pandoc reads one: a run of backticks closed by the next run of exactly as many, so ``a `b` c`` is one span.
// #353: as in Pandoc, a span ends with its paragraph (a blank line), and a run with no run to close it is matched alone, being
// the backticks Pandoc prints as they are, so what comes after it is read on (one stray backtick in "Don`t" is no span).
const CODE_SPAN = String.raw`(\`+)(?:(?:[^\`\n]|\n(?![ \t]*\n)|\`+(?!\`))*?(?<!\`)\1(?!\`))?`

// Either a code span or a stray run of backticks (group 1; kept as they are), an escaped character (kept as it is), or a
// citation. The link text may hold backslash escapes (`\]`) and may not span a line.
// #319: the id may be followed by `?path=…&commit=…` (a repository's file and commit).
// #351: a `[` in the text must be escaped or closed within it (`[see [x]](source:a)`), as in Pandoc, so a bracket of the writer's
// before a citation, `[[a](source:a); [b](source:b)]`, is not taken for part of its text.
const CITATION_OR_CODE = new RegExp(
  CODE_SPAN + String.raw`|\\[\s\S]|(?<!!)\[((?:[^[\]\\\n]|\\.|\[(?:[^[\]\\\n]|\\.)*\])*)\]\(source:([A-Za-z0-9][A-Za-z0-9_-]*)((?:\?[^\s)]*)?)\)`,
  'g'
)

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
    segment.replace(CITATION_OR_CODE, (match, tick, text, id, query) => (id === undefined ? match : replace({ match, text, id, ...locationOf(id, query) })))
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

// --- What Word prints (#351) ----------------------------------------------------------------------------------------
//
// A citation in running text becomes a real Word footnote. The compile step writes a Pandoc inline note, `^[words]`, and Pandoc
// makes it a native footnote: numbered by Word, in the reference document's Footnote Text and Footnote Reference styles (Word's
// own where it has none). The note holds the citation's words, and for a code repository the file and the short commit it was
// read at. The mark goes against the word before it, and brackets that hold nothing but citations (and the separators between
// them) go too, so "built from it ([operating model](source:operating-model))." reads "built from it¹.".
//
// A citation that labels a list item or a table cell (the first thing in it, as in a References Field) already is the
// reference, so it prints its words with no note. So does one in a heading, where a note would also land in the table of
// contents.

// A Word Field tag (#301, lib/wordFieldTags.js) is a raw bookmark or a Span's opening `[`: neither is something in the item.
const RAW_BOOKMARK = /`<w:bookmark(?:Start|End) [^`]*\/>`\{=openxml\}/g
// What may come before a list item's or a table cell's first words: spaces, emphasis, and a Field tag's Span.
const OPENERS = String.raw`(?:\*\*|__|\*|_|\[|[ \t])*`
const LIST_ITEM_LABEL = new RegExp(String.raw`^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?${OPENERS}$`)
const CELL_LABEL = new RegExp(String.raw`(?:^|(?<!\\)\|)${OPENERS}$`)
const TABLE_DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/
// The start of a line that a note's mark must not be pulled against: a list bullet, a quote, a table's pipe, a definition's
// `:` or `~`.
const BLOCK_START = /^[ \t]*(?:>[ \t]*)*(?:[-*+:~]|\d{1,9}[.)])?[ \t]*$|(?<!\\)\|[ \t]*$/
// What may sit between two citations in one bracket.
const SEPARATOR = /^[ \t]*[;,]?[ \t]*$/

// Words that are not Markdown (a document's title, a repository's file and commit) with everything Pandoc could read as markup
// escaped, so a `]`, `^` or `*` in them is printed as itself.
const escapeNote = (text) => text.replace(/[\\`*_[\]^~<>$@|&#{}]/g, '\\$&')
// The author's link text keeps its Markdown, as it does where it labels an item: its brackets are already closed or escaped,
// and only a `^` is escaped, which Pandoc could take for the end of a superscript begun by the note's own.
const escapeCarets = (text) => text.replace(/\\[\s\S]|\^/g, (m) => (m === '^' ? '\\^' : m))
// An unescaped `^`: with no whitespace between it and a note's `^`, Pandoc 2 reads the two as a superscript.
const CARET = /(?<!\\)\^/

// #353: one footnote per reference. A citation whose footnote would read exactly as an earlier one's (the same words, after
// the fallback on the document's title, and for a repository the same file and commit) makes no footnote of its own: it
// prints that footnote's number, as Word's Insert Cross-reference does, a NOTEREF field to a bookmark around the first
// footnote's mark. `\f` gives it the Footnote Reference style, and `\h` makes it a link to the footnote. The field carries
// the number as its shown result (numberCitationCrossReferences below), so it is right when the document opens, with no
// update of fields, and Word keeps it right when it renumbers. The ids are clear of Pandoc's own, the table of contents'
// (1000000 on) and the Field tags' (2000000 on, lib/wordFieldTags.js). A reference cited once is the plain note it was.
//
// Each is a raw inline between two backticks on either side: Pandoc closes a run of backticks with the next run of exactly as
// many, so a stray single backtick of the author's earlier in the paragraph ("Don`t") is not closed by one of these, and
// prints as it is. Two at the start of a line are no code fence, which takes three.
const CITATION_BOOKMARK_ID_BASE = 3000000
const citationBookmarkName = (n) => `_RefCitation${n}`
const bookmarkedNote = (n, words) =>
  '``<w:bookmarkStart w:id="' + (CITATION_BOOKMARK_ID_BASE + n) + '" w:name="' + citationBookmarkName(n) + '"/>``{=openxml}' +
  `^[${words}]` +
  '``<w:bookmarkEnd w:id="' + (CITATION_BOOKMARK_ID_BASE + n) + '"/>``{=openxml}'
const FOOTNOTE_REFERENCE_RUN_PROPERTIES = '<w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>'
const noteCrossReference = (n, shown = '') =>
  '``' +
  `<w:r>${FOOTNOTE_REFERENCE_RUN_PROPERTIES}<w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r>${FOOTNOTE_REFERENCE_RUN_PROPERTIES}<w:instrText xml:space="preserve"> NOTEREF ${citationBookmarkName(n)} \\f \\h </w:instrText></w:r>` +
  `<w:r>${FOOTNOTE_REFERENCE_RUN_PROPERTIES}<w:fldChar w:fldCharType="separate"/></w:r>` +
  `<w:r>${FOOTNOTE_REFERENCE_RUN_PROPERTIES}<w:t>${shown}</w:t></w:r>` +
  `<w:r>${FOOTNOTE_REFERENCE_RUN_PROPERTIES}<w:fldChar w:fldCharType="end"/></w:r>` +
  '``{=openxml}'
const CITATION_BOOKMARK = /^``<w:bookmarkStart w:id="\d+" w:name="(_RefCitation\d+)"\/>``$/
const NOTE_CROSS_REFERENCE = /^``<w:r>[^`]*?<w:instrText xml:space="preserve"> NOTEREF (_RefCitation\d+) \\f \\h <\/w:instrText>[^`]*?<w:t>(\d*)<\/w:t>[^`]*``$/
// Any raw OpenXML inline: a bookmark (the first footnote's, or a Field tag's, which has one backtick a side) or a cross-reference.
const RAW_INLINE = /(`{1,2})<w:[^`]*\1\{=openxml\}/g
const LEADING_BOOKMARKS = /^(?:(`{1,2})<w:bookmarkStart [^`]*\1\{=openxml\})*/
// `text` as Pandoc 2's superscript sees it, character for character: a raw inline is one unbroken piece (the spaces in its
// XML are no break), and a cross-reference opens like a note, so one is kept apart from a `^` beside it as a note is.
const asPandocSees = (text) => text.replace(RAW_INLINE, (raw) => (NOTE_CROSS_REFERENCE.test(raw.slice(0, -'{=openxml}'.length)) ? '^' + '_'.repeat(raw.length - 1) : raw.replace(/\s/g, '_')))

/** The run of non-whitespace characters `text` ends with. */
function trailingWord(text) {
  let i = text.length
  while (i > 0 && !/\s/.test(text[i - 1])) i--
  return text.slice(i)
}

/** Whether the line at `pos` is in a pipe table: its block (the lines around it, up to a blank one) has a delimiter row. */
function inPipeTable(segment, pos) {
  const from = segment.lastIndexOf('\n\n', pos)
  const to = segment.indexOf('\n\n', pos)
  const block = segment.slice(from < 0 ? 0 : from + 2, to < 0 ? segment.length : to)
  return block.split('\n').some((line) => line.includes('|') && TABLE_DELIMITER_ROW.test(line))
}

// `noteFor(words, inNote)` writes the note for a citation in running text whose footnote reads `words` (#353: a note, a
// bookmarked note, or a cross-reference to one), `inNote` saying it sits in a footnote of the author's own.
function wordCitations(segment, titleFor, noteFor) {
  const lineStartOf = (pos) => segment.lastIndexOf('\n', pos - 1) + 1
  const lineEndOf = (pos) => (segment.indexOf('\n', pos) < 0 ? segment.length : segment.indexOf('\n', pos))
  const { inNote } = scanNotes(segment)
  const citations = []
  for (const m of segment.matchAll(CITATION_OR_CODE)) {
    if (m[3] === undefined) continue
    const start = m.index
    const lineStart = lineStartOf(start)
    const prefix = segment.slice(lineStart, start).replace(RAW_BOOKMARK, '')
    const plain = HEADING.test(segment.slice(lineStart, lineEndOf(start))) || LIST_ITEM_LABEL.test(prefix) || (CELL_LABEL.test(prefix) && inPipeTable(segment, start))
    citations.push({ start, end: start + m[0].length, text: m[2], id: m[3], ...locationOf(m[3], m[4]), plain, inNote: inNote(start) })
  }
  if (!citations.length) return segment

  const titleOf = (c) => titleFor?.(c.id) ?? c.id
  // A label and a note both keep the author's Markdown, as the "(words)" they replace did.
  const words = (c) => (c.text.trim() ? c.text.trim() : escapeNote(titleOf(c)))
  const note = (c) => {
    let text = c.text.trim() ? escapeCarets(c.text.trim()) : escapeNote(titleOf(c))
    // The words Copy citation writes for a repository already name the file, so it isn't said twice.
    if (c.path && !(c.text.trim() ? unescapeText(c.text.trim()) : titleOf(c)).includes(c.path)) text += `, ${escapeNote(c.path)}`
    if (c.commit) text += `, at commit ${escapeNote(shortCommit(c.commit))}`
    return noteFor(text, c.inNote)
  }

  // Runs of notes with nothing but separators between them: each run may be all that a bracket holds.
  const runs = []
  for (const c of citations) {
    const prev = runs.at(-1)?.at(-1)
    if (!c.plain && prev && !prev.plain && SEPARATOR.test(segment.slice(prev.end, c.start))) runs.at(-1).push(c)
    else runs.push([c])
  }

  let out = ''
  let at = 0
  let afterNote = false
  // Writes `text` in place of segment[from, to). A note's mark is pulled against the word before it, but never against a
  // line's bullet, quote, table pipe or definition marker, which would stop them being one.
  //
  // Pandoc 2 (what apt installs, and what a server without pandoc-wasm converts with) reads two `^` with no whitespace
  // between them as a superscript: `^[a]^[b]` and `^[a],^[b]` print a superscript "[a]" or "[a]," and a literal "[b]",
  // and `O(n^2)^[a]` one of "2)". So whatever runs, unbroken by whitespace, from a note to the next `^` (the next note's,
  // or the writer's own) gets a space before that `^`, and so does a note whose word before holds a `^`: two marks side by
  // side print "¹ ²", and two with a comma between them "¹, ²". It also reads `[^` as the start of a footnote reference,
  // so a note straight after a `[` (a Field tag's Span, #301) has a space before it, which a Span drops.
  const put = (from, to, text, isNote) => {
    let gap = segment.slice(at, from)
    const kept = gap.replace(/[ \t]+$/, '')
    if (isNote && kept !== gap && !BLOCK_START.test(segment.slice(lineStartOf(from), from - (gap.length - kept.length)).replace(RAW_BOOKMARK, ''))) gap = kept
    // #353: a first footnote's bookmark and a cross-reference are raw OpenXML, read here as Pandoc 2 reads them
    // (asPandocSees); a note's own `^` comes after the bookmark it opens with, and its space goes before the bookmark.
    if (afterNote) {
      const caret = /^\S*/.exec(asPandocSees(gap + text))[0].search(CARET)
      if (caret >= 0 && caret <= gap.length + LEADING_BOOKMARKS.exec(text)[0].length) {
        const at = Math.min(caret, gap.length)
        gap = `${gap.slice(0, at)} ${gap.slice(at)}`
      }
    }
    if (isNote) {
      const seen = asPandocSees(gap)
      const before = /\s/.test(seen) ? /\S*$/.exec(seen)[0] : trailingWord(asPandocSees(out)) + seen
      if (CARET.test(before) || /(?<!\\)\[$/.test(before)) gap += ' '
      // #353: a bookmark or a cross-reference straight after a code span would make its closing backtick and the raw inline's
      // opening one a single run, which Pandoc reads as another delimiter; an empty Span between them prints nothing.
      if (text.startsWith('`') && (out + gap).endsWith('`')) gap += '[]{}'
    }
    out += gap + text
    at = to
    afterNote = isNote
  }
  for (const run of runs) {
    const first = run[0]
    const last = run.at(-1)
    if (first.plain) {
      put(first.start, first.end, words(first), false)
      continue
    }
    const open = /(?<!\\)([([])[ \t]*$/.exec(segment.slice(lineStartOf(first.start), first.start))
    const close = open && (open[1] === '(' ? /^[ \t]*\)/ : /^[ \t]*\]/).exec(segment.slice(last.end, lineEndOf(last.end)))
    const closeEnd = close ? last.end + close[0].length : -1
    // A `]` straight before `(`, `[` or `{` ends a link's text, a reference or a Field tag's Span, not a bracket of the writer's.
    if (close && !(open[1] === '[' && /^[([{]/.test(segment.slice(closeEnd)))) {
      put(first.start - open[0].length, closeEnd, run.map(note).join(' '), true)
      continue
    }
    for (const c of run) put(c.start, c.end, note(c), true)
  }
  put(segment.length, segment.length, '', false)
  return out
}

/**
 * The text the Word document prints for the citations in `markdown` (#351): a Pandoc inline note, `^[words]`, for each one in
 * running text, and the plain words for one that labels a list item or a table cell, or sits in a heading. An empty link text
 * falls back on `titleFor(id)` (the document's title), then on the id. `markdown` is returned unchanged where it holds no citation.
 *
 * #353: `markdown` is the whole Word document's text, so a reference is footnoted once in it. The first citation of a reference
 * cited more than once in running text is a note with a bookmark around its mark, and every later one a cross-reference to it
 * showing its number. A citation printed as plain words (a label, a heading) starts no footnote. Nor does one in a footnote of
 * the author's own: Pandoc drops a note inside a note, so the footnote is where the reference is next cited outside one, and
 * the citation in the author's footnote shows its number. A reference cited only in the author's footnotes is the note it was.
 */
export function sourceCitationsForWord(markdown, titleFor) {
  const times = new Map()
  const firstInText = []
  const once = mapOutsideFences(markdown, (segment) =>
    wordCitations(segment, titleFor, (words, inNote) => {
      times.set(words, (times.get(words) ?? 0) + 1)
      if (!inNote && !firstInText.includes(words)) firstInText.push(words)
      return `^[${words}]`
    })
  )
  const bookmarkOf = new Map(firstInText.filter((words) => times.get(words) > 1).map((words, i) => [words, i + 1]))
  if (!bookmarkOf.size) return once
  const footnoted = new Set()
  const word = mapOutsideFences(markdown, (segment) =>
    wordCitations(segment, titleFor, (words, inNote) => {
      const n = bookmarkOf.get(words)
      if (n === undefined) return `^[${words}]`
      if (inNote || footnoted.has(words)) return noteCrossReference(n)
      footnoted.add(words)
      return bookmarkedNote(n, words)
    })
  )
  return numberCitationCrossReferences(word)
}

// What Pandoc reads around a footnote (#353), each matched whole so that a `^[` or a bracket in it isn't taken for one of its
// own: a code span or a stray run of backticks (group 1; our bookmarks and cross-references among the spans), an HTML comment,
// an escaped character, display and inline math, a raw HTML tag or an autolink, a link's address (from its text's closing
// `]`), a note's definition (`[^label]:` at the start of a line), an inline note's `^[`, a reference to a note by its label
// (group 2), a bracket, and a blank line, which ends a paragraph and any note in it. An indented code block is read as text:
// a list item's indented paragraphs look the same, and those are far more common.
const NOTE_TOKEN = new RegExp(
  [
    CODE_SPAN,
    String.raw`<!--[\s\S]*?-->`,
    String.raw`\\[\s\S]`,
    String.raw`\$\$[\s\S]*?\$\$`,
    String.raw`\$(?![\s$])(?:[^$\\\n]|\\.|\n(?![ \t]*\n))*?(?<![\s\\])\$(?!\d)`,
    String.raw`<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>`,
    String.raw`<[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*>`,
    String.raw`\]\([^\s)]*`,
    String.raw`^[ \t]{0,3}\[\^[^\]\s]+\]:`,
    String.raw`\^\[`,
    String.raw`\[\^([^\]\s]+)\]`,
    String.raw`[[\]]`,
    String.raw`\n[ \t]*\n`,
  ].join('|'),
  'gm'
)
const NOTE_DEFINITION = /^[ \t]{0,3}\[\^([^\]\s]+)\]:/gm

/**
 * #353: the footnotes Pandoc reads in `segment` (text between fenced blocks). `tokens` are, in order, each `^[` that opens an
 * inline note (`{ kind: 'note', at }`), each reference by label (`{ kind: 'label', at, label }`) and each raw OpenXML inline
 * (`{ kind: 'raw', at, match }`, the code span without its `{=openxml}`). `inNote(at)` says whether `at` is inside a footnote
 * of the author's own: an inline note, `^[…]` closed in its paragraph, or a note's definition, up to its paragraph's end.
 */
function scanNotes(segment) {
  const tokens = []
  const notes = []
  let depth = 0
  let open = []
  let definition = -1
  const endParagraph = (at) => {
    if (definition >= 0) notes.push({ start: definition, end: at })
    depth = 0
    open = []
    definition = -1
  }
  for (const m of segment.matchAll(NOTE_TOKEN)) {
    const [match, tick, label] = m
    const at = m.index
    if (tick !== undefined) {
      if (segment.startsWith('{=openxml}', at + match.length)) tokens.push({ kind: 'raw', at, match })
    } else if (match[0] === '\n') endParagraph(at)
    else if (match === '^[') {
      tokens.push({ kind: 'note', at })
      open.push({ at, depth: ++depth })
    } else if (label !== undefined) tokens.push({ kind: 'label', at, label })
    else if (match === '[') depth++
    else if (match[0] === ']') {
      if (open.at(-1)?.depth === depth) notes.push({ start: open.pop().at, end: at + 1, inline: true })
      if (depth) depth--
    } else if (/^[ \t]*\[\^/.test(match)) definition = at
  }
  endParagraph(segment.length)
  const inNote = (at) => notes.some((n) => n.start < at && at < n.end)
  // A `^[` Pandoc makes no note of: never closed, or inside another note, which Pandoc drops.
  const opensNote = (at) => notes.some((n) => n.inline && n.start === at) && !inNote(at)
  return { tokens, inNote, opensNote }
}

/**
 * #353: `markdown` (the Word document's whole text, as Pandoc converts it) with each citation cross-reference's shown number
 * filled in: the number Word gives the footnote its bookmark holds, counting every footnote before it, the author's own
 * (`^[…]`, `[^1]`) among them, and nothing that only looks like one (scanNotes). Run once more on the finished text
 * (lib/render.js), so a footnote in what goes in front of the Fields counts too. `markdown` is returned unchanged where it
 * holds no cross-reference.
 */
export function numberCitationCrossReferences(markdown) {
  const text = String(markdown ?? '')
  if (!text.includes(' NOTEREF _RefCitation')) return text
  const defined = new Set()
  mapOutsideFences(text, (segment) => {
    for (const m of segment.matchAll(NOTE_DEFINITION)) defined.add(m[1])
    return segment
  })
  // Every bookmark's number first, so a cross-reference in a footnote of the author's own may point on to a later one.
  let footnotes = 0
  const numbers = new Map()
  mapOutsideFences(text, (segment) => {
    const { tokens, inNote, opensNote } = scanNotes(segment)
    for (const t of tokens) {
      if (t.kind === 'note' ? opensNote(t.at) : t.kind === 'label' && defined.has(t.label) && !inNote(t.at)) footnotes++
      const bookmark = t.kind === 'raw' && CITATION_BOOKMARK.exec(t.match)
      if (bookmark) numbers.set(bookmark[1], footnotes + 1)
    }
    return segment
  })
  return mapOutsideFences(text, (segment) => {
    let out = ''
    let from = 0
    for (const t of scanNotes(segment).tokens) {
      const reference = t.kind === 'raw' && NOTE_CROSS_REFERENCE.exec(t.match)
      if (!reference) continue
      out += segment.slice(from, t.at) + t.match.replace(/<w:t>\d*<\/w:t>/, `<w:t>${numbers.get(reference[1]) ?? ''}</w:t>`)
      from = t.at + t.match.length
    }
    return out + segment.slice(from)
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
 * The Sources list an Artefact ends with: a heading and a table of the documents `markdown` cites, in the order they are first cited, each with its title, original filename and upload date. #318: a document fetched from a web address (it has an `origin`) shows the address and "retrieved <date>" in place of the filename and upload date. A removed document is listed too, marked "(removed)". #360: one a newer document replaces is marked "(replaced by <newer title>)" instead, naming its newest replacement (replacedByMap), which is its direct one in a chain, or "(replaced by a newer copy)" when that has the same title, as a page fetched again does; a removed one that is also replaced reads only that. A cited id the manifest does not list is left out (there is nothing to say about it), and `''` is returned when nothing is left, so an Artefact that cites nothing ends exactly as it did.
 *
 * @param {string} markdown  the compiled text of the Artefact
 * @param {{ id: string, title?: string, filename?: string, uploadedAt?: string, removedAt?: string, replaces?: string, origin?: { address: string, fetchedAt: string } }[]} entries  the Instance's manifest
 */
export function buildSourceAppendix(markdown, entries) {
  const byId = new Map((entries ?? []).map((e) => [e.id, e]))
  const replaced = replacedByMap(entries)
  const rows = citedSourceIds(markdown)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((e) => {
      const newer = replaced.get(e.id)
      const title = cell(e.title || e.id)
      // #360: **Fetch again** keeps the old copy's title on the new one, so a mark naming it would name the row itself; it
      // says "a newer copy" instead, and the date column tells the two apart.
      const newerTitle = newer ? cell(newer.title || newer.id) : ''
      const mark = newer ? ` (replaced by ${newerTitle === title ? 'a newer copy' : newerTitle})` : e.removedAt ? ' (removed)' : ''
      const row = `${title}${mark}`
      if (isRepositorySource(e)) {
        // #319: a code repository: its address, its branch and the commits this Artefact cites it at.
        const repository = normalizeSourceRepository(e.repository)
        const commits = citedCommits(markdown, e.id).map(shortCommit)
        return `| ${row} | ${cell(repositoryWebAddress(repository))} | branch ${cell(repository.branch)}${commits.length ? `, commit${commits.length === 1 ? '' : 's'} ${cell(commits.join(', '))}` : ''} |`
      }
      if (typeof e.origin?.address === 'string' && e.origin.address) return `| ${row} | ${cell(e.origin.address)} | retrieved ${appendixDate(e.origin.fetchedAt)} |`
      return `| ${row} | ${cell(e.filename)} | ${appendixDate(e.uploadedAt)} |`
    })
  if (!rows.length) return ''
  return `# ${SOURCE_APPENDIX_HEADING}\n\n| Document | File | Added |\n| --- | --- | --- |\n${rows.join('\n')}\n`
}

/**
 * #360: what a Local Workspace render sends the Gantry server about Source documents, which never sees the folder: the manifest
 * entries of the documents `markdown` cites and only what a render prints of each (#281 its title, filename and dates, #318 a
 * fetched one's origin, #319 a code repository's pointer). A cited document a newer one replaces also carries that document's
 * title, as `replacedBy`, so the Sources appendix can mark it, and nothing else of the newer document goes unless it is cited
 * too. The newer document is the newest replacement, by the rule buildSourceAppendix reads (replacedByMap). `[]` when nothing
 * is cited: then nothing goes at all.
 */
export function sourceEntriesForRender(markdown, entries) {
  const cited = new Set(citedSourceIds(markdown))
  const replaced = replacedByMap(entries)
  return (entries ?? [])
    .filter((e) => cited.has(e?.id))
    .map(({ id, filename, title, uploadedAt, removedAt, origin, repository }) => {
      const newer = replaced.get(id)
      const out = { id, filename, title, uploadedAt, removedAt, origin, repository }
      if (newer) out.replacedBy = newer.title || newer.id
      for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
      return out
    })
}
