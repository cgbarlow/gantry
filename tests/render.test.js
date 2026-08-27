import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderArtefact, renderStageArtefacts } from '../lib/render.js'
import { createAsset } from '../lib/assets.js'
import { loadDefinition } from '../lib/definition.js'
import { readModule, writeModule } from '../lib/instance.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsAuthenticationError } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// A minimal real 1x1 red PNG, base64-encoded — small enough to inline, real enough to round-trip through the same file-write/render path a genuine upload takes. Matches the fixture tests/assets.test.js uses.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('dry-run does not write out/ files', () => {
  execFileSync('rm', ['-rf', 'instances/examples/out'])
  const result = renderArtefact('examples', 'soap', { dryRun: true })
  assert.equal(existsSync(result.docxPath), false)
  assert.equal(existsSync(result.mdPath), false)
})

test('dry-run compiles the template without writing anything, with no HTML-entity escaping', () => {
  const result = renderArtefact('examples', 'soap', { dryRun: true })
  assert.equal(result.dryRun, true)
  assert.match(result.markdown, /# examples: Solution on a Page/)
  assert.match(result.markdown, /- Client-facing self-service \(ContosoSelfService\)/)
  assert.doesNotMatch(result.markdown, /&#39;|&quot;|&amp;/)
})

test('renders the Full SOAP with the reference sections, metadata, static caveats, and markdown tables', () => {
  const result = renderArtefact('examples', 'soap-full')
  assert.equal(existsSync(result.docxPath), true)
  assert.match(result.markdown, /# Introduction\n\n## Problem statement/)
  for (const heading of [
    'Opportunity',
    'In Scope',
    'Out of Scope',
    'High Level Requirements',
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
  assert.match(result.markdown, /Cost is based on full AST team allocation/)

  const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], { encoding: 'utf8' })
  assert.match(roundTrip, /Full Solution on a Page/)
  assert.match(roundTrip, /High Level Requirements/)
  assert.match(roundTrip, /SOAP\/estimate delivered date/)
  assert.match(roundTrip, /Cost is based on full AST team allocation/)
})

test('renders a real docx styled from the HLD reference doc', () => {
  const result = renderArtefact('examples', 'soap')
  assert.equal(existsSync(result.docxPath), true)

  const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
    encoding: 'utf8',
  })
  assert.match(roundTrip, /Solution on a Page/)
  assert.match(roundTrip, /Client-facing self-service/)

  const documentXml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], {
    encoding: 'utf8',
  })
  const headingStyles = [...documentXml.matchAll(/w:pStyle w:val="(Heading\d)"/g)].map((m) => m[1])
  // New document heading scale (ADR-0016): the artefact title and each module title sit at Heading1, every field heading at Heading2 — the templates emit nothing deeper, since author content starts at Heading3 and the examples' own prose uses no sub-headings.
  assert.ok(headingStyles.includes('Heading1'))
  assert.ok(headingStyles.includes('Heading2'))
  assert.deepEqual(
    [...new Set(headingStyles)],
    ['Heading1', 'Heading2']
  )
  assert.ok((documentXml.match(/<w:numPr>/g) ?? []).length > 0, 'expected real list numbering, not flattened text')

  const referenceStyles = execFileSync(
    'unzip',
    ['-p', 'definitions/design/templates/reference.docx', 'word/styles.xml'],
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
})

test('suppressed optional sections do not leave runs of blank lines behind', () => {
  const result = renderArtefact('examples', 'hld', { dryRun: true })
  assert.doesNotMatch(result.markdown, /\n{3,}/)
})

test('reference doc defines the paragraph styles pandoc references for list items', () => {
  // The HLD template doesn't itself define "Compact" (pandoc's tight-list style). Word/LibreOffice silently drop a list item's bullet/indent entirely when its w:pStyle points at an undefined style, even though numbering is set directly on the paragraph — build-reference-doc.py merges this (and pandoc's other auxiliary styles) in from pandoc's own default reference doc. If reference.docx is ever regenerated by a plain copy of the HLD source, this catches the regression before the bullets silently vanish again.
  const referenceStyles = execFileSync(
    'unzip',
    ['-p', 'definitions/design/templates/reference.docx', 'word/styles.xml'],
    { encoding: 'utf8' }
  )
  assert.match(referenceStyles, /w:styleId="Compact"/)

  const result = renderArtefact('examples', 'soap')
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
})

