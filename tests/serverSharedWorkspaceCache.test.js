import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerInstance } from '../lib/instanceRegistry.js'
import { findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withRunningServer, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #127 (parent #109, docs/adr/0047 "Cache design") — end-to-end coverage of the cache against the real
// running server and the fake in-process GitHub HTTP server, counting *actual HTTP requests* the fake
// server receives (not a mock of fetch) by wrapping `global.fetch` for the duration of each test. Two
// GitHub endpoints classify every request this ticket cares about: `GET .../contents/...` (a full
// content read — instance.yaml or a module file) and `GET .../git/ref/heads/...` (the cheap conditional
// freshness check, `lib/githubClient.js`'s `getBranchObjectId`).

// The real `design` definition's own `shape`-stage module list and each module's own title/first-field
// title — used (rather than `tests/helpers/fixtureModules.js`'s bundled example content) so every
// seeded module file is already in the new `#`/`##` heading scale `lib/instance.js`'s own pre-existing
// lazy migration (ADR-0016, unrelated to this ticket) expects, and that migration never fires and
// commits a surprise extra write partway through a test that's specifically counting reads. Pinned to
// version 2 explicitly (`instanceDefinitionVersion`'s own default is 1 when an instance.yaml doesn't
// say — `definitionVersion: 2` below matches that pin on the instance side too) rather than left to
// "whichever `loadDefinition` defaults to", so this file's own module specs can never silently drift
// from the ones `GET /api/instance` actually resolves against.
const DESIGN_DEFINITION_VERSION = 2
const DESIGN_DEFINITION = loadDefinition('design', { definitionsDir: 'definitions', version: DESIGN_DEFINITION_VERSION })
const SHAPE_MODULE_IDS = DESIGN_DEFINITION.stages.find((s) => s.id === 'shape').modules

function alreadyMigratedModuleText(moduleId) {
  const moduleSpec = DESIGN_DEFINITION.modules.get(moduleId)
  const firstField = moduleSpec.fields[0]
  return `---\nmodule: ${moduleId}\nstatus: draft\nowner: ''\n---\n\n# ${moduleSpec.title}\n\n## ${firstField.title}\n\nSample content for ${moduleId}.\n`
}

function githubDesignFiles(slug) {
  const files = {
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\ndefinitionVersion: ${DESIGN_DEFINITION_VERSION}\nslug: ${slug}\nstage: shape\n`,
  }
  for (const moduleId of SHAPE_MODULE_IDS) {
    files[`/gantry-workspace/${slug}/modules/${moduleId}.md`] = alreadyMigratedModuleText(moduleId)
  }
  return files
}

function registerGitHubInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
  return findWorkspaceByLocation(
    { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl } },
    { instancesDir }
  ).id
}

/**
 * Wraps global.fetch for the duration of `fn()`, classifying every request by URL into named buckets
 * (each a `{ test(url) }` predicate) — restores the real fetch in a `finally` even if `fn` throws.
 * Returns `fn`'s own return value, plus each bucket's count *and* the list of URLs that matched it, so a
 * caller can assert about one specific path (e.g. "the module this test just saved") rather than only a
 * raw total.
 */
async function withFetchCounts(buckets, fn) {
  const counts = Object.fromEntries(Object.keys(buckets).map((k) => [k, 0]))
  const urls = Object.fromEntries(Object.keys(buckets).map((k) => [k, []]))
  const realFetch = global.fetch
  global.fetch = async (url, ...rest) => {
    const href = typeof url === 'string' ? url : url.toString()
    for (const [name, matches] of Object.entries(buckets)) {
      if (matches(href)) {
        counts[name]++
        urls[name].push(href)
      }
    }
    return realFetch(url, ...rest)
  }
  try {
    const result = await fn()
    return { result, counts, urls }
  } finally {
    global.fetch = realFetch
  }
}

const GITHUB_BUCKETS = {
  contentReads: (href) => href.includes('/contents/') || href.includes('/contents?'),
  freshnessChecks: (href) => href.includes('/git/ref/heads/'),
}

test('a repeated GET /api/instance against unchanged shared-workspace content only issues the cheap freshness check on repeat, never a second full content read', async () => {
  const slug = 'cache-repeat-read'
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          { instancesDir, allowGitHubBaseUrlOverride: true, sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }) },
          async (gantryBase) => {
            const { counts } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              const first = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
              assert.equal(first.status, 200)
            })
            const firstContentReads = counts.contentReads
            assert.ok(firstContentReads > 0, 'the first request must actually read content for real')

            // Three more identical requests — nothing changed on the Provider between them.
            const { counts: repeatCounts } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              for (let i = 0; i < 3; i++) {
                const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
                assert.equal(res.status, 200)
              }
            })

            assert.equal(repeatCounts.contentReads, 0, 'unchanged content must be served from cache — zero further full reads')
            assert.ok(repeatCounts.freshnessChecks > 0, 'each repeat request must still perform its own cheap freshness check')
          }
        )
      }
    )
  })
})

test('write-through: a module saved through Gantry (the architect\'s own credential) is visible on the very next credential-less read, with no delay', async () => {
  const slug = 'cache-write-through'
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          { instancesDir, allowGitHubBaseUrlOverride: true, sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }) },
          async (gantryBase) => {
            // Warm the cache with a credential-less read first (the common case: a visitor opened the
            // design before the architect edited it).
            const warm = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
            assert.equal(warm.status, 200)
            const before = await warm.json()
            const backgroundBefore = before.modules.find((m) => m.id === 'background')
            assert.ok(backgroundBefore)

            // The architect edits the "background" module's "problem" field (definitions/design's own
            // shape, `definitions/design/2/modules/background.yaml`) and saves, using their own
            // credential.
            const saveRes = await fetch(`${gantryBase}/api/instance/modules/background?slug=${slug}&scope=${workspaceId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
              body: JSON.stringify({ status: 'draft', owner: '', fields: { problem: 'Freshly edited by the architect, live.' } }),
            })
            assert.equal(saveRes.status, 200)

            // The very next credential-less read must see the edit immediately — no wait, no manual
            // refresh — and must not need a second full content read of *the module the save touched*
            // to get there: write-through already seeded the cache with it from the save itself. (This
            // is also the first save ever made against this instance's "shape" stage, so ADR-0014's own
            // "first write starts the stage's branch" behaviour means the *other* modules are now being
            // read from a branch that's never been read before and genuinely do need a first real read
            // each — orthogonal to this ticket, and not what this assertion is about.)
            const { result: afterBody, urls } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              const after = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
              assert.equal(after.status, 200)
              return after.json()
            })

            const backgroundAfter = afterBody.modules.find((m) => m.id === 'background')
            assert.ok(JSON.stringify(backgroundAfter).includes('Freshly edited by the architect, live.'), 'the edit must be visible on the very next read')
            assert.ok(
              !urls.contentReads.some((u) => u.includes('/modules/background.md')),
              'write-through means the read right after the save needs no full re-read of the specific module it changed'
            )
          }
        )
      }
    )
  })
})

