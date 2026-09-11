import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderArtefact, renderStageArtefacts, prepareAzureDevOpsWasmRender, finishAzureDevOpsWasmRender, externaliseImagesForWasm } from '../lib/render.js'
import { createAsset } from '../lib/assets.js'
import { loadDefinition } from '../lib/definition.js'
import { readModule, writeModule } from '../lib/instance.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsAuthenticationError } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// A minimal real 1x1 red PNG, base64-encoded — small enough to inline, real enough to round-trip through the same file-write/render path a genuine upload takes. Matches the fixture tests/assets.test.js uses.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('dry-run does not write out/ files', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const result = renderArtefact('examples', 'soap', { dryRun: true, instancesDir })
    assert.equal(existsSync(result.docxPath), false)
    assert.equal(existsSync(result.mdPath), false)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dry-run compiles the template without writing anything, with no HTML-entity escaping', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { dryRun: true, instancesDir })
    assert.equal(result.dryRun, true)
    assert.match(result.markdown, /# kiwi-cover-mutual: Solution on a Page/)
    assert.match(result.markdown, /- Claims handling \(register, accept, valuate, pay\)/)
    assert.doesNotMatch(result.markdown, /&#39;|&quot;|&amp;/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// WI #359 — the render dialog's docx/md format toggle. `format` defaults to `'docx'`
// (every pre-#359 caller) when omitted entirely.
test('format: "md" on a local render writes only the .md, produces no .docx at all, and never shells out to pandoc', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const result = renderArtefact('examples', 'soap', { instancesDir, format: 'md' })
    assert.equal(result.format, 'md')
    assert.equal(result.docxPath, null)
    assert.ok(result.mdPath)
    assert.equal(existsSync(result.mdPath), true)
    assert.equal(readFileSync(result.mdPath, 'utf8'), result.markdown)
    // Confirms no .docx landed anywhere in out/ either — this render never invoked pandoc at all.
    assert.equal(existsSync(result.mdPath.replace(/\.md$/, '.docx')), false)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the default (docx) format on a local render does not persist the intermediate .md in out/ — only the .docx a caller asked for', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const result = renderArtefact('examples', 'soap', { instancesDir })
    assert.equal(result.format, 'docx')
    assert.equal(result.mdPath, null)
    assert.equal(existsSync(result.docxPath), true)
    assert.equal(existsSync(result.docxPath.replace(/\.docx$/, '.md')), false)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// WI #360 — a server-hosted (directory-backed) instance's render never lands under the
// instance's own out/ directory at all when delivered to the client; the caller gets the
// bytes back in memory instead.
test('deliverToClient (docx): out/ is never created, docxPath/mdPath are both null, and docxBytes holds a real .docx', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const result = renderArtefact('examples', 'soap', { instancesDir, deliverToClient: true })
    assert.equal(result.format, 'docx')
    assert.equal(result.docxPath, null)
    assert.equal(result.mdPath, null)
    assert.equal(existsSync(join(instancesDir, 'examples', 'out')), false)
    assert.ok(Buffer.isBuffer(result.docxBytes))
    assert.ok(result.docxBytes.length > 0)
    // A real docx (a zip) starts with the local-file-header magic bytes "PK\x03\x04".
    assert.equal(result.docxBytes.subarray(0, 4).toString('hex'), '504b0304')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('deliverToClient (md): out/ is never created, and the markdown is available without any file at all', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const result = renderArtefact('examples', 'soap', { instancesDir, format: 'md', deliverToClient: true })
    assert.equal(result.format, 'md')
    assert.equal(result.docxPath, null)
    assert.equal(result.mdPath, null)
    assert.equal(existsSync(join(instancesDir, 'examples', 'out')), false)
    assert.match(result.markdown, /# kiwi-cover-mutual: Solution on a Page/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('deliverToClient leaves no scratch temp files behind after a docx render', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('gantry-render-')))
    renderArtefact('examples', 'soap', { instancesDir, deliverToClient: true })
    const after = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('gantry-render-')))
    assert.deepEqual([...after].filter((n) => !before.has(n)), [])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('renders the Full SOAP with the reference sections, metadata, static caveats, and markdown tables', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap-full', { instancesDir })
    assert.equal(existsSync(result.docxPath), true)
    assert.match(result.markdown, /# Introduction\n\n## Overview[\s\S]*## Problem statement/)
    for (const heading of [
      'Opportunity',
      'In scope',
      'Out of scope',
      'High level requirements',
      'High level solution overview',
      'Teams required',
      'Dependencies',
      'Assumptions',
      'Estimates',
      'Sequencing',
      'Questions',
      'Caveats',
      'References',
    ]) {
      assert.match(result.markdown, new RegExp(`# ${heading}`))
    }
    assert.match(result.markdown, /\| Section \| Requirement \|/)
    assert.match(result.markdown, /\| Requirement \| Team \| Estimate \| Notes \|/)
    assert.match(result.markdown, /The actual effort will differ once the IT requirements are elaborated/)

    const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], { encoding: 'utf8' })
    assert.match(roundTrip, /Full Solution on a Page/)
    assert.match(roundTrip, /High level requirements/)
    assert.match(roundTrip, /SOAP\/estimate delivered date/)
    // pandoc's markdown writer hard-wraps the round-tripped bullet, so match across the line break.
    assert.match(roundTrip, /The actual effort will differ once the IT requirements are\s+elaborated/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('renders a real docx styled from the HLD reference doc', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { instancesDir })
    assert.equal(existsSync(result.docxPath), true)

    const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
      encoding: 'utf8',
    })
    assert.match(roundTrip, /Solution on a Page/)
    assert.match(roundTrip, /Claims handling \(register, accept, valuate, pay\)/)

    const documentXml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], {
      encoding: 'utf8',
    })
    const headingStyles = [...documentXml.matchAll(/w:pStyle w:val="(Heading\d)"/g)].map((m) => m[1])
    // New document heading scale (ADR-0016): the artefact title and each module title sit at Heading1, every field heading at Heading2 — the templates emit nothing deeper. Author content starts at Heading3: the examples fixture's process-flow field carries `###` sub-headings for its two processes (WI #348), so Heading3 appears too, and nothing below it.
    assert.ok(headingStyles.includes('Heading1'))
    assert.ok(headingStyles.includes('Heading2'))
    assert.deepEqual(
      [...new Set(headingStyles)],
      ['Heading1', 'Heading2', 'Heading3']
    )
    assert.ok((documentXml.match(/<w:numPr>/g) ?? []).length > 0, 'expected real list numbering, not flattened text')

    const referenceStyles = execFileSync(
      'unzip',
      ['-p', 'definitions/design/1/templates/reference.docx', 'word/styles.xml'],
      { encoding: 'utf8' }
    )
    const outputStyles = execFileSync('unzip', ['-p', result.docxPath, 'word/styles.xml'], {
      encoding: 'utf8',
    })
    const fontsOf = (xml) => new Set([...xml.matchAll(/w:ascii="([^"]+)"/g)].map((m) => m[1]))
    const referenceFonts = fontsOf(referenceStyles)
    const outputFonts = fontsOf(outputStyles)
    for (const font of referenceFonts) {
      assert.ok(outputFonts.has(font), `expected ${font} (from the HLD reference doc) in the rendered docx's fonts`)
    }
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('suppressed optional sections do not leave runs of blank lines behind', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'hld', { dryRun: true, instancesDir })
    assert.doesNotMatch(result.markdown, /\n{3,}/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('reference doc defines the paragraph styles pandoc references for list items', () => {
  // The HLD template doesn't itself define "Compact" (pandoc's tight-list style). Word/LibreOffice silently drop a list item's bullet/indent entirely when its w:pStyle points at an undefined style, even though numbering is set directly on the paragraph — build-reference-doc.py merges this (and pandoc's other auxiliary styles) in from pandoc's own default reference doc. If reference.docx is ever regenerated by a plain copy of the HLD source, this catches the regression before the bullets silently vanish again.
  const referenceStyles = execFileSync(
    'unzip',
    ['-p', 'definitions/design/1/templates/reference.docx', 'word/styles.xml'],
    { encoding: 'utf8' }
  )
  assert.match(referenceStyles, /w:styleId="Compact"/)

  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { instancesDir })
    const documentXml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], {
      encoding: 'utf8',
    })
    const outputStyles = execFileSync('unzip', ['-p', result.docxPath, 'word/styles.xml'], {
      encoding: 'utf8',
    })
    const listParagraphStyles = new Set(
      [...documentXml.matchAll(/<w:pPr>(?:(?!<\/w:pPr>).)*?<w:numPr>.*?<w:pStyle w:val="([^"]+)"\/>/gs)].map(
        (m) => m[1]
      )
    )
    for (const styleId of listParagraphStyles) {
      assert.match(outputStyles, new RegExp(`w:styleId="${styleId}"`), `list paragraphs reference an undefined style "${styleId}"`)
    }
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('an asset:<id> reference (#80) inserted into a module field compiles into an embedded image at the same paragraph position in the rendered artefact (#81)', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
    const asset = createAsset(
      'examples',
      {
        filename: 'eligibility-flow.png',
        buffer: pngBytes,
        name: 'Eligibility flow',
        source: 'https://draw.io/diagrams/eligibility-flow',
      },
      { instancesDir }
    )

    const definition = loadDefinition('design')
    const background = readModule(definition, 'examples', 'background', { instancesDir })
    writeModule(
      definition,
      'examples',
      'background',
      {
        status: background.status,
        owner: background.owner,
        fields: {
          ...background.fields,
          problem: `${background.fields.problem}\n\n![Eligibility flow](asset:${asset.id})\n`,
        },
      },
      { instancesDir }
    )

    const result = renderArtefact('examples', 'soap', { instancesDir })
    assert.equal(existsSync(result.docxPath), true)

    // The Pandoc render step resolved the asset reference to the real file in assets/, not a broken/literal "asset:<id>" link.
    assert.doesNotMatch(result.markdown, /asset:/)

    // The final rendered artefact contains an embedded image — not merely a hyperlink or literal text — at the correct paragraph position: the round-tripped markdown places it between the business-driver paragraph the reference was appended to and the next heading ("Affected domains"), matching where the reference appears in the source module field.
    const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
      encoding: 'utf8',
    })
    const documentXml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], {
      encoding: 'utf8',
    })
    assert.match(documentXml, /<w:hyperlink r:id="[^"]+">/, 'expected the source citation URL to be a Word hyperlink')
    const relationshipsXml = execFileSync('unzip', ['-p', result.docxPath, 'word/_rels/document.xml.rels'], {
      encoding: 'utf8',
    })
    assert.match(relationshipsXml, /Target="https:\/\/draw\.io\/diagrams\/eligibility-flow"/)
    // v2 renders the field as "Problem statement" (the same `background.problem` field the reference was appended to).
    const driverIndex = roundTrip.indexOf('Problem statement')
    const imageIndex = roundTrip.indexOf('![Eligibility flow]')
    const affectedDomainsIndex = roundTrip.indexOf('Affected domains')
    assert.ok(driverIndex >= 0 && imageIndex >= 0 && affectedDomainsIndex >= 0)
    assert.ok(driverIndex < imageIndex, 'expected the image after the Problem statement section')
    assert.ok(imageIndex < affectedDomainsIndex, 'expected the image before the next heading, Affected domains')

    // The embedded image is a real, extractable media file in the docx (not just referenced by a URL), and its bytes match what was uploaded.
    const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
    // The examples fixture embeds its own diagrams too (WI #348), so find the media entry whose bytes are the uploaded PNG rather than assuming it is the only image.
    const mediaFiles = mediaListing
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((name) => name && /^word\/media\/.*\.png$/.test(name))
    assert.ok(mediaFiles.length > 0, 'expected embedded PNG media files')
    const matched = mediaFiles.some((name) => execFileSync('unzip', ['-p', result.docxPath, name]).equals(pngBytes))
    assert.ok(matched, 'expected one embedded PNG media file whose bytes match the inserted asset')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// --- Document Control + Review & sign-off tables (WI233) ----------------
