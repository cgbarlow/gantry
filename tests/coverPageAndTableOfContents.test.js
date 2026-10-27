import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { program } from '../bin/gantry.js'
import { renderArtefact, prepareAzureDevOpsWasmRender } from '../lib/render.js'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems, findDefinitionProblemsInStructure, writeDefinitionVersion } from '../lib/definition.js'
import { runLocalWorkspaceCompute } from '../lib/localWorkspace.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { loadAzureDevOpsDefinition, writeAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { docxPart, expectedTableOfContents, headingBookmarks, tableOfContents, wordStyles } from './helpers/wordDocx.js'

// #194 (spec #192, ADR-0052): two opt-in Artefact keys put front matter on a rendered document.
// `cover-page: true` opens it with a cover (classification, title, version, status, author and the
// Artefact's purpose) and a page break; `table-of-contents: true` adds a "Table of Contents" heading
// and a Word TOC field after Document Control. `cover-classification: <module>.<field>` names the
// Field whose value the cover prints as its classification. Like `document-control: false`
// (ADR-0049) they are honoured in the one compile step every render path goes through, so these
// tests drive a spread of paths against a scratch copy of recruitment-onboarding v2 whose
// Appointment Case sets them. The bundled Definition is never touched.

const SLUG = 'platform-engineer'
const EXAMPLE_DIR = `tests/fixtures/recruitment-onboarding-v2/${SLUG}`
const FILENAME_LINE = '    filename: "{selection.candidate-name} - Appointment Case"\n'
const H1 = '# Platform Engineer: Appointment Case'
const FIRST_SECTION = '# The appointment'
const PURPOSE = 'Present the case for appointing this candidate, and the contract and payroll position that releases onboarding.'
const PAGE_BREAK = '<w:br w:type="page"/>'
const TOC_FIELD = /<w:fldChar w:fldCharType="begin" w:dirty="true"\/>.*<w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u <\/w:instrText>/

