import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderArtefact, unnumberedHeadingsForWord } from '../lib/render.js'
import { runLocalWorkspaceCompute } from '../lib/localWorkspace.js'
import { findDefinitionProblemsInStructure, loadDefinition } from '../lib/definition.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { numberDiagrams } from '../web/lib/diagramCaptions.js'

// #195 (spec #192, ADR-0053): a Diagram caption. An author captions a Mermaid block on its fence
// (```mermaid {caption="…"}) or an image with its alt text (![…](asset:id)), and the Word document
// shows the figure followed by "Diagram N. <title>", numbered in one sequence per document across
// both kinds, kept on the figure's page by the Captioned Figure style's keep-with-next. The
// numbering happens in the shared compile step, so the CLI / native path numbers images exactly
// as the browser path does. These tests drive the native path end to end and read the .docx XML;
// the browser export (which draws the Mermaid picture) is covered by
// tests/diagramCaptions.playwright.test.js.
//
// Numbering is opt-in per Artefact (`diagram-captions: true`, the "engine options are opt-in per
// Artefact" pattern of ADR-0049): an Artefact that doesn't set it — every Artefact of design v1
// and v2 and every other bundled Definition — converts exactly as it did before captions existed.
// design v3 switches it on for every Artefact. Each test pins the version its scratch copy of the
// example renders on, rather than relying on the version the bundled example happens to be pinned
// to: the opted-in tests render on v3, and the "exactly as before" regressions on v2.

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SECURITY_FENCE = '```mermaid {caption="Security architecture"}\nflowchart LR\n  Member --> Portal --> CRM\n```'

// design v3 opts every Artefact in; v2, published before captions existed, opts none in.
const OPTED_IN = 3
const NOT_OPTED_IN = 2

// The example's instance.yaml, pinned to `version` of the design Definition.
function instanceYamlOn(version) {
  const before = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8')
  const after = before.replace(/^definitionVersion: \d+$/m, `definitionVersion: ${version}`)
  assert.match(after, new RegExp(`^definitionVersion: ${version}$`, 'm'), 'the example is pinned to the version under test')
  return after
}

async function withExample(edit, fn, { version = OPTED_IN } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-captions-'))
  const instancesDir = join(root, 'instances')
  try {
    const definitionsDir = 'definitions'
    assert.equal(
      loadDefinition('design', { definitionsDir, version }).artefacts.every((a) => a.diagramCaptions === (version === OPTED_IN ? true : undefined)),
      true,
      `design v${version} ${version === OPTED_IN ? 'opts every Artefact in' : 'opts no Artefact in'}`
    )
    cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
    rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
    writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), instanceYamlOn(version))
    for (const [moduleId, change] of Object.entries(edit)) {
      const path = join(instancesDir, SLUG, 'modules', `${moduleId}.md`)
      const before = readFileSync(path, 'utf8')
      const after = change(before)
      assert.notEqual(after, before, `the ${moduleId} fixture edit must land`)
      writeFileSync(path, after)
    }
    return await fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
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
  await withExample({ background: withSecurityDiagram }, ({ instancesDir, definitionsDir }) => {
    const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
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
    ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      assert.deepEqual(
        captionedFigures(unzip(result.docxPath, 'word/document.xml')).map((f) => f.caption),
        ['Diagram 1. Take out insurance process', 'Diagram 2. Claims handling introductory view']
      )
    }
  )
})

test('the exported .md keeps the caption syntax intact and the images as authored', async () => {
  await withExample({ background: withSecurityDiagram }, ({ instancesDir, definitionsDir }) => {
    const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, format: 'md' })
    const md = readFileSync(result.mdPath, 'utf8')
    assert.ok(md.includes(SECURITY_FENCE), 'the captioned fence is exported exactly as written')
    assert.match(md, /!\[Take out insurance process\]\(/)
    assert.doesNotMatch(md, /Diagram \d/, 'numbering is for the Word document only')
  })
})