//
// The old "Rendered from commit ..." footer line is gone; its hash/date now
// lives in the Document Control table injected right after the title, with a
// Review & sign-off table beneath it. Every definition gets the Document
// Control block via the pipeline; design artefacts are verified for both tables.

test('a local render injects a Document Control table immediately after the title with a plain commit hash and a Pending review row, and no footer line', () => {
  const expectedHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const expectedDate = execFileSync('git', ['log', '-1', '--format=%cs'], { encoding: 'utf8' }).trim()

  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { dryRun: true, instancesDir })
    // Block headings appear in order: title -> Document Control -> Review & sign-off -> first content section
    const titleIdx = result.markdown.indexOf('# kiwi-cover-mutual: Solution on a Page')
    const docIdx = result.markdown.indexOf('## Document Control')
    const reviewIdx = result.markdown.indexOf('## Review & sign-off')
    const contextIdx = result.markdown.indexOf('# Background and context')
    assert.ok(titleIdx >= 0 && docIdx > titleIdx, 'Document Control should be after the title')
    assert.ok(reviewIdx > docIdx, 'Review & sign-off should be after Document Control')
    assert.ok(contextIdx > reviewIdx, 'Content should be after the two tables')

    assert.match(result.markdown, /## Document Control/)
    assert.match(result.markdown, /## Review & sign-off/)
    // Version: design v2 · SOAP (stage title for that gate)
    assert.match(result.markdown, /\| Version \| design v2 · SOAP \|/)
    assert.match(result.markdown, new RegExp(`\\| Date \\| ${escapeRegExp(expectedDate)} \\|`))
    // Local commit: plain code span, not a hyperlink
    assert.match(result.markdown, new RegExp(`\\| Commit \\| \`${escapeRegExp(expectedHash)}\` \\|`))
    assert.doesNotMatch(result.markdown, new RegExp(`\\| Commit \\|.*\\(${escapeRegExp(expectedHash)}`))
    // The old footer line is gone entirely
    assert.doesNotMatch(result.markdown, /Rendered from commit/)
    // Review table shows Pending when no review/sign-off data exists
    assert.match(result.markdown, /\| Pending \|/)
    // Columns follow the reference layout
    assert.match(result.markdown, /\| Name \| Role \/ Title \| Date \| Review process \| Status \| Reference \|/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the Document Control block also survives the pandoc conversion into the rendered .docx, and the hash remains link-free for local', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { instancesDir })
    const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
      encoding: 'utf8',
    })
    assert.match(roundTrip, /Document Control/)
    assert.match(roundTrip, /Review.*sign-off/)
    // Local hash stays as code, not a hyperlink URL
    assert.match(roundTrip, /`[0-9a-f]+`/)
    assert.doesNotMatch(roundTrip, /Rendered from commit/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a definition other than "design" also gets a Document Control block — it is not special-cased to one definition\'s templates', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-definitions-'))
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    cpSync(join(definitionsDir, 'design'), join(definitionsDir, 'another-definition'), { recursive: true })
    // Give the copy a distinct id, matching loadDefinition's "directory must match id" requirement — otherwise it would just be "design" again under a different path, not a genuinely distinct definition.
    for (const version of ['1', '2']) {
      const definitionYamlPath = join(definitionsDir, 'another-definition', version, 'definition.yaml')
      const definitionYaml = readFileSync(definitionYamlPath, 'utf8').replace(/^id: design$/m, 'id: another-definition')
      writeFileSync(definitionYamlPath, definitionYaml)
    }

    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'other-instance'), { recursive: true })
    const instanceYamlPath = join(instancesDir, 'other-instance', 'instance.yaml')
    const instanceYaml = readFileSync(instanceYamlPath, 'utf8').replace(/^definition: design$/m, 'definition: another-definition')
    writeFileSync(instanceYamlPath, instanceYaml)

    const result = renderArtefact('other-instance', 'soap', { dryRun: true, instancesDir, definitionsDir })
    assert.match(result.markdown, /## Document Control/)
    assert.match(result.markdown, /## Review & sign-off/)
    assert.match(result.markdown, /\| Commit \| `[0-9a-f]+`/)
    assert.match(result.markdown, /\| Version \| another-definition v2/)
    assert.doesNotMatch(result.markdown, /Rendered from commit/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

// AB#345: a zip-release install (WI #312) is deliberately Git-free — it never has a .git
// directory at the install dir a local render's commit stamp used to shell out to `git`
// against. That used to fail the entire render with git's own "not a git repository" error;
// it must now succeed, with the Document Control table naming the commit as "unknown".
test('a local render against a directory with no git checkout and no build-info stamp succeeds, naming the commit "unknown" instead of failing', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const notARepoDir = mkdtempSync(join(tmpdir(), 'gantry-not-a-git-repo-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { dryRun: true, repoDir: notARepoDir, instancesDir })
    assert.match(result.markdown, /## Document Control/)
    assert.match(result.markdown, /\| Commit \| `unknown` \|/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(notARepoDir, { recursive: true, force: true })
  }
})

// AB#345 / WI #312: azure-pipelines.zip-release.yml stamps the source commit it packaged
// into `.build-info.json` at the root of the staged output, since that install has no .git
// directory for a live `git` lookup. A local render must read that stamp instead of falling
// back to "unknown" (or to `git`) when it's present.
test('a local render reads a .build-info.json stamp (as a zip-release install ships it) instead of shelling out to git or falling back to "unknown"', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const stampedDir = mkdtempSync(join(tmpdir(), 'gantry-build-info-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    writeFileSync(join(stampedDir, '.build-info.json'), JSON.stringify({ hash: 'abc1234', date: '2024-01-02' }))
    const result = renderArtefact('examples', 'soap', { dryRun: true, repoDir: stampedDir, instancesDir })
    assert.match(result.markdown, /## Document Control/)
    assert.match(result.markdown, /\| Commit \| `abc1234` \|/)
    assert.match(result.markdown, /\| Date \| 2024-01-02 \|/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(stampedDir, { recursive: true, force: true })
  }
})

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Seeds a fake Azure DevOps repo with the exact same instance/module data as the local "examples" fixture, so the Azure-DevOps-backed render tests below exercise the real "soap" template against real content, the same way the local-path tests above do, rather than a bespoke minimal fixture.
function seedExamplesAzureDevOpsFiles() {
  return {
    '/gantry-workspace/examples/instance.yaml': readFileSync('workspaces/examples/kiwi-cover-mutual/instance.yaml', 'utf8'),
    '/gantry-workspace/examples/modules/background.md': exampleModuleText('background'),
    '/gantry-workspace/examples/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/examples/modules/design-basis.md': exampleModuleText('design-basis'),
    '/gantry-workspace/examples/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/examples/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
  }
}

test('a render against Azure DevOps puts a hyperlinked commit in the Document Control table, and the same block ends up in what is actually stored there', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const result = await renderArtefact('examples', 'soap', { azureDevOps })

      // The function's own return value reports the commit its Document Control names — a real (fake-server-assigned) commit hash/date, not a placeholder.
      assert.match(result.commit.hash, /^[0-9a-f]{7}$/)
      assert.match(result.commit.fullHash, /^[0-9a-f]{40}$/)
      assert.match(result.commit.date, /^\d{4}-\d{2}-\d{2}$/)
      const commitLink = '[`' + result.commit.hash + '`](' + baseUrl + `/fake-org/fake-project/_git/fake-repo/commit/${result.commit.fullHash})`
      assert.match(result.markdown, /## Document Control/)
      assert.match(result.markdown, new RegExp(`\\| Commit \\| ${escapeRegExp(commitLink)} \\|`))
      assert.match(result.markdown, new RegExp(`\\| Date \\| ${escapeRegExp(result.commit.date)} \\|`))
      assert.doesNotMatch(result.markdown, /Rendered from commit/)

      // What is actually sitting in the (fake) Azure DevOps repo at out/soap.docx right now — not just the local scratch copy — also carries that exact same Document Control block.
      const client = createAzureDevOpsClient(azureDevOps)
      const pushedContent = await client.getFileContent(result.azureDevOpsPath)
      const pushedMarkdown = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
        input: Buffer.from(pushedContent, 'base64'),
        encoding: 'utf8',
      })
      assert.match(pushedMarkdown, /Document Control/)
      assert.match(pushedMarkdown, new RegExp(`\\[[^\\]]+\\]\\([^)]*${escapeRegExp(result.commit.fullHash)}\\)`))
      assert.match(pushedMarkdown, /Solution on a Page/)
    }
  )
})

test('a dry run against Azure DevOps pushes nothing and has no commit hash in the Document Control — there is no push response to source one from, but the block still appears with Pending', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const result = await renderArtefact('examples', 'soap', { azureDevOps, dryRun: true })

      assert.equal(result.dryRun, true)
      assert.equal(result.commit, undefined)
      assert.doesNotMatch(result.markdown, /Rendered from commit/)
      assert.match(result.markdown, /## Document Control/)
      assert.match(result.markdown, /## Review & sign-off/)
      assert.match(result.markdown, /\| Pending \|/)
      // No hyperlinked hash present for a dry run
      assert.doesNotMatch(result.markdown, /\/commit\//)
    }
  )
})

// Regression test for a review finding: the ADO-backed render path pushes twice (a draft, then the Document-Control-carrying final version) — see renderArtefactFromAzureDevOps's doc comment for why. If the second push fails, the render must surface a clear error naming the commit the first push already landed as, not a bare network error that leaves a reader thinking nothing was written at all.
test('if the follow-up push that adds the Document Control fails, the error names the commit the first-pushed content already landed as', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: seedExamplesAzureDevOpsFiles(),
      // The first (draft) push succeeds; the second (Document Control) push is the one that then fails.
      failAfterPushes: 1,
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      await assert.rejects(() => renderArtefact('examples', 'soap', { azureDevOps }), {
        message: /pushed it to Azure DevOps as commit [0-9a-f]{7}, but the follow-up push that adds the commit-hash\/date Document Control failed/,
      })
    }
  )
})

// WI #359 — the same two-push commit-learning trick (a commit can't truthfully name its own
// hash inside its own content, see pushDraftAndLearnCommit's doc comment) applies unchanged
// when the selected format is markdown, not docx: it just pushes different bytes to a
// differently-extensioned path.
test('format: "md" against Azure DevOps pushes the compiled markdown itself (never a .docx) to a .md path, with an accurate self-referencing commit hash', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const result = await renderArtefact('examples', 'soap', { azureDevOps, format: 'md' })

      assert.equal(result.format, 'md')
      assert.match(result.azureDevOpsPath, /\.md$/)
      assert.match(result.commit.hash, /^[0-9a-f]{7}$/)
      assert.match(result.commit.fullHash, /^[0-9a-f]{40}$/)

      const client = createAzureDevOpsClient(azureDevOps)
      const pushedContent = await client.getFileContent(result.azureDevOpsPath)
      const pushedMarkdown = Buffer.from(pushedContent, 'base64').toString('utf8')
      assert.match(pushedMarkdown, /## Document Control/)
      assert.match(pushedMarkdown, new RegExp(`\\| Commit \\| \\[\`${escapeRegExp(result.commit.hash)}\`\\]`))
      assert.match(pushedMarkdown, /# kiwi-cover-mutual: Solution on a Page/)
      // Not a docx: pandoc's own zip-file magic bytes ("PK") never appear.
      assert.doesNotMatch(pushedContent, /^UEs/) // "PK" as the first two bytes, base64-encoded
    }
  )
})