// A scratch definitions dir holding recruitment-onboarding with `lines` added to the Appointment
// Case (v2), and optionally `edit` applied to the whole definition.yaml.
async function withDefinitions(lines, fn, edit = (yaml) => yaml) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-front-matter-defs-'))
  try {
    cpSync('definitions/recruitment-onboarding', join(definitionsDir, 'recruitment-onboarding'), { recursive: true })
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const edited = edit(yaml.replace(FILENAME_LINE, `${FILENAME_LINE}${lines.map((line) => `    ${line}\n`).join('')}`))
    assert.notEqual(edited, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, edited)
    return await fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

async function withInstancesDir(fn, editModules = () => {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-front-matter-instances-'))
  try {
    cpSync(EXAMPLE_DIR, join(instancesDir, SLUG), { recursive: true })
    editModules(join(instancesDir, SLUG, 'modules'))
    return await fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const COMMIT = { hash: 'abc1234', fullHash: 'abc1234def5678abc1234def5678abc1234def5', date: '2026-01-02' }

function compile(definitionsDir, instancesDir, artefactId = 'appointment-case') {
  return renderArtefact(SLUG, artefactId, { dryRun: true, instancesDir, definitionsDir, commit: COMMIT }).markdown
}

// Asserts each needle occurs in `markdown`, in this order.
function assertInOrder(markdown, needles) {
  let from = -1
  for (const needle of needles) {
    const at = markdown.indexOf(needle, from + 1)
    assert.ok(at > from, `expected ${JSON.stringify(needle)} after ${JSON.stringify(needles[needles.indexOf(needle) - 1] ?? '(start)')}`)
    from = at
  }
}

function coverOf(markdown) {
  const end = markdown.indexOf(PAGE_BREAK)
  assert.ok(end > 0, 'the cover ends with a page break')
  return markdown.slice(0, end)
}

const FULL_FRONT_MATTER = ['cover-page: true', 'cover-classification: engagement.type', 'table-of-contents: true']

// ── What the compile step produces ──────────────────────────────────────────────────────────────

test('cover-page: true opens the document with a cover — title, version, status, author and purpose — then a page break, then Document Control', async () => {
  await withDefinitions(['cover-page: true'], (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assert.ok(markdown.startsWith('::: {custom-style="Title"}\nPlatform Engineer\n:::'), `the document opens with the cover's title, got:\n${markdown.slice(0, 200)}`)
      const cover = coverOf(markdown)
      assert.match(cover, /::: \{custom-style="Subtitle"\}\nAppointment Case\n:::/)
      assert.match(cover, /\*\*Version:\*\* recruitment-onboarding v2 · Appointment/)
      assert.match(cover, /\*\*Status:\*\* Draft/)
      assert.match(cover, /\*\*Author:\*\* c\.barlow/, 'the author is the instance\'s Assignee')
      assert.ok(cover.includes(PURPOSE), 'the Artefact\'s purpose')
      assert.doesNotMatch(cover, /^#/m, 'no heading or section content on the cover')
      assert.doesNotMatch(cover, /!\[|```mermaid/, 'no diagrams on the cover')
      assert.doesNotMatch(cover, /Cover Classification/, 'no classification without cover-classification')
      assertInOrder(markdown, [PAGE_BREAK, '## Document Control', '## Review & sign-off', H1, FIRST_SECTION])
      assert.ok(!markdown.includes('Table of Contents'), 'no table of contents unless asked for')
    })
  )
})

test('the cover prints the classification from the Field cover-classification names, and leaves it out when that Field is blank', async () => {
  await withDefinitions(['cover-page: true', 'cover-classification: engagement.type'], async (definitionsDir) => {
    await withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assert.ok(markdown.startsWith('::: {custom-style="Cover Classification"}\nPermanent\n:::\n\n::: {custom-style="Title"}'), markdown.slice(0, 200))
    })
    await withInstancesDir(
      (instancesDir) => {
        const cover = coverOf(compile(definitionsDir, instancesDir))
        assert.doesNotMatch(cover, /Cover Classification/)
        assert.match(cover, /custom-style="Title"/)
      },
      (modulesDir) => {
        const path = join(modulesDir, 'engagement.md')
        const text = readFileSync(path, 'utf8')
        const blanked = text.replace('## Engagement type\n\nPermanent\n', '## Engagement type\n\n')
        assert.notEqual(blanked, text, 'the fixture edit must land')
        writeFileSync(path, blanked)
      }
    )
  })
})

test('the cover leaves out the author when the instance has no Assignee', async () => {
  await withDefinitions(['cover-page: true'], (definitionsDir) =>
    withInstancesDir(
      (instancesDir) => {
        const cover = coverOf(compile(definitionsDir, instancesDir))
        assert.doesNotMatch(cover, /Author/)
        assert.match(cover, /\*\*Status:\*\* Draft/)
      },
      (modulesDir) => {
        const path = join(modulesDir, '..', 'instance.yaml')
        writeFileSync(path, readFileSync(path, 'utf8').replace('assignee: c.barlow', "assignee: ''"))
      }
    )
  )
})

test('table-of-contents: true puts a "Table of Contents" heading and a Word TOC field (levels 1–3) after Document Control and before the first section', async () => {
  await withDefinitions(['table-of-contents: true'], (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assert.ok(markdown.startsWith(`${H1}\n`), 'no cover unless asked for: the title still opens the document')
      assertInOrder(markdown, [H1, '## Document Control', '## Review & sign-off', '::: {custom-style="TOC Heading"}\nTable of Contents\n:::', '```{=openxml}', FIRST_SECTION])
      assert.match(markdown, TOC_FIELD, 'a TOC field Word refreshes when the document is opened (w:dirty)')
      const toc = markdown.slice(markdown.indexOf('Table of Contents'), markdown.indexOf(FIRST_SECTION))
      assert.ok(toc.includes(PAGE_BREAK), 'the first section starts on a fresh page')
    })
  )
})

test('with all three keys the order is cover, page break, Document Control, Review & sign-off, table of contents, then the template\'s own output', async () => {
  await withDefinitions(FULL_FRONT_MATTER, (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assertInOrder(markdown, ['Cover Classification', 'custom-style="Title"', PAGE_BREAK, '## Document Control', '## Review & sign-off', 'Table of Contents', 'TOC \\o', H1, FIRST_SECTION])
    })
  )
})

test('with document-control: false the table of contents follows the cover', async () => {
  await withDefinitions([...FULL_FRONT_MATTER, 'document-control: false'], (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assert.ok(!markdown.includes('## Document Control') && !markdown.includes('## Review & sign-off'))
      assertInOrder(markdown, ['custom-style="Title"', PAGE_BREAK, 'Table of Contents', 'TOC \\o', H1, FIRST_SECTION])
      // The cover still carries the version and status the Document Control table would have.
      assert.match(coverOf(markdown), /\*\*Version:\*\* recruitment-onboarding v2 · Appointment/)
    })
  )
})

test('with document-control: false and no cover the table of contents comes first, straight under the title', async () => {
  await withDefinitions(['table-of-contents: true', 'document-control: false'], (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir)
      assert.ok(markdown.startsWith(`${H1}\n\n::: {custom-style="TOC Heading"}\nTable of Contents\n:::`), markdown.slice(0, 200))
      assertInOrder(markdown, ['TOC \\o', FIRST_SECTION])
    })
  )
})

test('explicit false for both keys compiles exactly as leaving them out', async () => {
  await withInstancesDir(async (instancesDir) => {
    const without = compile('definitions', instancesDir)
    await withDefinitions(['cover-page: false', 'table-of-contents: false', 'cover-classification: engagement.type'], (definitionsDir) => {
      assert.equal(compile(definitionsDir, instancesDir), without)
    })
  })
})

test('only the Artefact that sets the keys gets front matter', async () => {
  await withDefinitions(FULL_FRONT_MATTER, (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const markdown = compile(definitionsDir, instancesDir, 'selection-report')
      assert.ok(markdown.startsWith('# Platform Engineer: Selection Report\n'))
      assert.ok(!markdown.includes('custom-style') && !markdown.includes('Table of Contents'))
    })
  )
})

// ── Every render path compiles through the same step ────────────────────────────────────────────

function assertFrontMatter(markdown) {
  assertInOrder(markdown, ['::: {custom-style="Cover Classification"}\nPermanent', 'custom-style="Title"', PAGE_BREAK, '## Document Control', 'Table of Contents', 'TOC \\o', H1])
}

test('`gantry render --dry-run` prints the cover and table of contents', async () => {
  program.exitOverride()
  await withDefinitions(FULL_FRONT_MATTER, (definitionsDir) =>
    withInstancesDir(async (instancesDir) => {
      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        await program.parseAsync(['node', 'gantry.js', 'render', SLUG, 'appointment-case', '--dry-run', '--instances-dir', instancesDir, '--definitions-dir', definitionsDir])
      } finally {
        console.log = origLog
      }
      assertFrontMatter(logs.join('\n'))
    })
  )
})