test('an asset:<id> reference (#80) inserted into a module field compiles into an embedded image at the same paragraph position in the rendered artefact (#81)', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
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
    const context = readModule(definition, 'examples', 'context', { instancesDir })
    writeModule(
      definition,
      'examples',
      'context',
      {
        status: context.status,
        owner: context.owner,
        fields: {
          ...context.fields,
          driver: `${context.fields.driver}\n\n![Eligibility flow](asset:${asset.id})\n`,
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
    const driverIndex = roundTrip.indexOf('Business driver')
    const imageIndex = roundTrip.indexOf('![Eligibility flow]')
    const affectedDomainsIndex = roundTrip.indexOf('Affected domains')
    assert.ok(driverIndex >= 0 && imageIndex >= 0 && affectedDomainsIndex >= 0)
    assert.ok(driverIndex < imageIndex, 'expected the image after the Business driver section')
    assert.ok(imageIndex < affectedDomainsIndex, 'expected the image before the next heading, Affected domains')

    // The embedded image is a real, extractable media file in the docx (not just referenced by a URL), and its bytes match what was uploaded.
    const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
    const mediaFile = mediaListing
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .find((name) => name && /^word\/media\/.*\.png$/.test(name) && name !== 'word/media/image1.png')
    assert.ok(mediaFile, 'expected an embedded PNG media file for the inserted asset')
    const extractedBytes = execFileSync('unzip', ['-p', result.docxPath, mediaFile])
    assert.deepEqual(extractedBytes, pngBytes)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// --- Rendered-output commit-hash/date footer (#98) ------------------------
//
// Every rendered artefact — md and docx, across every definition, not just "design" — gets a footer naming the short commit hash and date of the source it was rendered from. For a local instance that's this repo's own current git HEAD; for an Azure-DevOps-backed instance it's read off the response Azure DevOps already returns when the artefact is pushed.

test('a local render\'s footer names this repo\'s actual current HEAD commit hash and date', () => {
  const expectedHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const expectedDate = execFileSync('git', ['log', '-1', '--format=%cs'], { encoding: 'utf8' }).trim()

  const result = renderArtefact('examples', 'soap', { dryRun: true })
  assert.match(
    result.markdown,
    new RegExp(`Rendered from commit \`${expectedHash}\` \\(${expectedDate}\\)\\.`)
  )
})

test('the footer also survives the pandoc conversion into the rendered .docx, not just the intermediate markdown', () => {
  const result = renderArtefact('examples', 'soap')
  const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
    encoding: 'utf8',
  })
  assert.match(roundTrip, /Rendered from commit `[0-9a-f]+`/)
})

test('a definition other than "design" also gets the footer — it is not special-cased to one definition\'s templates', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-definitions-'))
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    cpSync(join(definitionsDir, 'design'), join(definitionsDir, 'another-definition'), { recursive: true })
    // Give the copy a distinct id, matching loadDefinition's "directory must match id" requirement — otherwise it would just be "design" again under a different path, not a genuinely distinct definition.
    const definitionYamlPath = join(definitionsDir, 'another-definition', 'definition.yaml')
    const definitionYaml = readFileSync(definitionYamlPath, 'utf8').replace(/^id: design$/m, 'id: another-definition')
    writeFileSync(definitionYamlPath, definitionYaml)

    cpSync('instances/examples', join(instancesDir, 'other-instance'), { recursive: true })
    const instanceYamlPath = join(instancesDir, 'other-instance', 'instance.yaml')
    const instanceYaml = readFileSync(instanceYamlPath, 'utf8').replace(/^definition: design$/m, 'definition: another-definition')
    writeFileSync(instanceYamlPath, instanceYaml)

    const result = renderArtefact('other-instance', 'soap', { dryRun: true, instancesDir, definitionsDir })
    assert.match(result.markdown, /Rendered from commit `[0-9a-f]+` \(\d{4}-\d{2}-\d{2}\)\./)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

// Regression test for a review finding: rendering a local instance never used to depend on `git` at all — a local render against a directory with no git checkout (a missing/uninitialised repo) now fails, but should fail with one clear, actionable error rather than git's own raw stderr.
test('a local render against a directory with no git checkout fails with one clear error, not a raw git stderr', () => {
  const notARepoDir = mkdtempSync(join(tmpdir(), 'gantry-not-a-git-repo-'))
  try {
    assert.throws(() => renderArtefact('examples', 'soap', { dryRun: true, repoDir: notARepoDir }), {
      message: /Cannot determine the local git commit for this render's footer/,
    })
  } finally {
    rmSync(notARepoDir, { recursive: true, force: true })
  }
})

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

// Seeds a fake Azure DevOps repo with the exact same instance/module data as the local "examples" fixture, so the Azure-DevOps-backed render tests below exercise the real "soap" template against real content, the same way the local-path tests above do, rather than a bespoke minimal fixture.
function seedExamplesAzureDevOpsFiles() {
  return {
    '/gantry-workspace/examples/instance.yaml': readFileSync('instances/examples/instance.yaml', 'utf8'),
    '/gantry-workspace/examples/modules/context.md': readFileSync('instances/examples/modules/context.md', 'utf8'),
    '/gantry-workspace/examples/modules/solution-definition.md': readFileSync('instances/examples/modules/solution-definition.md', 'utf8'),
    '/gantry-workspace/examples/modules/team-and-estimates.md': readFileSync('instances/examples/modules/team-and-estimates.md', 'utf8'),
  }
}

test('a render against Azure DevOps carries a footer whose commit hash/date come from the push response, and the same footer ends up in what is actually stored there', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const result = await renderArtefact('examples', 'soap', { azureDevOps })

      // The function's own return value reports the commit its footer names — a real (fake-server-assigned) commit hash/date, not a placeholder.
      assert.match(result.commit.hash, /^[0-9a-f]{7}$/)
      assert.match(result.commit.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.match(
        result.markdown,
        new RegExp(`Rendered from commit \`${result.commit.hash}\` \\(${result.commit.date}\\)\\.`)
      )

      // What is actually sitting in the (fake) Azure DevOps repo at out/soap.docx right now — not just the local scratch copy — also carries that exact same footer.
      const client = createAzureDevOpsClient(azureDevOps)
      const pushedContent = await client.getFileContent(result.azureDevOpsPath)
      const pushedMarkdown = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
        input: Buffer.from(pushedContent, 'base64'),
        encoding: 'utf8',
      })
      assert.match(pushedMarkdown, new RegExp(`Rendered from commit \`${result.commit.hash}\` \\(${result.commit.date}\\)\\.`))
      assert.match(pushedMarkdown, /Solution on a Page/)
    }
  )
})