// Branch-aware storage path (#118): renderArtefact reads instance/module
// data from, and pushes the rendered artefact to, `options.azureDevOps.branch`
// (falling through to the client's own 'main' default when omitted) —
// prep for #122, which renders/commits to a stage's own branch on every
// save.
test('a render against Azure DevOps reads instance/module data from, and pushes the artefact to, the caller-supplied branch — never \'main\'', async () => {
  const branch = 'stage/hld-definition'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      branchFiles: { [branch]: seedExamplesAzureDevOpsFiles() },
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, branch }
      const result = await renderArtefact('examples', 'soap', { azureDevOps })

      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
      const pushedContent = await client.getFileContent(result.azureDevOpsPath, { branch })
      const pushedMarkdown = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
        input: Buffer.from(pushedContent, 'base64'),
        encoding: 'utf8',
      })
      assert.match(pushedMarkdown, /Solution on a Page/)

      // 'main' has no ref at all — nothing was ever read from or pushed to
      // it by this render.
      await assert.rejects(() => client.getFileContent(result.azureDevOpsPath), AzureDevOpsNotFoundError)
    }
  )
})

// --- WI314: the client-side WASM Pandoc render path's server-side halves ---
// (web/lib/pandocWasm.js does the actual browser-side conversion — see tests/pandocWasm.test.js
// and tests/*.playwright.test.js for that half; these tests cover only what still runs here.)

