import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInstance,
  readInstance,
  writeInstanceStage,
  recordInstanceWorkItemLink,
  recordInstancePullRequest,
} from '../lib/instance.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withScratchInstances, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// WI 201 — instance.yaml serialization must be canonical (a fixed, stable key
// order regardless of which fields a given write actually changed) so that
// two independent writers touching disjoint fields of the same instance.yaml
// — the everyday "stacked stage branches" shape ADR-0014's PR-based stage
// approval creates (lib/stageBranch.js) — produce identical bytes for every
// field neither of them touched, letting git's own 3-way merge resolve the
// two edits cleanly instead of reporting a conflict that has nothing to do
// with any real value disagreement (confirmed live: mergeStatus: 2 on a
// stacked-stage PR from exactly this).



function withFakeRepo(files, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, fn)
}

// Runs git's own plumbing 3-way merge (`git merge-file`) over three texts —
// no repo/branch machinery needed, since the only thing this ticket claims
// to fix is what git sees when it diffs three *texts*, not anything about
// how those texts reached git. Returns `{ conflicted, output }`: `conflicted`
// is true iff the merge left conflict markers (`git merge-file`'s exit code
// is the conflict count — 0 means clean).
function threeWayMerge(base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-merge3-'))
  try {
    const baseFile = join(dir, 'base.yaml')
    const oursFile = join(dir, 'ours.yaml')
    const theirsFile = join(dir, 'theirs.yaml')
    writeFileSync(baseFile, base)
    writeFileSync(oursFile, ours)
    writeFileSync(theirsFile, theirs)
    let output
    let conflicted = false
    try {
      output = execFileSync('git', ['merge-file', '--stdout', oursFile, baseFile, theirsFile], { encoding: 'utf8' })
    } catch (err) {
      // git merge-file exits non-zero (= conflict count) when there are
      // conflicts, but still writes the conflict-marked text to stdout.
      conflicted = true
      output = err.stdout
    }
    return { conflicted, output }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('two writers changing disjoint fields from the same base produce identical serialized text for every unchanged field', async () => {
  await withScratchInstances(async (instancesDirA) => {
    await withScratchInstances((instancesDirB) => {
      createInstance('design', 'my-initiative', { instancesDir: instancesDirA })
      createInstance('design', 'my-initiative', { instancesDir: instancesDirB })

      const pathA = join(instancesDirA, 'my-initiative', 'instance.yaml')
      const pathB = join(instancesDirB, 'my-initiative', 'instance.yaml')
      const baseText = readFileSync(pathA, 'utf8')
      assert.equal(baseText, readFileSync(pathB, 'utf8'), 'both scratch copies must start identical')

      // Writer A advances the stage pointer.
      writeInstanceStage('my-initiative', 'hld-define', { instancesDir: instancesDirA })
      // Writer B — independently, from the same base — records a brand new
      // top-level field neither writer had before (the same shape as
      // recordInstancePullRequest adding a new `pullRequests` entry).
      recordInstanceWorkItemLink(
        'my-initiative',
        { organization: 'org', project: 'proj', workItemType: 'Feature', parentId: 42, stages: {} },
        { instancesDir: instancesDirB }
      )

      const textA = readFileSync(pathA, 'utf8')
      const textB = readFileSync(pathB, 'utf8')

      // `assignee`/`definition`/`slug` are the fields *neither* writer
      // touched — canonical serialization means both writes must emit those
      // lines identically, in the same relative order, regardless of which
      // other field each one happened to change.
      const untouchedFieldLines = (text) => text.split('\n').filter((line) => /^(assignee|definition|slug):/.test(line))
      assert.deepEqual(untouchedFieldLines(textA), untouchedFieldLines(textB))
      assert.ok(untouchedFieldLines(textA).length === 3, 'sanity check: all three untouched fields were actually found')

      // And each writer's own change is exactly what it asked for.
      assert.match(textA, /^stage: hld-define$/m)
      assert.match(textB, /^stage: shape$/m) // B never touched stage
      assert.match(textB, /^workItem:$/m)
    })
  })
})

test('the stacked-branch scenario (an ancestor stage merges to main while a descendant stage branch independently rewrites instance.yaml) is git-mergeable with no conflicting hunks', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
    await createInstance('design', 'my-initiative', { azureDevOps })

    const client = createAzureDevOpsClient(azureDevOps)
    const path = 'gantry-workspace/my-initiative/instance.yaml'
    const baseText = await client.getFileContent(path)

    // Seed a stacked descendant-stage branch with the same base content —
    // exactly what lib/stageBranch.js does when it branches a new stage off
    // an ancestor stage's still-open branch.
    const descendantBranch = 'gantry-workspace/my-initiative/hld-define'
    await client.writeFile(path, baseText, { branch: descendantBranch })

    // Ancestor stage's own PR merges into main: its branch's own write
    // advances `stage`.
    await writeInstanceStage('my-initiative', 'hld-define', { azureDevOps })
    const oursText = await client.getFileContent(path) // now on 'main'

    // Descendant stage branch, independently and without seeing the
    // ancestor's merge, records its own Pull Request id.
    await recordInstancePullRequest('my-initiative', 'hld-define', 4242, {
      azureDevOps: { ...azureDevOps, branch: descendantBranch },
    })
    const theirsText = await client.getFileContent(path, { branch: descendantBranch })

    const { conflicted, output } = threeWayMerge(baseText, oursText, theirsText)
    assert.equal(conflicted, false, `expected a clean merge but got conflict markers:\n${output}`)
    assert.match(output, /stage: hld-define/)
    assert.match(output, /pullRequests:/)
    assert.match(output, /hld-define: 4242/)
  })
})

