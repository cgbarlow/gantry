// #302 (ADR-0066): a small XML reader for the parts of a Word document Gantry reads back from a Reviewed
// copy. It exists so the same code reads a .docx in the browser (which has `DOMParser`) and in Node (which
// has none), with no dependency: Word's XML is plain elements, attributes and text, with no DTD to speak
// of. An element is `{ name, attrs, children }`: `name` and each attribute key keep their prefix
// (`w:bookmarkStart`, `w:id`), `children` holds elements and strings. Text that is only whitespace between
// elements is dropped, except inside `w:t` and `w:delText`, where a lone space is a word break.

const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const MAX_DEPTH = 500

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (match, hex, dec, name) => {
    if (name) return ENTITIES[name] ?? match
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10)
    try {
      return String.fromCodePoint(code)
    } catch {
      return ''
    }
  })
}

const KEEPS_WHITESPACE = new Set(['w:t', 'w:delText', 'w:instrText', 'vt:lpwstr', 'w:delInstrText'])

/** Parses `xml` into its root element. Throws on markup that does not nest. */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  TOKEN_RE.lastIndex = 0
  for (const match of String(xml).matchAll(TOKEN_RE)) {
    const [, cdata, closing, opening, rawAttributes, selfClosing, text] = match
    const parent = stack[stack.length - 1]
    if (cdata !== undefined) {
      parent.children.push(cdata)
    } else if (text !== undefined) {
      if (text.trim() !== '' || KEEPS_WHITESPACE.has(parent.name)) parent.children.push(decode(text))
    } else if (opening !== undefined) {
      const attrs = {}
      if (rawAttributes) {
        for (const [, key, double, single] of rawAttributes.matchAll(ATTRIBUTE_RE)) attrs[key] = decode(double ?? single ?? '')
      }
      const element = { name: opening, attrs, children: [] }
      parent.children.push(element)
      if (selfClosing !== '/') {
        if (stack.length >= MAX_DEPTH) throw new Error('The XML is nested too deeply')
        stack.push(element)
      }
    } else if (closing !== undefined) {
      if (stack.length === 1 || parent.name !== closing) throw new Error(`Unexpected </${closing}> in the XML`)
      stack.pop()
    }
  }
  if (stack.length !== 1) throw new Error('The XML ends before </' + stack[stack.length - 1].name + '> closes')
  return root.children.find((child) => typeof child !== 'string') ?? root
}

/** The element children of `node`, optionally only those called `name`. */
export function childElements(node, name) {
  return node.children.filter((child) => typeof child !== 'string' && (name === undefined || child.name === name))
}

/** The first element child of `node` called `name`, or `undefined`. */
export function childElement(node, name) {
  return node.children.find((child) => typeof child !== 'string' && child.name === name)
}

/** An attribute by its local name, whatever its prefix: `attribute(node, 'id')` reads `w:id` or `id`. */
export function attribute(node, local) {
  if (!node?.attrs) return undefined
  if (local in node.attrs) return node.attrs[local]
  for (const key of Object.keys(node.attrs)) {
    const colon = key.indexOf(':')
    if (colon >= 0 && key.slice(colon + 1) === local) return node.attrs[key]
  }
  return undefined
}

/** All the text inside `node`, in order. */
export function textOf(node) {
  if (typeof node === 'string') return node
  return node.children.map(textOf).join('')
}