test('a dry run reports which reference-doc file a real render would use, so the WASM render path can fetch its bytes without ever calling pandoc itself', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { dryRun: true, instancesDir })
    assert.equal(result.dryRun, true)
    assert.match(result.referenceDocPath, /reference-soap\.docx$/)
    assert.equal(existsSync(result.referenceDocPath), true)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a real (non-dry-run) render also reports the reference-doc path it just used to pandoc, not just the dry run', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'soap', { instancesDir })
    assert.equal(result.dryRun, false)
    assert.match(result.referenceDocPath, /reference-soap\.docx$/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('an artefact with neither an artefact-specific nor a definition-level reference doc reports referenceDocPath: null, not a path to a file that does not exist', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-definitions-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    for (const version of ['1', '2']) {
      rmSync(join(definitionsDir, 'design', version, 'templates', 'reference.docx'), { force: true })
      rmSync(join(definitionsDir, 'design', version, 'templates', 'reference-soap.docx'), { force: true })
    }
    const result = renderArtefact('examples', 'soap', { dryRun: true, instancesDir, definitionsDir })
    assert.equal(result.referenceDocPath, null)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

test('prepareAzureDevOpsWasmRender pushes a footer-less draft via native pandoc to learn the commit, then returns the Document-Control-complete pass-2 markdown plus the reference-doc path for the browser to convert itself', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const prepared = await prepareAzureDevOpsWasmRender('examples', 'soap', { azureDevOps })

      assert.equal(prepared.dryRun, true)
      assert.match(prepared.commit.hash, /^[0-9a-f]{7}$/)
      assert.match(prepared.commit.fullHash, /^[0-9a-f]{40}$/)
      assert.match(prepared.referenceDocPath, /reference-soap\.docx$/)
      // WI226: basename is "<Instance name> - <Full artefact title>", not the bare artefact id.
      assert.match(prepared.azureDevOpsPath, /gantry-workspace\/examples\/out\/.*\.docx$/)
      assert.equal(prepared.branch, undefined) // no branch was given — matches the native path's own 'main' default handling

      // pass-2's markdown already names the learned commit — the browser converts *this*, not a footer-less draft.
      const commitLink = '[`' + prepared.commit.hash + '`](' + baseUrl + `/fake-org/fake-project/_git/fake-repo/commit/${prepared.commit.fullHash})`
      assert.match(prepared.markdown, new RegExp(`\\| Commit \\| ${escapeRegExp(commitLink)} \\|`))

      // The pass-1 (draft) push already landed — footer-less, immediately about to be overwritten by "finish" below — confirming the two-push shape survived the refactor into prepare/finish.
      const client = createAzureDevOpsClient(azureDevOps)
      const draftContent = await client.getFileContent(prepared.azureDevOpsPath)
      const draftMarkdown = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
        input: Buffer.from(draftContent, 'base64'),
        encoding: 'utf8',
      })
      assert.match(draftMarkdown, /Document Control/)
      assert.doesNotMatch(draftMarkdown, new RegExp(escapeRegExp(prepared.commit.hash)))
    }
  )
})