function localWorkspacePayload(structure) {
  const definitionDir = 'definitions/recruitment-onboarding/2'
  const templates = {}
  for (const name of readdirSync(join(definitionDir, 'templates'))) {
    if (name.endsWith('.md.tmpl')) templates[name] = readFileSync(join(definitionDir, 'templates', name), 'utf8')
  }
  const moduleFiles = {}
  for (const name of readdirSync(join(EXAMPLE_DIR, 'modules'))) {
    moduleFiles[name.replace(/\.md$/, '')] = readFileSync(join(EXAMPLE_DIR, 'modules', name), 'utf8')
  }
  return {
    definitionId: 'recruitment-onboarding',
    definitionVersion: 2,
    instanceYaml: readFileSync(join(EXAMPLE_DIR, 'instance.yaml'), 'utf8'),
    moduleFiles,
    definition: { structure, templates },
  }
}

function structureWithFrontMatter() {
  const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
  Object.assign(structure.artefacts.find((a) => a.id === 'appointment-case'), { coverPage: true, coverClassification: 'engagement.type', tableOfContents: true })
  return structure
}

test('a Local Workspace render against its own inline Definition (the browser path) gets the cover and table of contents', async () => {
  const compiled = await runLocalWorkspaceCompute('compile', { ...localWorkspacePayload(structureWithFrontMatter()), artefact: 'appointment-case' })
  assertFrontMatter(compiled.markdown)
})

