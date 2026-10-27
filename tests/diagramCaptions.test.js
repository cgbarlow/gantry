import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderArtefact } from '../lib/render.js'
import { runLocalWorkspaceCompute } from '../lib/localWorkspace.js'

// #195 (spec #192, ADR-0053): a Diagram caption. An author captions a Mermaid block on its fence
// (```mermaid {caption="…"}) or an image with its alt text (![…](asset:id)), and the Word document
// shows the figure followed by "Diagram N. <title>", numbered in one sequence per document across
// both kinds, kept on the figure's page by the Captioned Figure style's keep-with-next. The
// numbering happens in the shared compile step, so the CLI / native path numbers images exactly
// as the browser path does. These tests drive the native path end to end and read the .docx XML;
// the browser export (which draws the Mermaid picture) is covered by
// tests/diagramCaptions.playwright.test.js.

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SECURITY_FENCE = '```mermaid {caption="Security architecture"}\nflowchart LR\n  Member --> Portal --> CRM\n```'

async function withExample(edit, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-captions-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
    rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
    for (const [moduleId, change] of Object.entries(edit)) {
      const path = join(instancesDir, SLUG, 'modules', `${moduleId}.md`)
      const before = readFileSync(path, 'utf8')
      const after = change(before)
      assert.notEqual(after, before, `the ${moduleId} fixture edit must land`)
      writeFileSync(path, after)
    }
    return await fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// A captioned Mermaid block at the end of the Problem statement, the SOAP's first field — so it
// comes before the two captioned images in Solution definition.
const withSecurityDiagram = (text) =>
  text.replace(/\n## Affected domains/, `\n${SECURITY_FENCE}\n\n## Affected domains`)

const unzip = (docxPath, part) => execFileSync('unzip', ['-p', docxPath, part], { encoding: 'utf8' })

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function paragraphs(documentXml) {
  return [...documentXml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, body]) => ({
    style: body.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? null,
    text: decode([...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
    alt: body.includes('<w:drawing>') ? decode(body.match(/<wp:docPr [^>]*descr="([^"]*)"/)?.[1] ?? '') : null,
  }))
}

// Every caption in the document, with the paragraph that holds its figure.
function captionedFigures(documentXml) {
  const ps = paragraphs(documentXml)
  return ps.flatMap((p, i) => (p.style === 'ImageCaption' ? [{ caption: p.text, figure: ps[i - 1] }] : []))
}

test('a captioned image renders as the figure then "Diagram N. <title>", numbered in one sequence with the Mermaid blocks before it', async () => {
  await withExample({ background: withSecurityDiagram }, (instancesDir) => {
    const result = renderArtefact(SLUG, 'soap', { instancesDir })
    const figures = captionedFigures(unzip(result.docxPath, 'word/document.xml'))

    // The Mermaid block is Diagram 1 on every path. The CLI / native path still leaves its
    // source as a code block until it can draw it (#198), but the images after it are numbered
    // exactly as the browser export numbers them.
    assert.deepEqual(
      figures.map((f) => f.caption),
      ['Diagram 2. Take out insurance process', 'Diagram 3. Claims handling introductory view']
    )
    for (const { caption, figure } of figures) {
      assert.equal(figure.style, 'CaptionedFigure', `"${caption}" sits directly under its figure`)
      assert.equal(figure.alt, caption, 'the caption doubles as the image\'s alt text')
    }

    // Keep-with-next on the figure, so a caption is never stranded on the next page.
    const captionedFigureStyle = unzip(result.docxPath, 'word/styles.xml').match(/<w:style [^>]*w:styleId="CaptionedFigure"[^>]*>[\s\S]*?<\/w:style>/)?.[0]
    assert.match(captionedFigureStyle ?? '', /<w:keepNext\s*\/>/)
  })
})

test('only a figure takes a number: an inline image, an image with no alt text and an image inside a code block are left alone', async () => {
  await withExample(
    {
      background: (text) =>
        text.replace(
          /\n## Affected domains/,
          [
            '',
            'An inline ![icon](asset:kcm-take-out-insurance-process) beside some words.',
            '',
            '![](asset:kcm-claims-introductory-view)',
            '',
            '````markdown',
            '![Not a figure](x.png)',
            '````',
            '',
            '## Affected domains',
          ].join('\n')
        ),
    },
    (instancesDir) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir })
      assert.deepEqual(
        captionedFigures(unzip(result.docxPath, 'word/document.xml')).map((f) => f.caption),
        ['Diagram 1. Take out insurance process', 'Diagram 2. Claims handling introductory view']
      )
    }
  )
})