test('finishAzureDevOpsWasmRender pushes the caller-supplied (browser-converted) bytes verbatim as the final artefact, at the same path prepare named', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const prepared = await prepareAzureDevOpsWasmRender('examples', 'soap', { azureDevOps })

      // Stand-in for "what the browser's pandoc-wasm module produced" — a real, well-formed
      // docx converted from prepare's own pass-2 markdown, via native pandoc, purely so this
      // test can assert on real, well-formed bytes rather than an opaque placeholder Buffer.
      const scratchDir = mkdtempSync(join(tmpdir(), 'gantry-wasm-finish-'))
      const mdPath = join(scratchDir, 'pass2.md')
      const docxPath = join(scratchDir, 'pass2.docx')
      writeFileSync(mdPath, prepared.markdown)
      execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', prepared.referenceDocPath, '-o', docxPath, mdPath])
      const docxBytes = readFileSync(docxPath)
      rmSync(scratchDir, { recursive: true, force: true })

      const finished = await finishAzureDevOpsWasmRender(docxBytes, {
        azureDevOps,
        azureDevOpsPath: prepared.azureDevOpsPath,
        branch: prepared.branch,
        commit: prepared.commit,
        artefactId: 'soap',
      })
      assert.equal(finished.azureDevOpsPath, prepared.azureDevOpsPath)

      const client = createAzureDevOpsClient(azureDevOps)
      const storedContent = await client.getFileContent(prepared.azureDevOpsPath)
      assert.equal(Buffer.from(storedContent, 'base64').toString('base64'), docxBytes.toString('base64'))
    }
  )
})

