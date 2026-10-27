// #195 (spec #192, docs/adr/0053-diagram-captions-on-the-fence-and-in-alt-text.md) — Diagram
// captions. An author captions a Mermaid block on its fence, in Pandoc's own attribute syntax:
//
//     ```mermaid {caption="Security architecture"}
//
// and an image with the alt text it already has: `![Security architecture](asset:<id>)`. The
// Word document shows each as the figure followed by "Diagram N. <title>", numbered in one
// sequence per document across both kinds.
//
// Pure (no DOM, no Node built-ins), so the server's compile step (lib/render.js) and the browser
// (web/lib/markdown.js for the preview, web/lib/mermaid.js for the docx pictures) share one copy
// of the syntax and the label format — the same split web/lib/readOnlyModules.js already uses.

const DIAGRAM_LABEL = 'Diagram'

// The attribute the compile step writes onto each Mermaid fence of the markdown bound for the
// Word document: the resolved caption, number included. Only that markdown ever carries it — the
// exported `.md` keeps the fence as the author wrote it.
const FIGURE_CAPTION_ATTR = 'figure-caption'

// One `{…}` attribute block's `key=value` pairs, values double-quoted, single-quoted or bare —
// the forms Pandoc's `fenced_code_attributes` accepts. Backslash escapes inside quotes.
const ATTRIBUTE_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'}]+))/g

function fenceAttributes(info) {
  const open = (info ?? '').indexOf('{')
  const attributes = {}
  if (open === -1) return attributes
  for (const m of info.slice(open + 1).matchAll(ATTRIBUTE_RE)) {
    const quoted = m[2] ?? m[3]
    attributes[m[1]] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : m[4]
  }
  return attributes
}

function attributeValue(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The author's caption on a Mermaid fence, from its info string — everything after the opening
 * backticks, e.g. `mermaid {caption="Security architecture"}`. `null` when there is none, or it
 * is blank.
 *
 * @param {string} info
 * @returns {string|null}
 */
export function mermaidFenceCaption(info) {
  const caption = fenceAttributes(info).caption?.trim()
  return caption ? caption : null
}

/**
 * The caption the compile step resolved for a Mermaid fence of the Word-bound markdown
 * (`numberDiagrams` below), or `null` on a fence it never saw.
 *
 * @param {string} info
 * @returns {string|null}
 */
export function figureCaption(info) {
  return fenceAttributes(info)[FIGURE_CAPTION_ATTR] ?? null
}

/** "Diagram N. <title>", or plain "Diagram N" for a diagram without a caption. */
export function diagramLabel(number, caption) {
  return caption ? `${DIAGRAM_LABEL} ${number}. ${caption}` : `${DIAGRAM_LABEL} ${number}`
}

// Either a fenced code block (any language; matched first, so nothing inside one is ever taken
// for a figure) or a line holding nothing but an image. The fence half has the same shape as
// web/lib/mermaid.js's MERMAID scanner — closing fence identical to the opening one — so both
// see the same Mermaid blocks in the same order.
const FENCE_OR_IMAGE_RE =
  /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$|^ {0,3}!\[([^\]\n]*)\]\(([^)\n]+)\)(\{[^}\n]*\})?[ \t]*$/gm

const MERMAID_INFO_RE = /^[ \t]*mermaid\b/

// A paragraph of its own: a blank line (or the start / end of the text) on both sides. Exactly
// when Pandoc's `implicit_figures` makes an image a figure with a caption.
function standsAlone(text, offset, length) {
  const before = text.slice(0, offset)
  const after = text.slice(offset + length)
  return (before === '' || /(^|\n)[ \t]*\n$/.test(before)) && (after === '' || /^\n[ \t]*(\n|$)/.test(after))
}

/**
 * The compiled artefact markdown as the Word document needs it: every diagram numbered in
 * document order and given its "Diagram N. <title>" caption.
 *
 * - A Mermaid block keeps its source — only a browser can draw it (docs/adr/0030) — and its
 *   opening fence carries the resolved caption for whoever does (`figureCaption`). Every block
 *   takes a number, captioned or not, so an uncaptioned one is still "Diagram N" as before.
 * - An image that Pandoc will make a figure (alone in its paragraph, with alt text) has its alt
 *   text, which Pandoc uses as both the visible caption and the picture's alt text, prefixed with
 *   "Diagram N. ".
 *
 * Everything else — an image beside other text, an image with no alt text, anything inside a
 * code block — is left exactly as it was.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function numberDiagrams(markdown) {
  let count = 0
  return (markdown ?? '').replace(FENCE_OR_IMAGE_RE, (match, indent, fence, info, code, alt, target, attributes, offset, text) => {
    if (fence !== undefined) {
      if (!MERMAID_INFO_RE.test(info)) return match
      count += 1
      const label = diagramLabel(count, mermaidFenceCaption(info))
      return `${indent}${fence}mermaid {${FIGURE_CAPTION_ATTR}=${attributeValue(label)}}\n${code}\n${indent}${fence}`
    }
    if (!alt.trim() || !standsAlone(text, offset, match.length)) return match
    count += 1
    return match.replace(`![${alt}](`, () => `![${diagramLabel(count, alt.trim())}](`)
  })
}