test('the exported .md keeps the caption syntax intact and the images as authored', async () => {
  await withExample({ background: withSecurityDiagram }, (instancesDir) => {
    const result = renderArtefact(SLUG, 'soap', { instancesDir, format: 'md' })
    const md = readFileSync(result.mdPath, 'utf8')
    assert.ok(md.includes(SECURITY_FENCE), 'the captioned fence is exported exactly as written')
    assert.match(md, /!\[Take out insurance process\]\(/)
    assert.doesNotMatch(md, /Diagram \d/, 'numbering is for the Word document only')
  })
})

test('a document with no captioned diagram renders exactly as before: an uncaptioned Mermaid block and an image without alt text', async () => {
  await withExample(
    {
      background: (text) => text.replace(/\n## Affected domains/, '\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Affected domains'),
      'solution-definition': (text) =>
        text.replace('![Take out insurance process](', '![](').replace('![Claims handling introductory view](', '!['),
    },
    (instancesDir) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir })
      // Before captions, the render handed the compiled markdown straight to Pandoc.
      const scratch = mkdtempSync(join(tmpdir(), 'gantry-captions-before-'))
      try {
        const mdPath = join(scratch, 'before.md')
        const docxPath = join(scratch, 'before.docx')
        writeFileSync(mdPath, result.markdown)
        execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', result.referenceDocPath, '-o', docxPath, mdPath])
        assert.equal(unzip(result.docxPath, 'word/document.xml'), unzip(docxPath, 'word/document.xml'))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
      assert.deepEqual(captionedFigures(unzip(result.docxPath, 'word/document.xml')), [])
    }
  )
})

test('a local workspace compile hands the browser the numbered markdown for the Word document, and the authored markdown for the .md', async () => {
  const moduleFiles = {}
  for (const name of readdirSync(join(EXAMPLE, 'modules'))) {
    moduleFiles[name.replace(/\.md$/, '')] = readFileSync(join(EXAMPLE, 'modules', name), 'utf8')
  }
  moduleFiles.background = withSecurityDiagram(moduleFiles.background)
  // A local workspace ships its own image bytes; this compile only needs the references.
  moduleFiles['solution-definition'] = moduleFiles['solution-definition'].replace(/\(asset:[^)]+\)/g, '(diagram.png)')
  const compiled = await runLocalWorkspaceCompute('compile', {
    definitionId: 'design',
    definitionVersion: 2,
    instanceYaml: readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8'),
    moduleFiles,
    artefact: 'soap',
  })
  assert.ok(compiled.markdown.includes(SECURITY_FENCE), 'the .md keeps the fence as written')
  assert.doesNotMatch(compiled.markdown, /Diagram \d/)
  // The browser draws the Mermaid picture and labels it with the caption the compile resolved.
  assert.match(compiled.docxMarkdown, /```mermaid \{figure-caption="Diagram 1\. Security architecture"\}\nflowchart LR/)
  assert.match(compiled.docxMarkdown, /!\[Diagram 2\. Take out insurance process\]\(diagram\.png\)/)
  assert.match(compiled.docxMarkdown, /!\[Diagram 3\. Claims handling introductory view\]\(diagram\.png\)/)
})
