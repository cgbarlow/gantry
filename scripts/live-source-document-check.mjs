#!/usr/bin/env node
// #280 criteria 1-3 against a REAL repository. The unit tests (tests/providerSourceDocuments.test.js) run against fake Provider servers, so they cannot tell you how long a 25 MB upload takes on GitHub or Azure DevOps, or that a later Stage's branch really inherits an earlier one's documents there. This does.
//
//   GANTRY_LIVE_PAT=<token> node scripts/live-source-document-check.mjs github --owner <owner> --repository <repo>
//   GANTRY_LIVE_PAT=<token> node scripts/live-source-document-check.mjs azure-devops --organization <org> --project <project> --repository <repo>
//
// Optional: --limit-ms <n> (default 10000), --keep (leave the branches it made), --base-url <url> (GitHub Enterprise / a fake).
// It never writes to main: everything goes on `gantry-workspace/live-check-<time>/<stage>` branches, which it deletes at the end unless --keep is given. The token needs write access to the repository, and the repository needs a `main` branch. The result is printed; paste it into the issue and, if it failed, lower MAX_SOURCE_BYTES in web/lib/sourceDocuments.js to what the Provider actually managed.
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createAzureDevOpsClient, basicAuthHeader } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { loadDefinition } from '../lib/definition.js'
import { createProviderSourceStore, findSourceReadBranch } from '../lib/providerSourceDocuments.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { MAX_SOURCE_BYTES } from '../web/lib/sourceDocuments.js'

const DEFAULT_LIMIT_MS = 10_000
const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000'

const PROVIDERS = {
  github: {
    optionsKey: 'github',
    client: (o) => createGitHubClient(o),
    resolveBranch: resolveGitHubStageBranch,
    isCommit: (method, path) => method === 'POST' && /\/git\/commits$/.test(path),
    async deleteBranch(o, branch) {
      const base = (o.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
      const ref = branch.split('/').map(encodeURIComponent).join('/')
      const res = await fetch(`${base}/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repository)}/git/refs/heads/${ref}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${o.pat}`, Accept: 'application/vnd.github+json' },
      })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },
  },
  'azure-devops': {
    optionsKey: 'azureDevOps',
    client: (o) => createAzureDevOpsClient(o),
    resolveBranch: resolveStageBranch,
    isCommit: (method, path) => method === 'POST' && /\/pushes$/.test(path),
    async deleteBranch(o, branch, client) {
      const oldObjectId = await client.getBranchObjectId(branch)
      if (oldObjectId === ZERO_OBJECT_ID) return
      const base = (o.baseUrl ?? 'https://dev.azure.com').replace(/\/+$/, '')
      const res = await fetch(`${base}/${encodeURIComponent(o.organization)}/${encodeURIComponent(o.project)}/_apis/git/repositories/${encodeURIComponent(o.repository)}/refs?api-version=7.1`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(o.pat), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ name: `refs/heads/${branch}`, oldObjectId, newObjectId: ZERO_OBJECT_ID }]),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
  },
}

/** Counts the commits the Provider is asked to make while `fn` runs. */
async function countingCommits(isCommit, fn) {
  const realFetch = globalThis.fetch
  let commits = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (isCommit((init?.method ?? 'GET').toUpperCase(), url.pathname)) commits++
    return realFetch(input, init)
  }
  try {
    const value = await fn()
    return { commits, value }
  } finally {
    globalThis.fetch = realFetch
  }
}

/**
 * Runs the #280 checks against one repository. `provider` is 'github' or 'azure-devops'; `location` is `{ owner, repository, baseUrl? }` or `{ organization, project, repository, baseUrl? }`; `pat` needs write access. Returns `{ passed, uploadMs, uploadBytes, limitMs, checks: [{ name, ok, detail }] }`; a failed check is reported, not thrown (only a setup problem throws). `bytes` is the size of the big upload (the 25 MB limit by default).
 */