const ADO = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo', validPat: 'valid-test-pat' }

function exampleWorkspaceFiles() {
  const files = { [`/gantry-workspace/${SLUG}/instance.yaml`]: readFileSync(join(EXAMPLE_DIR, 'instance.yaml'), 'utf8') }
  for (const name of readdirSync(join(EXAMPLE_DIR, 'modules'))) {
    files[`/gantry-workspace/${SLUG}/modules/${name}`] = readFileSync(join(EXAMPLE_DIR, 'modules', name), 'utf8')
  }
  return files
}

test('an Azure DevOps render pushes the cover and table of contents, and its WASM prepare hands them to the browser', async () => {
  await withDefinitions(FULL_FRONT_MATTER, (definitionsDir) =>
    withFakeAzureDevOpsServer({ ...ADO, files: exampleWorkspaceFiles() }, async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-front-matter-scratch-'))
      try {
        const azureDevOps = { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl }
        const result = await renderArtefact(SLUG, 'appointment-case', { azureDevOps, definitionsDir, instancesDir, format: 'md' })
        const pushed = Buffer.from(await createAzureDevOpsClient(azureDevOps).getFileContent(result.azureDevOpsPath), 'base64').toString('utf8')
        assertFrontMatter(pushed)

        const prepared = await prepareAzureDevOpsWasmRender(SLUG, 'appointment-case', { azureDevOps, definitionsDir, instancesDir })
        assertFrontMatter(prepared.markdown)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  )
})

// ── The Word document, from both converters ─────────────────────────────────────────────────────

// Positions in word/document.xml, in body order, of the parts the front matter is made of.
function assertWordFrontMatter(documentXml) {
  const at = (pattern, what) => {
    const match = pattern.exec(documentXml)
    assert.ok(match, `${what} is in the document`)
    return match.index
  }
  const order = [
    at(/<w:pStyle w:val="CoverClassification" \/><\/w:pPr><w:r><w:t xml:space="preserve">Permanent</, 'the cover classification'),
    at(/<w:pStyle w:val="Title" \/><\/w:pPr><w:r><w:t xml:space="preserve">Platform Engineer</, 'the cover title'),
    at(/<w:br w:type="page" ?\/>/, 'the page break after the cover'),
    at(/>Document Control</, 'Document Control'),
    at(/<w:pStyle w:val="TOCHeading" \/><\/w:pPr><w:r><w:t xml:space="preserve">Table of Contents</, 'the Table of Contents heading'),
    at(/<w:fldChar w:fldCharType="begin" w:dirty="true" ?\/>/, 'a TOC field Word refreshes on open'),
    at(/>The appointment</, 'the first section'),
  ]
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'cover, page break, Document Control, table of contents, first section')
  assert.match(documentXml, /<w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u <\/w:instrText>/)
}

// #206: the field's result lists the document's headings, as Word would before page numbers. This
// Definition's reference document numbers no headings, so neither do the entries.
function assertTableOfContentsFilledIn(docx) {
  const documentXml = docxPart(docx, 'word/document.xml')
  const toc = tableOfContents(documentXml)
  assert.equal(toc.dirty, true, 'Word still rebuilds it on open')
  const expected = expectedTableOfContents(documentXml, wordStyles(docxPart(docx, 'word/styles.xml')), docxPart(docx, 'word/numbering.xml'))
  assert.deepEqual(toc.entries.map(({ style, text }) => ({ style, text })), expected.map(({ style, text }) => ({ style, text })))
  assert.deepEqual(
    toc.entries.slice(0, 4).map(({ style, text }) => [style, text]),
    [['TOC2', 'Document Control'], ['TOC2', 'Review & sign-off'], ['TOC1', 'Platform Engineer: Appointment Case'], ['TOC1', 'The appointment']]
  )
  const bookmarks = headingBookmarks(documentXml)
  for (const [i, entry] of toc.entries.entries()) assert.equal(bookmarks.get(entry.anchor)?.heading, expected[i].heading, entry.text)
}

test('the native Pandoc render (CLI and server) writes the cover and a self-refreshing TOC field into the .docx', async () => {
  await withDefinitions(FULL_FRONT_MATTER, (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const result = renderArtefact(SLUG, 'appointment-case', { instancesDir, definitionsDir, commit: COMMIT })
      assertWordFrontMatter(execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], { encoding: 'utf8' }))
      assertTableOfContentsFilledIn(result.docxPath)
    })
  )
})