test('the credential boundary: two different individual credentials reading the same shared workspace never share a cached result, and neither is ever served from (or populates) the shared cache', async () => {
  const slug = 'cache-boundary-own-credential'
  const OTHER_VALID_PAT = 'a-different-valid-github-pat'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: [GITHUB_VALID_PAT, OTHER_VALID_PAT], files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          { instancesDir, allowGitHubBaseUrlOverride: true, sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }) },
          async (gantryBase) => {
            // Warm the SHARED cache first, credential-less.
            const warm = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
            assert.equal(warm.status, 200)

            // A visitor who brought their own (different, but valid) credential reads the same
            // workspace. This must never be served from the shared cache the credential-less read just
            // warmed — it must do its own real read(s).
            const { counts: ownCredCounts } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`, {
                headers: { Authorization: basicAuthHeader(OTHER_VALID_PAT) },
              })
              assert.equal(res.status, 200)
            })
            assert.ok(ownCredCounts.contentReads > 0, 'an own-credential read must do its own real content read(s) — never served from the shared cache')

            // And it must not have populated the shared cache either: the *next* credential-less read
            // still needed no full read (the shared cache — warmed earlier, untouched by the
            // own-credential read above — still answers it), proving the own-credential read never
            // wrote into it.
            const { counts: sharedAgainCounts } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
              assert.equal(res.status, 200)
            })
            assert.equal(sharedAgainCounts.contentReads, 0, 'the shared cache is unaffected by the own-credential read in between')

            // Repeating the SAME own-credential read again must also do its own full read again — an
            // own-credential read is never itself cached, so it never gets cheaper on repeat.
            const { counts: ownCredRepeatCounts } = await withFetchCounts(GITHUB_BUCKETS, async () => {
              const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`, {
                headers: { Authorization: basicAuthHeader(OTHER_VALID_PAT) },
              })
              assert.equal(res.status, 200)
            })
            assert.ok(ownCredRepeatCounts.contentReads > 0, 'an own-credential read is never cached — it never gets cheaper on repeat')
          }
        )
      }
    )
  })
})