// What Pandoc made of the compiled markdown before captions existed: the render handed it straight over.
function convertDirectly(result) {
  const scratch = mkdtempSync(join(tmpdir(), 'gantry-captions-before-'))
  try {
    const mdPath = join(scratch, 'before.md')
    const docxPath = join(scratch, 'before.docx')
    // Headings marked `.unnumbered` (design v3's Document Control, #197) go to Word with their
    // numbering switched off whether or not anything is captioned.
    writeFileSync(mdPath, unnumberedHeadingsForWord(result.markdown))
    execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', result.referenceDocPath, '-o', docxPath, mdPath])
    return unzip(docxPath, 'word/document.xml')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// An uncaptioned Mermaid block after both of the SOAP's images, so a numbering pass would have
// called it "Diagram 3".
const withUncaptionedDiagramAfterImages = (text) =>
  text.replace(/\n## Feature breakdown and involved teams/, '\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Feature breakdown and involved teams')

test('an Artefact that does not opt in converts exactly as before: alt-texted images and an uncaptioned Mermaid block take no number', async () => {
  await withExample(
    { 'solution-definition': withUncaptionedDiagramAfterImages },
    ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      assert.equal(result.docxMarkdown, result.markdown, 'the Word document is converted from the markdown as compiled')
      const documentXml = unzip(result.docxPath, 'word/document.xml')
      assert.equal(documentXml, convertDirectly(result))
      assert.deepEqual(
        captionedFigures(documentXml).map((f) => f.caption),
        ['Take out insurance process', 'Claims handling introductory view'],
        'the images keep their bare alt text as their caption'
      )
    },
    { version: NOT_OPTED_IN }
  )
})

test('the unmodified example SAD, with eight alt-texted images, converts exactly as before', async () => {
  await withExample(
    {},
    ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'sad', { instancesDir, definitionsDir })
      assert.equal(result.docxMarkdown, result.markdown)
      const documentXml = unzip(result.docxPath, 'word/document.xml')
      assert.equal(documentXml, convertDirectly(result))
      assert.doesNotMatch(documentXml, /Diagram \d/)
    },
    { version: NOT_OPTED_IN }
  )
})

test('an opted-in document with no captioned diagram renders exactly as before: an uncaptioned Mermaid block and an image without alt text', async () => {
  await withExample(
    {
      background: (text) => text.replace(/\n## Affected domains/, '\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Affected domains'),
      'solution-definition': (text) =>
        text.replace('![Take out insurance process](', '![](').replace('![Claims handling introductory view](', '!['),
    },
    ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const documentXml = unzip(result.docxPath, 'word/document.xml')
      assert.equal(documentXml, convertDirectly(result))
      assert.deepEqual(captionedFigures(documentXml), [])
    }
  )
})

function exampleModuleFiles() {
  const moduleFiles = {}
  for (const name of readdirSync(join(EXAMPLE, 'modules'))) {
    moduleFiles[name.replace(/\.md$/, '')] = readFileSync(join(EXAMPLE, 'modules', name), 'utf8')
  }
  moduleFiles.background = withSecurityDiagram(moduleFiles.background)
  // A local workspace ships its own image bytes; this compile only needs the references.
  moduleFiles['solution-definition'] = moduleFiles['solution-definition'].replace(/\(asset:[^)]+\)/g, '(diagram.png)')
  return moduleFiles
}

const compileLocally = (version) =>
  runLocalWorkspaceCompute(
    'compile',
    {
      definitionId: 'design',
      definitionVersion: version,
      instanceYaml: instanceYamlOn(version),
      moduleFiles: exampleModuleFiles(),
      artefact: 'soap',
    },
    { definitionsDir: 'definitions' }
  )

