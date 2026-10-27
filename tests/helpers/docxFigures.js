import { execFileSync } from 'node:child_process'

// #198 — reads a rendered .docx the way a reviewer would see its diagrams: every captioned figure
// (an Image Caption paragraph and the figure paragraph above it), and for each picture the name
// Pandoc recorded for its source file and the PNG's pixel size. Shared by the CLI's Mermaid tests
// (tests/cliMermaid.test.js, tests/cliMermaid.playwright.test.js).

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function unzipText(docxPath, entry) {
  return execFileSync('unzip', ['-p', docxPath, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function unzipBytes(docxPath, entry) {
  return execFileSync('unzip', ['-p', docxPath, entry], { maxBuffer: 64 * 1024 * 1024 })
}

// Width and height from a PNG's IHDR chunk.
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** The text of `word/document.xml`. */
export function documentXml(docxPath) {
  return unzipText(docxPath, 'word/document.xml')
}

/**
 * Every captioned figure in document order: `{ caption, style, alt, name, width, height }`, where
 * `style` is the figure paragraph's style, `alt` the picture's description, `name` the source file
 * name Pandoc recorded for it, and `width`/`height` the embedded PNG's pixels (null for another
 * image type).
 */
export function captionedFigures(docxPath) {
  const xml = documentXml(docxPath)
  const rels = unzipText(docxPath, 'word/_rels/document.xml.rels')
  const targetById = new Map([...rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]))
  const ps = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, body]) => {
    const style = body.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? null
    const text = decode([...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    if (!body.includes('<w:drawing>')) return { style, text, picture: null }
    const target = targetById.get(body.match(/<a:blip r:embed="([^"]+)"/)?.[1])
    const size = target?.endsWith('.png') ? pngSize(unzipBytes(docxPath, `word/${target}`)) : { width: null, height: null }
    return {
      style,
      text,
      picture: {
        alt: decode(body.match(/<wp:docPr [^>]*descr="([^"]*)"/)?.[1] ?? ''),
        name: decode(body.match(/<pic:cNvPr [^>]*descr="([^"]*)"/)?.[1] ?? ''),
        ...size,
      },
    }
  })
  return ps.flatMap((p, i) =>
    p.style === 'ImageCaption' ? [{ caption: p.text, style: ps[i - 1]?.style ?? null, ...(ps[i - 1]?.picture ?? {}) }] : []
  )
}
