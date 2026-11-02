import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import {
  withRunningServerForProvider,
  withScratchInstances,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #281 (map #238): a render against a GitHub-backed Instance reads the committed `sources/manifest.yaml` (#280) so a citation with no words of its own prints the document's title. (Azure DevOps reads it the same way; the Word text and the Sources appendix themselves are covered in tests/sourceCitations.test.js.)

const SLUG = 'github-citations'
const MANIFEST = [{ id: 'client-brief', filename: 'Client brief v3.docx', title: 'Client brief', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:30:00.000Z', size: 100 }]

function seedFiles() {
  const background = exampleModuleText('background').replace('## Problem statement', '## Problem statement\n\nThe median is 12.4 days [](source:client-brief) and 12.5 [Notes, p. 2](source:notes).')
  return {
    [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n`,
    [`/gantry-workspace/${SLUG}/modules/background.md`]: background,
    [`/gantry-workspace/${SLUG}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${SLUG}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${SLUG}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
    [`/gantry-workspace/${SLUG}/sources/manifest.yaml`]: stringifyYAML(MANIFEST),
  }
}

test('a render against a GitHub-backed Instance prints a citation as plain text, with the title of a document from the committed manifest', async () => {
  await withScratchInstances((instancesDir) =>
    withRunningServerForProvider('github', { options: { instancesDir }, fakeServerOptions: { files: seedFiles() } }, async (ctx) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }, { instancesDir })
      registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
      const res = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
      assert.equal(res.status, 200, await res.clone().text())
      const body = await res.json()
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
      const dir = mkdtempSync(join(tmpdir(), 'gantry-github-citations-'))
      try {
        const docx = join(dir, 'rendered.docx')
        writeFileSync(docx, await client.getFileBytes(body.githubPath))
        const xml = execFileSync('unzip', ['-p', docx, 'word/document.xml'], { encoding: 'utf8' })
        const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
        assert.match(text, /12\.4 days \(Client brief\) and 12\.5 \(Notes, p\.\s2\)/, 'the empty citation took the title from the manifest; the other kept its words')
        assert.doesNotMatch(xml, /source:/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )
})