test('a local workspace compile hands the browser the numbered markdown for the Word document, and the authored markdown for the .md', async () => {
  const compiled = await compileLocally(OPTED_IN)
  assert.ok(compiled.markdown.includes(SECURITY_FENCE), 'the .md keeps the fence as written')
  assert.doesNotMatch(compiled.markdown, /Diagram \d/)
  // The browser draws the Mermaid picture and labels it with the caption the compile resolved.
  assert.match(compiled.docxMarkdown, /```mermaid \{figure-caption="Diagram 1\. Security architecture"\}\nflowchart LR/)
  assert.match(compiled.docxMarkdown, /!\[Diagram 2\. Take out insurance process\]\(diagram\.png\)/)
  assert.match(compiled.docxMarkdown, /!\[Diagram 3\. Claims handling introductory view\]\(diagram\.png\)/)
})

test('a local workspace compile of an Artefact that does not opt in hands the browser the markdown as compiled', async () => {
  const compiled = await compileLocally(NOT_OPTED_IN)
  assert.equal(compiled.docxMarkdown, compiled.markdown)
})

test('a diagram-captions value that is not true or false is reported, by the server and in a Local Workspace', () => {
  const structure = {
    stages: [{ id: 'one', gate: 'one-gate', modules: ['m'] }],
    artefacts: [
      { id: 'doc', template: 'templates/doc.md.tmpl', gate: 'one-gate', requires: ['m'], diagramCaptions: 'yes' },
      { id: 'other', template: 'templates/doc.md.tmpl', gate: 'one-gate', requires: ['m'], diagramCaptions: true },
    ],
    modules: [{ id: 'm', fields: [{ id: 'f', type: 'markdown' }] }],
  }
  const expected = {
    type: 'invalid-diagram-captions',
    message: 'Artefact "doc" sets "diagram-captions" to "yes" — it must be true or false',
  }
  assert.deepEqual(findDefinitionProblemsInStructure(structure).filter((p) => p.type === 'invalid-diagram-captions'), [expected])
  assert.deepEqual(findLocalDefinitionProblems(structure).filter((p) => p.type === 'invalid-diagram-captions'), [expected])
  // The kebab-case spelling a raw definition.yaml uses is read too.
  const raw = { ...structure, artefacts: [{ ...structure.artefacts[0], diagramCaptions: undefined, 'diagram-captions': 'yes' }] }
  assert.deepEqual(findDefinitionProblemsInStructure(raw).filter((p) => p.type === 'invalid-diagram-captions'), [expected])
})

// Every image Pandoc turns into a captioned figure takes a number, so none is left with a bare
// caption between numbered ones.
test('numberDiagrams numbers an image Pandoc makes a figure directly under a heading', () => {
  assert.equal(numberDiagrams('## H\n![Alpha](x.png)\n'), '## H\n![Diagram 1. Alpha](x.png)\n')
  assert.equal(numberDiagrams('# Top\n## H\n![Alpha](x.png)\n'), '# Top\n## H\n![Diagram 1. Alpha](x.png)\n')
  assert.equal(numberDiagrams('Text\n![Alpha](x.png)\n'), 'Text\n![Alpha](x.png)\n', 'a line of a paragraph is not a figure')
  // After body text, Pandoc reads "## H" as more of the paragraph, so the image is inline.
  assert.equal(numberDiagrams('Text\n## H\n![Alpha](x.png)\n'), 'Text\n## H\n![Alpha](x.png)\n')
  assert.equal(numberDiagrams('#tag\n![Alpha](x.png)\n'), '#tag\n![Alpha](x.png)\n', '"#tag" is not a heading')
})

test('numberDiagrams numbers an image whose alt text holds brackets', () => {
  assert.equal(numberDiagrams('![A [b] c](x.png)\n'), '![Diagram 1. A [b] c](x.png)\n')
})

test('numberDiagrams treats CRLF text as it does LF text', () => {
  const lf = '![Alpha](x.png)\n\n```mermaid {caption="Beta"}\ngraph TD\n```\n'
  assert.equal(numberDiagrams(lf.replace(/\n/g, '\r\n')), numberDiagrams(lf))
  assert.match(numberDiagrams(lf), /!\[Diagram 1\. Alpha\]/)
})
