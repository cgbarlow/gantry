import { FIELD_BOOKMARK_PREFIX, fieldBookmarkName } from '../web/lib/fieldBookmark.js'

// #301 (ADR-0066): every Word render is tagged so a Reviewed copy can be read back onto Fields.
//   - Each printed Field's value is wrapped, in the Word conversion's Markdown only, in a Pandoc
//     Div (a block) or Span (inside a line) carrying an id, which Pandoc writes into the .docx as an
//     invisible bookmark around exactly that value.
//   - `gantry-*` custom document properties name the Instance, Artefact, Stage, Definition version,
//     commit and a render id (`wordDocumentProperties` below).
// Nothing in a Definition or its templates changes, and the Filename pattern, the cover and the
// templates' own conditions never see anything but the plain values: the tagging is done by handing
// the template engine a read-only view of the Modules (`createFieldTagger`) that notes which Field a
// printed value was read from, and the Markdown it produces is turned into Divs and Spans afterwards
// (`applyFieldTags`). Pandoc itself, and the .docx it writes, are left alone (ADR-0056).

// A Word bookmark name begins with a letter and holds letters, digits and underscores. `gf_` plus
// eight hex digits of a hash of `module/field` is short, valid in Word, and recomputed from the
// Definition by the reader (web/lib/fieldBookmark.js, shared with the browser's Reviewed-copy reader),
// so the document needs no lookup table. A Field printed more than once in one document gets `_2`,
// `_3`, ... on its later copies, in document order.
export { FIELD_BOOKMARK_PREFIX, fieldBookmarkName }

// Private-use characters that bracket a tagged value in the compiled text. They never reach Pandoc:
// `applyFieldTags` replaces or removes every one.
const START = '\uE000'
const END = '\uE002'
const CLOSE = '\uE001'
const MARKER_RE = /\uE000([^\uE001]*)\uE001|\uE002([^\uE001]*)\uE001/g
const STRAY_RE = /[\uE000-\uE002]/g

/**
 * A read-only view of `modules` for the template engine, plus the hooks that tag what it prints.
 *
 * - `modules` returns exactly the values the real Modules hold, so conditions, comparisons and
 *   helpers behave as they always did; it only remembers which Field each string or list was read
 *   from.
 * - `begin()` is called by the engine just before each output expression is evaluated, so only the
 *   reads made by that expression are considered.
 * - `filter(value)` is called with each output value. When the expression read exactly one Field
 *   (more than one: the last whose text appears in the output), the value is bracketed with markers.
 * - A list Field walked with `forEach` is tagged as one value, from its first printed item to its
 *   last.
 */
export function createFieldTagger(modules) {
  let reads = []
  let walk = null

  const begin = () => {
    reads = []
  }

  const listView = (name, items) =>
    new Proxy(items, {
      get(target, key, receiver) {
        if (key !== 'forEach') return Reflect.get(target, key, receiver)
        return (callback, thisArg) => {
          const outer = walk
          const current = { name, items, index: -1, item: undefined, tagged: new Set() }
          walk = current
          try {
            target.forEach((item, index, all) => {
              current.index = index
              current.item = item
              return callback.call(thisArg, item, index, all)
            })
          } finally {
            walk = outer
          }
        }
      },
    })

  const moduleView = (moduleId, container) =>
    new Proxy(container, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof key !== 'string' || !Object.hasOwn(target, key)) return value
        if (typeof value === 'string') {
          reads.push({ name: fieldBookmarkName(moduleId, key), value })
          return value
        }
        if (Array.isArray(value)) {
          const name = fieldBookmarkName(moduleId, key)
          reads.push({ name, value: value.join('\n') })
          return listView(name, value)
        }
        return value
      },
    })

  const view = new Proxy(modules, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key === 'string' && Object.hasOwn(target, key) && value && typeof value === 'object' && !Array.isArray(value)) {
        return moduleView(key, value)
      }
      return value
    },
  })

  const pickRead = (text) => {
    const names = [...new Set(reads.map((read) => read.name))]
    if (names.length === 0) return null
    if (names.length === 1) return names[0]
    for (let i = reads.length - 1; i >= 0; i--) {
      const printed = reads[i].value.trim()
      if (printed !== '' && text.includes(printed)) return reads[i].name
    }
    return null
  }

  const filter = (value) => {
    const text = String(value)
    if (text === '') return text
    const name = pickRead(text)
    reads = []
    if (name) return `${START}${name}${CLOSE}${text}${END}${name}${CLOSE}`
    if (walk && !walk.tagged.has(walk.index) && text === String(walk.item)) {
      walk.tagged.add(walk.index)
      const first = walk.index === 0
      const last = walk.index === walk.items.length - 1
      return `${first ? `${START}${walk.name}${CLOSE}` : ''}${text}${last ? `${END}${walk.name}${CLOSE}` : ''}`
    }
    return text
  }

  return { modules: view, begin, filter }
}