test('a genuine two-sided conflict (both branches setting the same field to different real values) is detected with a clear error instead of an opaque failure', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
    await createInstance('design', 'my-initiative', { azureDevOps })

    const client = createAzureDevOpsClient(azureDevOps)
    const path = 'gantry-workspace/my-initiative/instance.yaml'
    const baseText = await client.getFileContent(path)

    const otherBranch = 'gantry-workspace/my-initiative/conflicting-branch'
    await client.writeFile(path, baseText, { branch: otherBranch })

    // Both sides set `stage` to a genuinely different real value.
    await writeInstanceStage('my-initiative', 'hld-define', { azureDevOps })
    const oursText = await client.getFileContent(path)

    await writeInstanceStage('my-initiative', 'detailed-design', { azureDevOps: { ...azureDevOps, branch: otherBranch } })
    const theirsText = await client.getFileContent(path, { branch: otherBranch })

    const { conflicted, output } = threeWayMerge(baseText, oursText, theirsText)
    assert.equal(conflicted, true, 'expected these two genuinely conflicting values to actually conflict')
    assert.match(output, /^<{7}/m)

    // Feed the conflicted text back through the library the same way a
    // caller would after fetching a (badly) merged instance.yaml, and assert
    // it fails with a clear, actionable message rather than a bare YAML
    // parse error or silently-wrong data.
    await client.writeFile(path, output)
    await assert.rejects(() => readInstance('my-initiative', { azureDevOps }), (err) => {
      assert.match(err.message, /unresolved git merge conflict/)
      assert.match(err.message, /resolve it by hand/i)
      return true
    })
  })
})

test('canonical serialization does not change what instance.yaml actually contains — only its byte-level key order', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })
    const updated = writeInstanceStage('my-initiative', 'hld-define', { instancesDir })
    assert.deepEqual(updated, {
      definition: 'design',
      slug: 'my-initiative',
      stage: 'hld-define',
      assignee: 'c.barlow',
      definitionVersion: 1,
    })

    const reread = readInstance('my-initiative', { instancesDir })
    assert.deepEqual(reread, updated)
  })
})