test('the browser\'s pandoc-wasm writes the same cover and self-refreshing TOC field from the same Markdown', async () => {
  const compiled = await runLocalWorkspaceCompute('compile', { ...localWorkspacePayload(structureWithFrontMatter()), artefact: 'appointment-case' })
  // The same converter build web/lib/pandocWasm.js loads in the browser, through its Node entry.
  const { convert } = await import(new URL('../node_modules/pandoc-wasm/src/index.node.js', import.meta.url))
  // The inline Definition ships templates only, so give it the reference document v2 itself uses.
  const files = { 'reference.docx': new Blob([readFileSync('definitions/recruitment-onboarding/2/templates/reference.docx')]) }
  // What the browser converts is the compile's `docxMarkdown`, the Word conversion's Markdown.
  const result = await convert({ from: 'markdown', to: 'docx', 'output-file': 'output.docx', 'reference-doc': 'reference.docx' }, compiled.docxMarkdown, files)
  const scratch = mkdtempSync(join(tmpdir(), 'gantry-front-matter-wasm-'))
  try {
    const docxPath = join(scratch, 'output.docx')
    writeFileSync(docxPath, new Uint8Array(await result.files['output.docx'].arrayBuffer()))
    assertWordFrontMatter(execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' }))
    assertTableOfContentsFilledIn(docxPath)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('with no heading to list, the table of contents keeps its one-line placeholder (#206)', async () => {
  await withDefinitions(['document-control: false', 'table-of-contents: true'], (definitionsDir) =>
    withInstancesDir((instancesDir) => {
      writeFileSync(join(definitionsDir, 'recruitment-onboarding', '2', 'templates', 'appointment-case.md.tmpl'), 'A document with no headings at all.\n\n```markdown\n# Not a heading: it is code\n```\n')
      const { docxMarkdown } = renderArtefact(SLUG, 'appointment-case', { dryRun: true, instancesDir, definitionsDir, commit: COMMIT })
      assert.match(docxMarkdown, TOC_FIELD)
      assert.ok(docxMarkdown.includes('<w:r><w:t>Open this document in Word, or update this field, to build the table of contents.</w:t></w:r>'))
      assert.doesNotMatch(docxMarkdown, /w:val="TOC1"/)
    })
  )
})

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

const BOOLEAN_KEYS = [
  { key: 'cover-page', camel: 'coverPage', type: 'invalid-cover-page' },
  { key: 'table-of-contents', camel: 'tableOfContents', type: 'invalid-table-of-contents' },
]

for (const { key, camel, type } of BOOLEAN_KEYS) {
  test(`a non-boolean ${key} is reported on disk, but the Definition still loads and renders without that front matter`, async () => {
    await withDefinitions([`${key}: "yes"`], (definitionsDir) =>
      withInstancesDir((instancesDir) => {
        const problems = findDefinitionProblems('recruitment-onboarding', { definitionsDir, version: 2 })
        assert.deepEqual(problems.map((p) => p.type), [type])
        assert.equal(problems[0].message, `Artefact "appointment-case" sets "${key}" to "yes" — it must be true or false`)
        assert.equal(loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 }).artefacts.find((a) => a.id === 'appointment-case')[camel], 'yes')
        const markdown = compile(definitionsDir, instancesDir)
        assert.ok(markdown.startsWith(`${H1}\n`) && !markdown.includes('Table of Contents'), 'only a real true turns it on')
      })
    )
  })

  test(`a non-boolean ${key} is a problem in an in-memory structure (save, Provider publish) and a Local Workspace; true and false are not`, () => {
    const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
    const artefact = structure.artefacts.find((a) => a.id === 'appointment-case')
    artefact[camel] = 'yes'
    for (const problems of [findDefinitionProblemsInStructure(structure), findLocalDefinitionProblems(structure)]) {
      assert.deepEqual(problems.map((p) => p.type), [type])
      assert.equal(problems[0].message, `Artefact "appointment-case" sets "${key}" to "yes" — it must be true or false`)
    }
    for (const value of [true, false]) {
      artefact[camel] = value
      assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
      assert.deepEqual(findLocalDefinitionProblems(structure), [])
    }
  })
}

const CLASSIFICATION_CASES = [
  {
    name: 'a value that is not a module.field reference',
    artefact: 'appointment-case',
    value: 'classification',
    message: 'Artefact "appointment-case" sets "cover-classification" to "classification" — it must name one field as "module.field"',
  },
  {
    name: 'a value that is not a string',
    artefact: 'appointment-case',
    value: true,
    message: 'Artefact "appointment-case" sets "cover-classification" to true — it must name one field as "module.field"',
  },
  {
    name: 'a field the Definition does not have',
    artefact: 'appointment-case',
    value: 'engagement.marking',
    message: 'Artefact "appointment-case" cover-classification: "engagement.marking" is not a field in this definition',
  },
  {
    name: 'a markdown field',
    artefact: 'appointment-case',
    value: 'role.summary',
    message: 'Artefact "appointment-case" cover-classification: "role.summary" is type "markdown" — only a single-valued select or text field can classify a document',
  },
  {
    name: 'a multiple: true select',
    artefact: 'selection-report',
    value: 'advertising.channels',
    message: 'Artefact "selection-report" cover-classification: "advertising.channels" is type "select" with multiple: true — only a single-valued select or text field can classify a document',
  },
  {
    name: 'a field outside the Artefact\'s own requires',
    artefact: 'requisition-brief',
    value: 'offer.status',
    message: 'Artefact "requisition-brief" cover-classification: "offer.status" is not in this artefact\'s own "requires" list',
  },
]

for (const { name, artefact, value, message } of CLASSIFICATION_CASES) {
  test(`cover-classification naming ${name} is an invalid-cover-classification problem everywhere`, async () => {
    const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
    structure.artefacts.find((a) => a.id === artefact).coverClassification = value
    for (const problems of [findDefinitionProblemsInStructure(structure), findLocalDefinitionProblems(structure)]) {
      assert.deepEqual(problems.map((p) => [p.type, p.message]), [['invalid-cover-classification', message]])
    }
    const onDisk = (yaml) => yaml.replace(`  - id: ${artefact}\n`, `  - id: ${artefact}\n    cover-classification: ${JSON.stringify(value)}\n`)
    await withDefinitions([], (definitionsDir) => {
      const problems = findDefinitionProblems('recruitment-onboarding', { definitionsDir, version: 2 })
      assert.deepEqual(problems.map((p) => [p.type, p.message]), [['invalid-cover-classification', message]])
      assert.doesNotThrow(() => loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 }), 'authoring-only: existing instances keep loading')
    }, onDisk)
  })
}