test('cross-workspace isolation: two independently-shared workspaces (two different repos) never serve each other\'s content, and each caches independently', async () => {
  const slugA = 'cache-workspace-a'
  const slugB = 'cache-workspace-b'
  const OTHER_OWNER = 'fake-owner-two'
  const OTHER_REPOSITORY = 'fake-repo-two'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slugA) },
      async (providerBaseUrlA) => {
        await withFakeGitHubServer(
          { owner: OTHER_OWNER, repository: OTHER_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slugB) },
          async (providerBaseUrlB) => {
            const workspaceIdA = registerGitHubInstance(slugA, { instancesDir, providerBaseUrl: providerBaseUrlA })
            registerInstance(slugB, { kind: 'github', owner: OTHER_OWNER, repository: OTHER_REPOSITORY, baseUrl: providerBaseUrlB }, { instancesDir })
            const workspaceIdB = findWorkspaceByLocation(
              { provider: 'github', location: { owner: OTHER_OWNER, repository: OTHER_REPOSITORY, baseUrl: providerBaseUrlB } },
              { instancesDir }
            )?.id
            assert.notEqual(workspaceIdA, workspaceIdB, 'two different repos register as two different workspace ids')

            await withRunningServer(
              {
                instancesDir,
                allowGitHubBaseUrlOverride: true,
                sharedWorkspacePats: JSON.stringify({ [workspaceIdA]: GITHUB_VALID_PAT, [workspaceIdB]: GITHUB_VALID_PAT }),
              },
              async (gantryBase) => {
                const resA = await fetch(`${gantryBase}/api/instance?slug=${slugA}&scope=${workspaceIdA}`)
                assert.equal(resA.status, 200)
                assert.equal((await resA.json()).slug, slugA)

                const resB = await fetch(`${gantryBase}/api/instance?slug=${slugB}&scope=${workspaceIdB}`)
                assert.equal(resB.status, 200)
                assert.equal((await resB.json()).slug, slugB)

                // Both are now warm. Repeating either must stay cheap (served from its own cache
                // entry) and must never accidentally answer from the other workspace's entry — proven
                // here simply by each still resolving to its own correct slug, not by a raw count,
                // since a cross-workspace collision would surface as wrong *content*, not merely an
                // extra request.
                const repeatA = await fetch(`${gantryBase}/api/instance?slug=${slugA}&scope=${workspaceIdA}`)
                assert.equal((await repeatA.json()).slug, slugA)
                const repeatB = await fetch(`${gantryBase}/api/instance?slug=${slugB}&scope=${workspaceIdB}`)
                assert.equal((await repeatB.json()).slug, slugB)
              }
            )
          }
        )
      }
    )
  })
})