// The template engine hook: runs `tagger.begin()` ahead of every output expression (`<%~ … %>` and
// `<%= … %>`), so the reads logged for a value are the ones its own expression made.
export function tagFieldOutputs(ast) {
  return ast.map((node) => {
    if (typeof node === 'string' || (node.t !== 'r' && node.t !== 'i')) return node
    const expression = String(node.val ?? '').trim().replace(/;+$/, '')
    return { ...node, val: `(__gtBegin(), ${expression})` }
  })
}

export const TAG_FUNCTION_HEADER = 'const __gtBegin = () => it.__gantryTagger.begin();'

/**
 * `text.replace(/\n{3,}/g, '\n\n')` for text with markers in it: a run of blank lines that a marker
 * sits in is still collapsed, and the markers are kept, just after the two newlines.
 */
export function collapseBlankLines(text) {
  return text.replace(/\n(?:(?:[\uE000\uE002][^\uE001]*\uE001)*\n){2,}/g, (run) => `\n\n${(run.match(MARKER_RE) ?? []).join('')}`)
}

// --- Turning markers into Pandoc Divs and Spans ---

const BLOCK_PREFIX_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])?[ \t]*$/
const BLOCK_START_RE = /^(?:[-*+>#|]|\d+[.)]|:::|```|~~~|\[[^\]]*\]:)/
const ATX_HEADING_RE = /^[ \t]{0,3}#{1,6}(?:\s|$)/
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/
const LIST_ITEM_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]/
const LIST_PREFIX_RE = /^(?:[-*+]|\d+[.)])[ \t]+(?![-*+_]{2,})/
// Where a value can't take an inline marker at its very start or end.
const NO_RAW_START_RE = /^(?:[#>|<]|:::|```|~~~|[-*_=]{3,}|\[[^\]]*\]:|\s)/
const NO_RAW_END_RE = /^(?:[ \t]*\|[^\n]*|[ \t]*:{3,}[ \t]*|[ \t]*(?:`{3,}|~{3,})[^\n]*|[ \t]{4,}[^\n]*|<[^\n]*)$/

function isBalanced(text) {
  let depth = 0
  for (const ch of text) {
    if (ch === '[') depth++
    else if (ch === ']' && --depth < 0) return false
  }
  return depth === 0
}

// Is every code fence and every Pandoc fenced Div in `text` closed? A value that isn't would have
// swallowed the Div's closing fence, so it isn't wrapped.
function isSelfContained(text) {
  let fence = null
  let divs = 0
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1][0]
      continue
    }
    if (/^:{3,}\s*$/.test(line)) {
      if (--divs < 0) return false
    } else if (/^:{3,}\s*\S/.test(line)) {
      divs++
    }
  }
  return fence === null && divs === 0
}

// A bookmark written as raw OpenXML. Pandoc passes it straight into the paragraph it sits in; ids start
// well clear of the ones Pandoc numbers itself and the table of contents uses (1000000 on).
const RAW_BOOKMARK_ID_BASE = 2000000

function rawBookmark(kind, id, name) {
  return '`<w:bookmark' + kind + ' w:id="' + id + '"' + (name ? ' w:name="' + name + '"' : '') + '/>`{=openxml}'
}

// Where inside the value's first and last lines a raw bookmark can go: after a list bullet, and before
// any trailing spaces; `null` when the value starts or ends with something that has no inline text
// (a heading, a table row, a code fence, …) or sits where inline markup would be read as something else.
function rawBookmarkPoints(plain, start, end, prefix, endInFence, lastLine, firstLine) {
  if (endInFence || ATX_HEADING_RE.test(firstLine) || ATX_HEADING_RE.test(lastLine)) return null
  if (!/^[ \t]{0,3}(?:[-*+]|\d+[.)])?[ \t]*$/.test(prefix) && (prefix.split('`').length - 1) % 2 === 1) return null
  if (prefix.lastIndexOf('<') > prefix.lastIndexOf('>') || prefix.lastIndexOf('{') > prefix.lastIndexOf('}')) return null
  if (/\[$/.test(prefix) || /\]\([^)]*$/.test(prefix)) return null
  const head = plain.slice(start, end)
  const bullet = prefix.trim() === '' ? LIST_PREFIX_RE.exec(head) : null
  const first = bullet ? start + bullet[0].length : start
  if (NO_RAW_START_RE.test(plain.slice(first, end))) return null
  if (NO_RAW_END_RE.test(lastLine) || /\\$/.test(plain.slice(first, end))) return null
  return { start: first, end }
}

/**
 * Replaces the markers in `text` with Pandoc Divs (a value that is its own block or blocks) and Spans
 * (a single-line value inside a line), and removes any it can't wrap without changing how the
 * Markdown reads. With the Divs and Spans taken out again (`stripFieldTags`), the result is the text
 * that was compiled without tagging, character for character.
 */
export function applyFieldTags(text) {
  if (!/[\uE000-\uE002]/.test(text)) return text

  let plain = ''
  let last = 0
  const stack = []
  const pairs = []
  for (const match of text.matchAll(MARKER_RE)) {
    plain += text.slice(last, match.index)
    last = match.index + match[0].length
    if (match[1] !== undefined) {
      stack.push({ name: match[1], start: plain.length })
      continue
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === match[2]) {
        pairs.push({ name: match[2], start: stack[i].start, end: plain.length })
        stack.length = i
        break
      }
    }
  }
  plain += text.slice(last)
  plain = plain.replace(STRAY_RE, '')
  if (pairs.length === 0) return plain

  // Which lines sit inside a fenced code block in the text around the values.
  const lineStarts = [0]
  for (let i = 0; i < plain.length; i++) if (plain[i] === '\n') lineStarts.push(i + 1)
  const inFence = []
  {
    let fence = null
    for (let n = 0; n < lineStarts.length; n++) {
      const line = plain.slice(lineStarts[n], n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : plain.length)
      const fenceMatch = FENCE_RE.exec(line)
      inFence[n] = fence !== null
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence && line.trim() === fenceMatch[1]) fence = null
      } else if (fenceMatch) {
        fence = fenceMatch[1][0]
      }
    }
  }
  const lineAt = (pos) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const lineText = (n) => (n < 0 || n >= lineStarts.length ? null : plain.slice(lineStarts[n], n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : plain.length))

  pairs.sort((a, b) => a.start - b.start || b.end - a.end)
  const seen = new Map()
  let rawCount = 0
  const edits = []
  for (const pair of pairs) {
    const raw = plain.slice(pair.start, pair.end)
    const start = pair.start + (raw.length - raw.trimStart().length)
    const end = pair.start + raw.trimEnd().length
    if (end <= start) continue
    const startLine = lineAt(start)
    if (inFence[startLine]) continue
    const lineStart = lineStarts[startLine]
    const endLine = lineAt(end)
    const lineEnd = endLine + 1 < lineStarts.length ? lineStarts[endLine + 1] - 1 : plain.length
    const prefix = plain.slice(lineStart, start)
    const suffix = plain.slice(end, lineEnd)
    const before = lineText(startLine - 1)
    const after = lineText(endLine + 1)

    // Wrapping lists in a Div would split what Pandoc reads as one list: two list values with only a
    // blank line between them are a single loose list, and each in a Div of its own is two tight ones.
    const listish = (line) => line !== null && (LIST_ITEM_RE.test(line) || /^(?:[ \t]{2,}|\t)\S/.test(line))
    const nonBlank = (from, step) => {
      let n = from
      while (n >= 0 && n < lineStarts.length && lineText(n).trim() === '') n += step
      return lineText(n)
    }
    const wouldMergeLists =
      (listish(lineText(startLine)) && listish(nonBlank(startLine - 1, -1))) ||
      (listish(lineText(endLine)) && listish(nonBlank(endLine + 1, 1)))

    let kind = null
    if (
      !wouldMergeLists &&
      BLOCK_PREFIX_RE.test(prefix) &&
      suffix.trim() === '' &&
      (before === null || before.trim() === '' || ATX_HEADING_RE.test(before)) &&
      (after === null || after.trim() === '' || ATX_HEADING_RE.test(after) || /^:{3,}\s*$/.test(after)) &&
      isSelfContained(plain.slice(lineStart, end))
    ) {
      kind = 'div'
    } else {
      const content = plain.slice(start, end)
      const lineBefore = lineText(startLine)
      if (
        !content.includes('\n') &&
        !ATX_HEADING_RE.test(lineBefore) &&
        isBalanced(content) &&
        !content.endsWith('\\') &&
        !(prefix.trim() === '' && BLOCK_START_RE.test(content)) &&
        !/\[$/.test(prefix) &&
        !/\]\([^)]*$/.test(prefix) &&
        (prefix.split('`').length - 1) % 2 === 0 &&
        prefix.lastIndexOf('<') <= prefix.lastIndexOf('>') &&
        prefix.lastIndexOf('{') <= prefix.lastIndexOf('}')
      ) {
        kind = 'span'
      }
    }
    // Anything left (a list that sits against another, text that runs on into the value, …) gets an
    // invisible bookmark from raw OpenXML at the start of its first line of text and the end of its last,
    // which changes nothing about how the Markdown around it is read.
    let rawMark = null
    if (!kind) rawMark = rawBookmarkPoints(plain, start, end, prefix, inFence[endLine], lineText(endLine), lineText(startLine))
    if (!kind && !rawMark) continue

    const count = (seen.get(pair.name) ?? 0) + 1
    seen.set(pair.name, count)
    const id = count === 1 ? pair.name : `${pair.name}_${count}`
    if (rawMark) {
      const rawId = RAW_BOOKMARK_ID_BASE + rawCount++
      edits.push({ pos: rawMark.start, open: true, outer: rawMark.end, text: rawBookmark('Start', rawId, id) })
      edits.push({ pos: rawMark.end, open: false, outer: rawMark.start, text: rawBookmark('End', rawId) })
    } else if (kind === 'div') {
      edits.push({ pos: lineStart, open: true, outer: lineEnd, text: `::: {#${id}}\n` })
      edits.push({ pos: lineEnd, open: false, outer: lineStart, text: '\n:::' })
    } else {
      edits.push({ pos: start, open: true, outer: end, text: '[' })
      edits.push({ pos: end, open: false, outer: start, text: `]{#${id}}` })
    }
  }
  if (edits.length === 0) return plain

  // At one position, close what is open (innermost first) before opening anything new (outermost first).
  edits.sort((a, b) => a.pos - b.pos || Number(a.open) - Number(b.open) || b.outer - a.outer)
  let out = ''
  let at = 0
  for (const edit of edits) {
    out += plain.slice(at, edit.pos) + edit.text
    at = edit.pos
  }
  return out + plain.slice(at)
}