test('a cover-classification on an optional (?) requirement or a whole required module is accepted', () => {
  const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
  const brief = structure.artefacts.find((a) => a.id === 'requisition-brief')
  brief.coverClassification = 'engagement.type'
  brief.requires = brief.requires.map((r) => (r === 'engagement.type' ? 'engagement.type?' : r))
  assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  brief.requires = [...brief.requires.filter((r) => !r.startsWith('engagement.')), 'engagement']
  assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  assert.deepEqual(findLocalDefinitionProblems(structure), [])
})

test('saving a draft refuses a non-boolean cover-page or a bad cover-classification, and keeps valid front matter', async () => {
  await withDefinitions([], (definitionsDir) => {
    const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 }))
    const appointmentCase = structure.artefacts.find((a) => a.id === 'appointment-case')

    Object.assign(appointmentCase, { coverPage: 'yes', tableOfContents: true, coverClassification: 'role.summary' })
    const refused = writeDefinitionVersion('recruitment-onboarding', 2, structure, { definitionsDir })
    assert.deepEqual(refused.problems.map((p) => p.type).sort(), ['invalid-cover-classification', 'invalid-cover-page'])

    Object.assign(appointmentCase, { coverPage: true, coverClassification: 'engagement.type' })
    const saved = writeDefinitionVersion('recruitment-onboarding', 2, structure, { definitionsDir })
    assert.equal(saved.problems, undefined, JSON.stringify(saved.problems))
    const reloaded = loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 })
    const reloadedCase = reloaded.artefacts.find((a) => a.id === 'appointment-case')
    assert.equal(reloadedCase.coverPage, true)
    assert.equal(reloadedCase.tableOfContents, true)
    assert.equal(reloadedCase.coverClassification, 'engagement.type')
    assert.equal(reloaded.artefacts.find((a) => a.id === 'offer-pack').coverPage, undefined)
  }, (yaml) => yaml.replace(/^status: published$/m, 'status: draft'))
})

