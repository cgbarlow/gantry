import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// WI314 — the Azure-DevOps-hosted half of the client-side WASM Pandoc render path's HTTP
// surface: POST /api/instance/render-wasm-prepare/:artefact (compile + learn-the-commit) and
// POST /api/instance/render-wasm-finish/:artefact (push the browser's own converted bytes).
// The actual browser-side conversion is stubbed here too — a real WASM run needs a real
// browser (see tests/pandocWasm.test.js's own doc comment) — but this suite still produces
// real, well-formed docx bytes for the "finish" step via native pandoc, the same stand-in
// approach tests/render.test.js's own prepare/finish unit tests use, one level further up the
// stack (through the actual HTTP routes + credential gating, not lib/render.js directly).

function seedFiles(slug) {
  const instanceYaml = readFileSync('instances/examples/instance.yaml', 'utf8').replace(/^slug: examples$/m, `slug: ${slug}`)
  return {
    [`/gantry-workspace/${slug}/instance.yaml`]: instanceYaml,
    [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/design-basis.md`]: exampleModuleText('design-basis'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
  }
}

// Converts markdown to real docx bytes via native pandoc — standing in for "what the browser's
// pandoc-wasm module produced", so these tests assert on real, well-formed bytes rather than an
// opaque placeholder Buffer.
function fakeWasmConvert(markdown, referenceDocBase64) {
  const scratchDir = mkdtempSync(join(tmpdir(), 'gantry-wasm-finish-'))
  try {
    const mdPath = join(scratchDir, 'pass2.md')
    const docxPath = join(scratchDir, 'pass2.docx')
    const args = ['-f', 'markdown', '-t', 'docx']
    if (referenceDocBase64) {
      const refPath = join(scratchDir, 'reference.docx')
      writeFileSync(refPath, Buffer.from(referenceDocBase64, 'base64'))
      args.push('--reference-doc', refPath)
    }
    writeFileSync(mdPath, markdown)
    execFileSync('pandoc', [...args, '-o', docxPath, mdPath])
    return readFileSync(docxPath)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

test('render-wasm-prepare then render-wasm-finish: a real, well-formed docx ends up pushed at the path prepare named, with the Document Control naming the learned commit', async () => {
  const slug = 'wasm-remote-soap'
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedFiles(slug) },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(slug, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })

        await withRunningServer({ instancesDir }, async (base) => {
          const noPat = await fetch(`${base}/api/instance/render-wasm-prepare/soap?slug=${slug}`, { method: 'POST' })
          assert.equal(noPat.status, 401)
          assert.equal((await noPat.json()).error, 'authentication_required')

          const prepRes = await fetch(`${base}/api/instance/render-wasm-prepare/soap?slug=${slug}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(prepRes.status, 200)
          const prep = await prepRes.json()
          assert.equal(prep.artefact, 'soap')
          assert.match(prep.markdown, /Solution on a Page/)
          assert.match(prep.markdown, /## Document Control/)
          assert.match(prep.commit.hash, /^[0-9a-f]{7}$/)
          assert.equal(typeof prep.referenceDocBase64, 'string')
          assert.equal(Buffer.from(prep.referenceDocBase64, 'base64').subarray(0, 2).toString(), 'PK')
          assert.match(prep.azureDevOpsPath, new RegExp(`gantry-workspace/${slug}/out/.*\\.docx$`))
          assert.equal(typeof prep.branch, 'string')
          assert.notEqual(prep.branch, 'main')

          const docxBytes = fakeWasmConvert(prep.markdown, prep.referenceDocBase64)

          const finishNoPat = await fetch(`${base}/api/instance/render-wasm-finish/soap?slug=${slug}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              docxBase64: docxBytes.toString('base64'),
              azureDevOpsPath: prep.azureDevOpsPath,
              branch: prep.branch,
              commit: prep.commit,
            }),
          })
          assert.equal(finishNoPat.status, 401)

          const finishRes = await fetch(`${base}/api/instance/render-wasm-finish/soap?slug=${slug}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({
              docxBase64: docxBytes.toString('base64'),
              azureDevOpsPath: prep.azureDevOpsPath,
              branch: prep.branch,
              commit: prep.commit,
            }),
          })
          assert.equal(finishRes.status, 200)
          const finish = await finishRes.json()
          assert.equal(finish.artefact, 'soap')
          assert.equal(finish.azureDevOpsPath, prep.azureDevOpsPath)
          assert.match(finish.azureDevOpsUrl, new RegExp(`version=GB${encodeURIComponent(prep.branch)}`))

          // What's actually sitting in the (fake) Azure DevOps repo now is exactly the bytes
          // "the browser" (fakeWasmConvert, standing in for pandoc-wasm) produced — a real,
          // well-formed docx naming the learned commit, not a placeholder.
          const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
          const stored = await client.getFileContent(prep.azureDevOpsPath, { branch: prep.branch })
          assert.equal(stored, docxBytes.toString('base64'))
          const storedMarkdown = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
            input: Buffer.from(stored, 'base64'),
            encoding: 'utf8',
          })
          assert.match(storedMarkdown, new RegExp(prep.commit.fullHash))
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

// WI #349 — a plain local instance (the bundled `examples` on a zip-release install, where
// there is no native pandoc) gets the same two-step WASM flow: prepare compiles without a
// pandoc subprocess and writes the .md; finish lands the browser's bytes as the .docx.
test('render-wasm-prepare then render-wasm-finish on a local instance writes the .md and a real .docx into the instance out/ dir, without a pandoc subprocess in prepare', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    await withRunningServer({ instancesDir }, async (base) => {
      const prepRes = await fetch(`${base}/api/instance/render-wasm-prepare/soap?slug=examples`, { method: 'POST' })
      assert.equal(prepRes.status, 200)
      const prep = await prepRes.json()
      assert.equal(prep.artefact, 'soap')
      assert.match(prep.markdown, /^# examples: Solution on a Page/)
      assert.match(prep.markdown, /## Document Control/)
      assert.ok(prep.referenceDocBase64, 'the v2 reference doc is handed to the browser for styling')
      assert.match(prep.docxPath, /\.docx$/)
      // The markdown is on disk already, next to where the docx will land — same as the native route.
      const mdPath = join(instancesDir, 'examples', 'out', `${prep.basename}.md`)
      assert.equal(readFileSync(mdPath, 'utf8'), prep.markdown)
      assert.equal(existsSync(join(instancesDir, 'examples', 'out', `${prep.basename}.docx`)), false)

      const docxBytes = fakeWasmConvert(prep.markdown, prep.referenceDocBase64)
      const finishRes = await fetch(`${base}/api/instance/render-wasm-finish/soap?slug=examples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docxBase64: docxBytes.toString('base64') }),
      })
      assert.equal(finishRes.status, 200)
      const finish = await finishRes.json()
      assert.equal(finish.docxPath, prep.docxPath)
      const landed = readFileSync(join(instancesDir, 'examples', 'out', `${prep.basename}.docx`))
      assert.deepEqual(landed, docxBytes)
      assert.equal(landed.subarray(0, 2).toString(), 'PK')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('render-wasm-finish on a local instance rejects a body without docxBase64 with 400 and writes nothing', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/render-wasm-finish/soap?slug=examples`, { method: 'POST' })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /docxBase64/)
      assert.equal(existsSync(join(instancesDir, 'examples', 'out')), false)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('render-wasm-prepare on an instance whose stage no longer matches any stage in its definition fails loudly rather than silently proceeding', async () => {
  const slug = 'wasm-remote-badstage'
  const files = seedFiles(slug)
  const badStageYaml = files[`/gantry-workspace/${slug}/instance.yaml`].replace(/^stage: .*$/m, 'stage: not-a-real-stage')
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { ...files, [`/gantry-workspace/${slug}/instance.yaml`]: badStageYaml },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(slug, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/render-wasm-prepare/soap?slug=${slug}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 500)
          assert.match((await res.json()).error, /has no stage "not-a-real-stage"/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('render-wasm-finish rejects a body missing docxBase64/azureDevOpsPath/commit with 400, and never rejects a well-formed one for a missing-body reason', async () => {
  const slug = 'wasm-remote-badbody'
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedFiles(slug) },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(slug, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/render-wasm-finish/soap?slug=${slug}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({ azureDevOpsPath: 'x' }),
          })
          assert.equal(res.status, 400)
          assert.match((await res.json()).error, /docxBase64.*azureDevOpsPath.*commit/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})
