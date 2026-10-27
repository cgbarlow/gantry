import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { captionedFigures, documentXml } from './helpers/docxFigures.js'
import { renderArtefactWithDiagrams } from '../lib/render.js'

// #198 (spec #192, ADR-0055) — `gantry render` draws Mermaid diagrams with the browser's own code
// in headless Chromium, which is an optional, CLI-only dependency. These tests cover the CLI
// *without* Chromium, the case every server install and container is in: the render still
// succeeds, warns once with the install command, and leaves each diagram as its source, as
// before. Two ways of not having it are simulated through seams that already exist: Playwright's
// own PLAYWRIGHT_BROWSERS_PATH pointed at an empty directory (the package is installed, its
// browser isn't), and a Node resolve hook that makes the `playwright` package itself missing
// (`npm install --omit=optional`). The CLI *with* Chromium, drawing the same pictures as the
// browser export, is tests/cliMermaid.playwright.test.js.

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SECURITY_FENCE = '```mermaid {caption="Security architecture"}\nflowchart LR\n  Member --> Portal --> CRM\n```'
const PLAIN_FENCE = '```mermaid\nflowchart LR\n  Claim --> Assessor\n```'
const WITHOUT_PLAYWRIGHT = pathToFileURL(resolve('tests/helpers/withoutPlaywright.js')).href