test('a dry run against Azure DevOps pushes nothing and has no commit-hash footer — there is no push response to source one from', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedExamplesAzureDevOpsFiles() },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      const result = await renderArtefact('examples', 'soap', { azureDevOps, dryRun: true })

      assert.equal(result.dryRun, true)
      assert.equal(result.commit, undefined)
      assert.doesNotMatch(result.markdown, /Rendered from commit/)
    }
  )
})

// Regression test for a review finding: the ADO-backed render path pushes twice (a footer-less "draft", then the footer-carrying final version) — see renderArtefactFromAzureDevOps's doc comment for why. If the second push fails, the render must surface a clear error naming the commit the (footer-less) first push already landed as, not a bare network error that leaves a reader thinking nothing was written at all.
test('if the follow-up push that adds the footer fails, the error names the commit the footer-less content already landed as', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: seedExamplesAzureDevOpsFiles(),
      // The first (draft) push succeeds; the second (footer) push is the one that then fails.
      failAfterPushes: 1,
    },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      await assert.rejects(() => renderArtefact('examples', 'soap', { azureDevOps }), {
        message: /pushed it to Azure DevOps as commit [0-9a-f]{7}, but the follow-up push that adds the commit-hash\/date footer failed/,
      })
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

// ---------- renderStageArtefacts (#123): render-to-branch on every save ----------

// The Detailed Design stage's own two artefacts (sad/ssad) share the same
// modules but now have field-accurate, divergent requirements (docs/adr/0021),
// while Shape has two SOAP variants with different requirements.
function seedDetailedDesignAzureDevOpsFiles() {
  return {
    '/gantry-workspace/examples/instance.yaml': 'definition: design\nslug: examples\nstage: detailed-design\n',
    '/gantry-workspace/examples/modules/architecture.md': readFileSync('instances/examples/modules/architecture.md', 'utf8'),
    '/gantry-workspace/examples/modules/integration.md': readFileSync('instances/examples/modules/integration.md', 'utf8'),
    '/gantry-workspace/examples/modules/data.md': readFileSync('instances/examples/modules/data.md', 'utf8'),
    '/gantry-workspace/examples/modules/nfrs.md': readFileSync('instances/examples/modules/nfrs.md', 'utf8'),
    '/gantry-workspace/examples/modules/security.md': readFileSync('instances/examples/modules/security.md', 'utf8'),
    '/gantry-workspace/examples/modules/risks.md': readFileSync('instances/examples/modules/risks.md', 'utf8'),
    '/gantry-workspace/examples/modules/dependencies.md': readFileSync('instances/examples/modules/dependencies.md', 'utf8'),
    '/gantry-workspace/examples/modules/support-and-operations.md': readFileSync(
      'instances/examples/modules/support-and-operations.md',
      'utf8'
    ),
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
      // Only "context" has been saved so far — "soap" also requires solution-definition and team-and-estimates, neither of which exist yet, exactly the state a stage is in after its very first module save.
      branchFiles: {
        [branch]: {
          '/gantry-workspace/examples/instance.yaml': 'definition: design\nslug: examples\nstage: shape\n',
          '/gantry-workspace/examples/modules/context.md': readFileSync('instances/examples/modules/context.md', 'utf8'),
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
      await assert.rejects(() => client.getFileContent('gantry-workspace/examples/out/soap.docx', { branch }), AzureDevOpsNotFoundError)
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