export async function runLiveCheck({ provider, location, pat, slug = `live-check-${Date.now()}`, limitMs = DEFAULT_LIMIT_MS, bytes = MAX_SOURCE_BYTES, cleanup = true, log = () => {} }) {
  const spec = PROVIDERS[provider]
  if (!spec) throw new Error(`Unknown provider "${provider}" (github or azure-devops)`)
  const base = { ...location, pat }
  const options = { [spec.optionsKey]: base }
  const client = spec.client(base)
  const definition = loadDefinition('design') // the version a new design Instance gets (#359)
  const [first, second] = definition.stages
  const firstBranch = stageBranchName(slug, first.id)
  const secondBranch = stageBranchName(slug, second.id)
  const root = `gantry-workspace/${slug}`
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail })
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }
  const storeFor = async (stage) =>
    createProviderSourceStore(options, slug, {
      readBranch: await findSourceReadBranch(options, definition, slug, stage.id),
      resolveWriteBranch: () => spec.resolveBranch(base, definition, slug, stage.id),
    })

  let uploadMs = null
  try {
    // Criterion 3: the biggest allowed document, timed, as one commit, read back byte for byte.
    const big = randomBytes(bytes)
    const store1 = await storeFor(first)
    const started = Date.now()
    const upload = await countingCommits(spec.isCommit, () => store1.upload({ filename: 'Big scan.pdf', bytes: new Uint8Array(big), text: 'big', uploadedBy: 'live-check' }))
    uploadMs = Date.now() - started
    const entry = upload.value.entry
    check(`a ${(bytes / 1024 / 1024).toFixed(0)} MB upload finishes within ${limitMs / 1000} s`, uploadMs <= limitMs, `${uploadMs} ms`)
    check('the big upload is exactly one commit', upload.commits === 1, `${upload.commits} commit(s)`)
    const back = Buffer.from(await client.getFileBytes(`${root}/sources/Big scan.pdf`, { branch: firstBranch }))
    check('the big document reads back byte for byte from the stage branch', back.equals(big))
    check('main is untouched', !(await client.fileExists(`${root}/sources/manifest.yaml`, 'main')))

    // Criterion 1: rename and extract again are one commit each (remove, below).
    const rename = await countingCommits(spec.isCommit, async () => (await storeFor(first)).rename(entry.id, 'Renamed scan'))
    check('rename is exactly one commit', rename.commits === 1, `${rename.commits}`)
    const retext = await countingCommits(spec.isCommit, async () => (await storeFor(first)).setText(entry.id, 'read again'))
    check('extract text again is exactly one commit', retext.commits === 1, `${retext.commits}`)

    // Criterion 2: the later Stage's branch is cut from the earlier one's and inherits the document.
    await spec.resolveBranch(base, definition, slug, second.id)
    check("the later Stage's branch carries the earlier Stage's document", await client.fileExists(`${root}/sources/Big scan.pdf`, secondBranch))
    const store2 = await storeFor(second)
    const later = await countingCommits(spec.isCommit, () => store2.upload({ filename: 'Risks.md', bytes: new Uint8Array(Buffer.from('lock-in')), text: 'lock-in' }))
    check('an upload on the later Stage is exactly one commit', later.commits === 1, `${later.commits}`)
    check("a document added on the later Stage stays off the earlier Stage's branch", !(await client.fileExists(`${root}/sources/Risks.md`, firstBranch)) && (await client.fileExists(`${root}/sources/Risks.md`, secondBranch)))

    const remove = await countingCommits(spec.isCommit, async () => (await storeFor(first)).remove(entry.id, { removedBy: 'live-check' }))
    check('remove is exactly one commit', remove.commits === 1, `${remove.commits}`)
  } finally {
    if (cleanup) {
      for (const branch of [secondBranch, firstBranch]) {
        try {
          await spec.deleteBranch(base, branch, client)
        } catch (err) {
          log(`could not delete branch ${branch} (${err.message}); delete it by hand`)
        }
      }
    } else {
      log(`left branches ${firstBranch} and ${secondBranch} in place`)
    }
  }
  return { passed: checks.every((c) => c.ok), uploadMs, uploadBytes: bytes, limitMs, checks }
}

function parseArgs(argv) {
  const [provider, ...rest] = argv
  const flags = { keep: false }
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '')
    if (key === 'keep') flags.keep = true
    else flags[key] = rest[++i]
  }
  return { provider, flags }
}

async function main() {
  const { provider, flags } = parseArgs(process.argv.slice(2))
  const pat = process.env.GANTRY_LIVE_PAT
  const needed = provider === 'github' ? ['owner', 'repository'] : provider === 'azure-devops' ? ['organization', 'project', 'repository'] : null
  if (!needed || !pat || needed.some((k) => !flags[k])) {
    console.error('Usage: GANTRY_LIVE_PAT=<token> node scripts/live-source-document-check.mjs github --owner <o> --repository <r>\n   or: GANTRY_LIVE_PAT=<token> node scripts/live-source-document-check.mjs azure-devops --organization <o> --project <p> --repository <r>\n(optional: --limit-ms <n> --keep --base-url <url>)')
    process.exit(2)
  }
  const location = Object.fromEntries(needed.map((k) => [k, flags[k]]))
  if (flags['base-url']) location.baseUrl = flags['base-url']
  const result = await runLiveCheck({ provider, location, pat, limitMs: flags['limit-ms'] ? Number(flags['limit-ms']) : DEFAULT_LIMIT_MS, cleanup: !flags.keep, log: console.log })
  console.log(`\n${provider}: ${result.passed ? 'ALL CHECKS PASSED' : 'FAILED'}; ${(result.uploadBytes / 1024 / 1024).toFixed(0)} MB upload took ${result.uploadMs} ms (limit ${result.limitMs} ms)`)
  process.exit(result.passed ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