// A scratch copy of the bundled example (design v3, so every Artefact numbers its diagrams), with
// `fences` added to the Problem statement ahead of the example's two captioned images.
async function withExample(fences, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-cli-mermaid-'))
  try {
    const workspacesDir = join(root, 'workspace')
    cpSync(EXAMPLE, join(workspacesDir, SLUG), { recursive: true })
    rmSync(join(workspacesDir, SLUG, 'out'), { recursive: true, force: true })
    assert.match(readFileSync(join(workspacesDir, SLUG, 'instance.yaml'), 'utf8'), /^definitionVersion: 3$/m)
    if (fences.length) {
      const path = join(workspacesDir, SLUG, 'modules', 'background.md')
      const before = readFileSync(path, 'utf8')
      const after = before.replace(/\n## Affected domains/, `\n${fences.join('\n\n')}\n\n## Affected domains`)
      assert.notEqual(after, before)
      writeFileSync(path, after)
    }
    const noBrowsers = join(root, 'no-browsers')
    mkdirSync(noBrowsers)
    return await fn({ workspacesDir, noBrowsers })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function gantryRender(workspacesDir, { env = {}, nodeArgs = [] } = {}) {
  const run = spawnSync(process.execPath, [...nodeArgs, 'bin/gantry.js', 'render', SLUG, 'soap', '--workspaces-dir', workspacesDir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  const docxPath = run.stdout.match(/^Rendered (.+\.docx)$/m)?.[1] ?? null
  return { ...run, docxPath }
}

// The lines of stderr that are this feature's warning.
function mermaidWarnings(stderr) {
  return stderr.split('\n').filter((line) => /Mermaid/.test(line))
}

const IMAGE_CAPTIONS_AFTER_TWO_DIAGRAMS = ['Diagram 3. Take out insurance process', 'Diagram 4. Claims handling introductory view']

test('without Chromium installed, `gantry render` succeeds, warns once with the install command, and leaves the Mermaid diagrams as source (#198)', async () => {
  await withExample([SECURITY_FENCE, PLAIN_FENCE], ({ workspacesDir, noBrowsers }) => {
    const run = gantryRender(workspacesDir, { env: { PLAYWRIGHT_BROWSERS_PATH: noBrowsers } })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(run.docxPath, run.stdout)

    const warnings = mermaidWarnings(run.stderr)
    assert.equal(warnings.length, 1, `one warning for the whole render, not one per diagram:\n${run.stderr}`)
    assert.match(warnings[0], /npx playwright install chromium/)
    assert.doesNotMatch(warnings[0], /--include=optional/, 'the package is installed; only its browser is missing')

    // The diagrams are their source text, as before; they still take their numbers, so the images
    // after them are numbered as the browser export numbers them.
    const xml = documentXml(run.docxPath)
    assert.match(xml, /Member --&gt; Portal --&gt; CRM/)
    assert.match(xml, /Claim --&gt; Assessor/)
    const figures = captionedFigures(run.docxPath)
    assert.deepEqual(figures.map((f) => f.caption), IMAGE_CAPTIONS_AFTER_TWO_DIAGRAMS)
    assert.ok(figures.every((f) => !f.name.startsWith('mermaid-diagram-')))
  })
})

test('without the optional playwright package, `gantry render` succeeds and the warning names both install steps (#198)', async () => {
  await withExample([SECURITY_FENCE, PLAIN_FENCE], ({ workspacesDir }) => {
    const run = gantryRender(workspacesDir, { nodeArgs: ['--import', WITHOUT_PLAYWRIGHT] })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(run.docxPath, run.stdout)

    const warnings = mermaidWarnings(run.stderr)
    assert.equal(warnings.length, 1, run.stderr)
    assert.match(warnings[0], /npm install --include=optional/)
    assert.match(warnings[0], /npx playwright install chromium/)

    assert.match(documentXml(run.docxPath), /Member --&gt; Portal --&gt; CRM/)
    assert.deepEqual(captionedFigures(run.docxPath).map((f) => f.caption), IMAGE_CAPTIONS_AFTER_TWO_DIAGRAMS)
  })
})

test('a document with no Mermaid diagram never needs Chromium: no warning (#198)', async () => {
  await withExample([], ({ workspacesDir, noBrowsers }) => {
    const run = gantryRender(workspacesDir, { env: { PLAYWRIGHT_BROWSERS_PATH: noBrowsers } })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(mermaidWarnings(run.stderr), [])
    assert.deepEqual(captionedFigures(run.docxPath).map((f) => f.caption), [
      'Diagram 1. Take out insurance process',
      'Diagram 2. Claims handling introductory view',
    ])
  })
})

test('`gantry render --dry-run` prints the Markdown as authored, captions and all, and never needs Chromium (#198)', async () => {
  await withExample([SECURITY_FENCE], ({ workspacesDir, noBrowsers }) => {
    const run = spawnSync(process.execPath, ['bin/gantry.js', 'render', SLUG, 'soap', '--dry-run', '--workspaces-dir', workspacesDir], {
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: noBrowsers },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(run.stdout.includes(SECURITY_FENCE))
    assert.deepEqual(mermaidWarnings(run.stderr), [])
  })
})

// The same path in process, as bin/gantry.js calls it: the warning is returned for the CLI to
// print, and the result is the plain render's.
test('renderArtefactWithDiagrams returns the warning with the render, and a dry run never draws (#198)', async () => {
  await withExample([SECURITY_FENCE], async ({ workspacesDir, noBrowsers }) => {
    const before = process.env.PLAYWRIGHT_BROWSERS_PATH
    process.env.PLAYWRIGHT_BROWSERS_PATH = noBrowsers
    try {
      const dry = await renderArtefactWithDiagrams(SLUG, 'soap', { instancesDir: workspacesDir, dryRun: true })
      assert.equal(dry.dryRun, true)
      assert.equal(dry.warning, null)
      assert.ok(dry.markdown.includes(SECURITY_FENCE))

      const result = await renderArtefactWithDiagrams(SLUG, 'soap', { instancesDir: workspacesDir })
      assert.ok(existsSync(result.docxPath))
      assert.match(result.warning, /^Warning: Mermaid diagrams were left as source text/)
      assert.match(result.warning, /npx playwright install chromium/)
      assert.match(documentXml(result.docxPath), /Member --&gt; Portal --&gt; CRM/)
    } finally {
      if (before === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
      else process.env.PLAYWRIGHT_BROWSERS_PATH = before
    }
  })
})

// The dependency is optional and CLI-only: `npm install --omit=optional` leaves it out, and the
// server images install that way. npm decides what `--omit=optional` drops from the lockfile's
// `optional` flags, so those are what is checked.
test('Playwright is an optional dependency that `--omit=optional` drops, with nothing else depending on it (#198)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(typeof pkg.optionalDependencies?.playwright, 'string')
  assert.equal(pkg.dependencies?.playwright, undefined)
  assert.equal(pkg.devDependencies?.playwright, undefined)

  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  assert.equal(lock.packages[''].optionalDependencies?.playwright, pkg.optionalDependencies.playwright)
  for (const name of ['playwright', 'playwright-core']) {
    const entry = lock.packages[`node_modules/${name}`]
    assert.equal(entry.optional, true, `${name} is dropped by --omit=optional`)
    assert.notEqual(entry.dev, true, `${name} is installed by a production install that keeps optional dependencies`)
  }
})

// The image build's test stage doesn't receive the ContainerFiles, so there this check has nothing
// to read and is skipped.
const CONTAINER_FILES = ['ContainerFile', 'ContainerFile.demo']
test('the server container images install without the optional dependency and never install a browser (#198)', { skip: !CONTAINER_FILES.every((f) => existsSync(f)) && 'no ContainerFile here' }, () => {
  for (const file of CONTAINER_FILES) {
    const text = readFileSync(file, 'utf8')
    // The image that is run: ContainerFile's last stage, or the whole demo file.
    const runtime = text.slice(text.lastIndexOf('\nFROM '))
    const installs = [...runtime.matchAll(/^RUN npm (?:ci|install)\b.*$/gm)].map((m) => m[0])
    assert.ok(installs.length > 0, `${file} installs its dependencies`)
    for (const install of installs) assert.match(install, /--omit=optional/, `${file}: ${install}`)
    assert.doesNotMatch(runtime, /playwright install/, `${file} installs no browser`)
  }
})