test('finishAzureDevOpsWasmRender fails with a clear error naming the already-landed draft commit when its own push fails, mirroring the fully-server-side path\'s own failure message', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: seedExamplesAzureDevOpsFiles(),
      // The draft (prepare's own) push succeeds; the "finish" push below is the one that fails.
      failAfterPushes: 1,
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const prepared = await prepareAzureDevOpsWasmRender('examples', 'soap', { azureDevOps })
      await assert.rejects(
        () =>
          finishAzureDevOpsWasmRender(Buffer.from('fake docx bytes'), {
            azureDevOps,
            azureDevOpsPath: prepared.azureDevOpsPath,
            branch: prepared.branch,
            commit: prepared.commit,
            artefactId: 'soap',
          }),
        { message: /pushed it to Azure DevOps as commit [0-9a-f]{7}, but the follow-up push that adds the commit-hash\/date Document Control failed/ }
      )
    }
  )
})

// --- WI233: Review & sign-off populated + gate isolation + no footer anywhere ---

test('a populated reviewSummary renders one review row and one sign-off row with Name/Date/Status/Reference filled, Role/Title and Review process blank when not captured', () => {
  const reviewSummary = {
    version: 'design v1 · Detailed Design',
    stageTitle: 'Detailed Design',
    date: '2024-04-01',
    commit: { hash: 'abc1234', url: undefined, date: '2024-04-01' },
    gateStatus: 'In review',
    rows: [
      {
        name: 'Lisa Haselton',
        role: '',
        date: '2024-04-01',
        process: '',
        status: 'In review',
        reference: { text: '#123', url: 'https://dev.azure.com/fake-org/fake-project/_workitems/edit/123' },
      },
      {
        name: 'Grant Hughson',
        role: '',
        date: '2024-04-02',
        process: '',
        status: 'Approved',
        reference: { text: 'PR #456', url: 'https://dev.azure.com/fake-org/fake-project/_git/fake-repo/pullrequest/456' },
      },
    ],
  }
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'sad', { dryRun: true, reviewSummary, instancesDir })
    assert.match(result.markdown, /## Review & sign-off/)
    // First row: review
    assert.match(result.markdown, /\| Lisa Haselton \| *\| 2024-04-01 \| *\| In review \| \[#123\]\(https:\/\/dev\.azure\.com\/fake-org\/fake-project\/_workitems\/edit\/123\) \|/)
    // Second row: sign-off
    assert.match(result.markdown, /\| Grant Hughson \| *\| 2024-04-02 \| *\| Approved \| \[PR #456\]\(https:\/\/dev\.azure\.com\/fake-org\/fake-project\/_git\/fake-repo\/pullrequest\/456\) \|/)
    // Role / Title and Review process columns are blank (|| with optional spaces)
    // Document Control Status reflects the summary's gateStatus
    assert.match(result.markdown, /\| Status \| In review \|/)
    assert.doesNotMatch(result.markdown, /Rendered from commit/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a draft render with no review/sign-off data still shows a Pending row and no footer — the block is never omitted', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const result = renderArtefact('examples', 'hld', { dryRun: true, instancesDir })
    assert.match(result.markdown, /## Document Control/)
    assert.match(result.markdown, /## Review & sign-off/)
    assert.match(result.markdown, /\| Pending \|/)
    assert.doesNotMatch(result.markdown, /Rendered from commit/)
    const docxRoundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', renderArtefact('examples', 'hld', { instancesDir }).docxPath], { encoding: 'utf8' })
    assert.match(docxRoundTrip, /Document Control/)
    assert.match(docxRoundTrip, /Pending/)
    assert.doesNotMatch(docxRoundTrip, /Rendered from commit/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('review rows reflect only the artefact\'s own gate — a business-case review does not leak into the HLD artefact', () => {
  const businessCaseSummary = {
    version: 'design v2 · SOAP',
    stageTitle: 'SOAP',
    date: '2024-04-01',
    commit: { hash: 'aaaaaaa', date: '2024-04-01' },
    gateStatus: 'In review',
    rows: [{ name: 'Alice', role: '', date: '', process: '', status: 'In review', reference: { text: '#100', url: 'https://example.com/100' } }],
  }
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    const soapResult = renderArtefact('examples', 'soap', { dryRun: true, reviewSummary: businessCaseSummary, instancesDir })
    assert.match(soapResult.markdown, /Alice/)
    assert.match(soapResult.markdown, /#100/)

    // HLD artefact for same slug but different gate — given no summary, it gets
    // its own Pending row, not the business-case review above.
    const hldResult = renderArtefact('examples', 'hld', { dryRun: true, instancesDir })
    assert.doesNotMatch(hldResult.markdown, /Alice/)
    assert.match(hldResult.markdown, /\| Pending \|/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('compileArtefact stays pure — it does not import reviewStatus, stageReview or stageApproval', () => {
  const renderSource = readFileSync('lib/render.js', 'utf8')
  // No import of those modules — data arrives via options.reviewSummary
  assert.doesNotMatch(renderSource, /from ['"]\.\/reviewStatus/)
  assert.doesNotMatch(renderSource, /from ['"]\.\/stageReview/)
  assert.doesNotMatch(renderSource, /from ['"]\.\/stageApproval/)
  assert.doesNotMatch(renderSource, /Rendered from commit/)
})

test('every design artefact (soap, hld, sad, ssad, as-built) renders a Document Control table immediately after its title', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    for (const artefactId of ['soap', 'hld', 'sad', 'ssad', 'as-built']) {
      const result = renderArtefact('examples', artefactId, { dryRun: true, instancesDir })
      assert.match(result.markdown, /## Document Control/, `expected ${artefactId} to have Document Control`)
      assert.match(result.markdown, /## Review & sign-off/, `expected ${artefactId} to have Review & sign-off`)
      assert.doesNotMatch(result.markdown, /Rendered from commit/, `expected ${artefactId} to have no footer`)
    }
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- renderStageArtefacts (#123): render-to-branch on every save ----------

// The Detailed Design stage's own two artefacts (sad/ssad) share the same
// modules but now have field-accurate, divergent requirements (docs/adr/0021),
// while Shape has two SOAP variants with different requirements.
function seedDetailedDesignAzureDevOpsFiles() {
  return {
    '/gantry-workspace/examples/instance.yaml': 'definition: design\nslug: examples\nstage: detailed-design\n',
    '/gantry-workspace/examples/modules/architecture.md': exampleModuleText('architecture'),
    '/gantry-workspace/examples/modules/integration.md': exampleModuleText('integration'),
    '/gantry-workspace/examples/modules/data.md': exampleModuleText('data'),
    '/gantry-workspace/examples/modules/nfrs.md': exampleModuleText('nfrs'),
    '/gantry-workspace/examples/modules/security.md': exampleModuleText('security'),
    '/gantry-workspace/examples/modules/risks.md': exampleModuleText('risks'),
    '/gantry-workspace/examples/modules/dependencies.md': exampleModuleText('dependencies'),
    '/gantry-workspace/examples/modules/support-and-operations.md': exampleModuleText('support-and-operations'),
    // WI #227: `glossary` is a shared module the SAD and SSAD artefacts now reference.
    '/gantry-workspace/examples/modules/glossary.md': exampleModuleText('glossary'),
    // WI #228: `introduction` / `recovery-plan` / `data-security-controls` are now
    // shared into detailed-design and referenced (field-level) by the SAD artefact.
    '/gantry-workspace/examples/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/examples/modules/recovery-plan.md': exampleModuleText('recovery-plan'),
    '/gantry-workspace/examples/modules/data-security-controls.md': exampleModuleText('data-security-controls'),
  }
}

test('renderStageArtefacts renders every one of a stage\'s own artefacts (matched by gate) and commits each to the caller-supplied branch', async () => {
  const branch = 'gantry-workspace/examples/detailed-design'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      branchFiles: { [branch]: seedDetailedDesignAzureDevOpsFiles() },
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, branch }
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'detailed-design')

      const results = await renderStageArtefacts('examples', definition, stage, { azureDevOps })

      assert.deepEqual(
        results.map((r) => r.artefactId),
        ['sad', 'ssad']
      )
      assert.ok(results.every((r) => r.rendered === true), `expected every artefact rendered, got ${JSON.stringify(results)}`)

      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
      for (const result of results) {
        const pushedContent = await client.getFileContent(result.azureDevOpsPath, { branch })
        const pushedBytes = Buffer.from(pushedContent, 'base64')
        assert.equal(pushedBytes.subarray(0, 2).toString(), 'PK', `${result.artefactId} should be a real docx`)
      }
    }
  )
})

test('renderStageArtefacts reports an artefact as skipped, not failed, when its required module data hasn\'t all been saved yet', async () => {
  const branch = 'gantry-workspace/examples/shape'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      // Only "background" has been saved so far — "soap" also requires solution-definition and team-and-estimates, neither of which exist yet, exactly the state a stage is in after its very first module save.
      branchFiles: {
        [branch]: {
          '/gantry-workspace/examples/instance.yaml': 'definition: design\nslug: examples\nstage: shape\n',
          '/gantry-workspace/examples/modules/background.md': exampleModuleText('background'),
        },
      },
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, branch }
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'shape')

      const results = await renderStageArtefacts('examples', definition, stage, { azureDevOps })

      assert.deepEqual(results.map((result) => result.artefactId), ['soap', 'soap-full'])
      assert.ok(results.every((result) => result.rendered === false && result.skipped === true))
      assert.ok(results.every((result) => /has no saved data/.test(result.reason)))

      // Nothing was ever pushed for an artefact that couldn't be rendered.
      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
      await assert.rejects(
        () => client.getFileContent('gantry-workspace/examples/out/Examples - Solution on a Page.docx', { branch }),
        AzureDevOpsNotFoundError
      )
    }
  )
})

test('renderStageArtefacts reports a genuine render failure per-artefact rather than throwing, and still attempts the stage\'s other artefacts', async () => {
  const branch = 'gantry-workspace/examples/detailed-design'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      branchFiles: { [branch]: seedDetailedDesignAzureDevOpsFiles() },
      // The branch's own seed content already counts as its first "push" against this fake server, so failAfterPushes: 1 lets exactly one further real push through (sad's footer-less draft) before every push after it starts failing — including sad's own follow-up footer push and both of ssad's pushes.
      failAfterPushes: 1,
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, branch }
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'detailed-design')

      const results = await renderStageArtefacts('examples', definition, stage, { azureDevOps })

      assert.deepEqual(
        results.map((r) => r.artefactId),
        ['sad', 'ssad']
      )
      for (const result of results) {
        assert.equal(result.rendered, false, `expected ${result.artefactId} to fail to render`)
        assert.equal(result.skipped, undefined, `expected ${result.artefactId}'s failure not to be reported as merely "not ready yet"`)
        assert.ok(result.error, `expected ${result.artefactId} to carry an error message`)
      }
    }
  )
})

test('renderStageArtefacts only considers artefacts belonging to the given stage\'s own gate', async () => {
  const branch = 'gantry-workspace/examples/shape'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      branchFiles: { [branch]: seedExamplesAzureDevOpsFiles() },
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, branch }
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'shape')

      const results = await renderStageArtefacts('examples', definition, stage, { azureDevOps })

      // Both SOAP variants belong to the "business-case" gate the Shape stage closes on — "hld"/"sad"/"ssad"/"as-built" all belong to later stages' gates and must never be attempted here.
      assert.deepEqual(
        results.map((r) => r.artefactId),
        ['soap', 'soap-full']
      )
    }
  )
})

// A rejected PAT is not "a genuine render problem to report per-artefact" — it must propagate exactly like it does from every other Azure-DevOps-backed aggregation in this codebase (e.g. lib/status.js's evaluateStageFromAzureDevOps), so the server's credential-gating layer can still turn it into the structured "authentication required" response instead of it being silently folded into a 200 alongside an unrelated per-artefact error string.
test('renderStageArtefacts propagates AzureDevOpsAuthenticationError rather than swallowing it as a per-artefact error', async () => {
  const branch = 'gantry-workspace/examples/shape'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {},
      branchFiles: { [branch]: seedExamplesAzureDevOpsFiles() },
    },
    async (baseUrl) => {
      const azureDevOps = {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        pat: 'a-pat-the-server-does-not-recognize',
        baseUrl,
        branch,
      }
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'shape')

      await assert.rejects(
        () => renderStageArtefacts('examples', definition, stage, { azureDevOps }),
        AzureDevOpsAuthenticationError
      )
    }
  )
})

// ---------- WI #367: images for the browser-side (pandoc-wasm) render leg ----------
//
// The compiled markdown points every image at an absolute path on the machine running `gantry
// serve`. The native leg hands that straight to a local `pandoc`, which reads it; the WASM leg hands
// it to pandoc-wasm in the browser, whose virtual filesystem has no such file — so Pandoc dropped
// the image with no warning and no failed render. These pin the rewrite that lets the bytes travel.

test('externaliseImagesForWasm rewrites absolute image paths to virtual names and returns their bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-wasm-images-'))
  try {
    const imagePath = join(dir, 'diagram.png')
    writeFileSync(imagePath, Buffer.from('not-really-a-png-but-real-bytes'))

    const { markdown, files } = externaliseImagesForWasm(`intro\n\n![A diagram](${imagePath})\n\ntail\n`)

    const names = Object.keys(files)
    assert.equal(names.length, 1)
    assert.match(names[0], /^gantry-asset-1\.png$/)
    assert.match(markdown, new RegExp(`!\\[A diagram\\]\\(${names[0]}\\)`))
    assert.doesNotMatch(markdown, /\/tmp\//, 'no absolute server path may survive into the browser-bound markdown')
    assert.equal(Buffer.from(files[names[0]], 'base64').toString(), 'not-really-a-png-but-real-bytes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('externaliseImagesForWasm ships one copy of an image referenced twice, and leaves unresolvable refs alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-wasm-images-'))
  try {
    const imagePath = join(dir, 'shared.jpeg')
    writeFileSync(imagePath, Buffer.from('shared-bytes'))

    const { markdown, files } = externaliseImagesForWasm(
      `![one](${imagePath})\n\n![two](${imagePath})\n\n![gone](${join(dir, 'missing.png')})\n\n![relative](assets/kept.png)\n`
    )

    assert.equal(Object.keys(files).length, 1, 'the same file referenced twice is shipped once')
    const name = Object.keys(files)[0]
    assert.equal((markdown.match(new RegExp(name, 'g')) ?? []).length, 2, 'both references point at the one virtual name')
    // A reference that resolves to nothing was never going to embed; rewriting it would only make
    // the resulting document harder to explain, so it is left exactly as the author wrote it.
    assert.match(markdown, /!\[gone\]\(.*missing\.png\)/)
    assert.match(markdown, /!\[relative\]\(assets\/kept\.png\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('externaliseImagesForWasm is a no-op for markdown with no images', async () => {
  const { markdown, files } = externaliseImagesForWasm('# Heading\n\nJust prose, no pictures.\n')
  assert.deepEqual(files, {})
  assert.equal(markdown, '# Heading\n\nJust prose, no pictures.\n')
})