/**
 * The inverse of `applyFieldTags` and of `wordDocumentProperties`, for tests: `text` as it would have
 * compiled without any tagging. Takes out the Field Divs and Spans (and the `gantry-*` properties
 * block at the top).
 */
export function stripFieldTags(text) {
  let out = text.replace(/^---\n(?:gantry-[a-z-]+: .*\n)+---\n\n/, '')
  out = out.replace(/`<w:bookmark(?:Start|End) [^`]*\/>`\{=openxml\}/g, '')
  out = out.replace(/\[((?:[^[\]\n]|\[[^\]\n]*\])*)\]\{#gf_[0-9a-f]{8}(?:_\d+)?\}/g, '$1')
  const lines = out.split('\n')
  const kept = []
  const open = []
  for (const line of lines) {
    if (/^:{3,}\s*\{#gf_[0-9a-f]{8}(?:_\d+)?\}\s*$/.test(line)) {
      open.push(true)
      continue
    }
    if (/^:{3,}\s*\S/.test(line)) {
      open.push(false)
    } else if (/^:{3,}\s*$/.test(line)) {
      if (open.pop()) continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

// --- The gantry-* document properties ---

// Pandoc reads a YAML value as Markdown, so every ASCII punctuation character is backslash-escaped to
// reach the document property exactly as given.
function propertyValue(value) {
  return JSON.stringify(String(value).replace(/[!-/:-@[-`{-~]/g, '\\$&'))
}

/**
 * The YAML metadata block that makes Pandoc write `gantry-*` custom document properties into the
 * .docx (any root-level string metadata Pandoc doesn't use itself becomes one), at the top of the
 * Word conversion's Markdown so the native and the browser conversions both pick it up with the
 * arguments they already have. Properties with no value are left out.
 *
 * @param {Record<string, string|null|undefined>} properties keyed by property name without the `gantry-` prefix
 */
export function wordDocumentProperties(properties) {
  const lines = Object.entries(properties)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `gantry-${key}: ${propertyValue(value)}`)
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''
}