// A Provider's Definition loader doesn't validate on read, so a hand-edited `yes` in a Provider draft
// has to reach the projection the Definitions page edits, or Save would delete it without a word.
test('a Provider draft\'s non-boolean table-of-contents reaches the Definitions page projection, which Save refuses', async () => {
  const definitionDir = 'definitions/recruitment-onboarding/2'
  const yaml = readFileSync(join(definitionDir, 'definition.yaml'), 'utf8')
  const edited = yaml.replace(/^status: published$/m, 'status: draft').replace(FILENAME_LINE, `${FILENAME_LINE}    table-of-contents: yes\n`)
  assert.equal(edited.split('table-of-contents: yes').length, 2, 'the fixture edit must land')
  const files = { '/definitions/recruitment-onboarding/2/definition.yaml': edited }
  for (const name of readdirSync(join(definitionDir, 'modules'))) {
    files[`/definitions/recruitment-onboarding/2/modules/${name}`] = readFileSync(join(definitionDir, 'modules', name), 'utf8')
  }
  await withFakeAzureDevOpsServer({ ...ADO, files }, async (baseUrl) => {
    const options = { azureDevOps: { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl } }
    const projection = definitionVersionProjection(await loadAzureDevOpsDefinition('recruitment-onboarding', 2, options))
    assert.equal(projection.artefacts.find((a) => a.id === 'appointment-case').tableOfContents, 'yes')
    const saved = await writeAzureDevOpsDefinitionVersion('recruitment-onboarding', 2, projection, options)
    assert.deepEqual(saved.problems?.map((p) => p.type), ['invalid-table-of-contents'])
  })
})
