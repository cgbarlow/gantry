import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createInstance } from '../lib/instance.js'

// WI #366 — finishing WI #356's workspace-qualified addressing.
//
// #356 made the registry scope-nested and deprecated the bare, workspace-unqualified slug, but the
// addressing layer was never wired up to supply a scope: `lib/server.js` resolved a numeric ref with
// `resolveSlugForRef` (throwing away the scope the ref had already pinned down) and passed no
// workspace to the registry, so every request took the deprecated search-every-workspace path. That
// warned on essentially every call, and broke outright the moment two workspaces shared a slug —
// the case these tests cover.

function seedWorkspaceInstance(workspacesDir, folder, slug) {
  writeWorkspaceJson(workspacesDir, folder, { name: folder, kind: 'local', createdAt: new Date().toISOString() })
  createInstance('design', slug, { instancesDir: join(workspacesDir, folder) })
}

/** Runs `fn`, returning everything `console.warn` was called with while it ran. */
async function captureWarnings(fn) {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return warnings
}

test('two workspaces holding the same instance slug both resolve, addressed by scope', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspaceInstance(instancesDir, 'alpha', 'shared-slug')
    seedWorkspaceInstance(instancesDir, 'beta', 'shared-slug')

    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, async (base) => {
      // The bare slug is genuinely ambiguous now, and says so rather than guessing.
      const ambiguous = await fetch(`${base}/api/instance?slug=shared-slug`)
      assert.equal(ambiguous.status, 500)
      assert.match((await ambiguous.json()).error, /ambiguous/)

      // Qualified by scope — the token GET /api/instance/workspace hands the web client — each
      // workspace's own instance resolves, independently of the other.
      for (const workspace of ['alpha', 'beta']) {
        const res = await fetch(`${base}/api/instance?slug=shared-slug&scope=${workspace}`)
        assert.equal(res.status, 200, `expected ${workspace}/shared-slug to resolve`)
        assert.equal((await res.json()).slug, 'shared-slug')
      }

      // And by the "<workspace>/<slug>" form the deprecation notice itself recommends.
      const qualified = await fetch(`${base}/api/instance?slug=${encodeURIComponent('beta/shared-slug')}`)
      assert.equal(qualified.status, 200)
      assert.equal((await qualified.json()).slug, 'shared-slug')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/workspace hands out the scope token that makes an ambiguous slug resolvable', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspaceInstance(instancesDir, 'alpha', 'only-here')

    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, async (base) => {
      const res = await fetch(`${base}/api/instance/workspace?slug=only-here`)
      assert.equal(res.status, 200)
      const { scope } = await res.json()
      assert.equal(scope, 'alpha')

      const scoped = await fetch(`${base}/api/instance?slug=only-here&scope=${encodeURIComponent(scope)}`)
      assert.equal(scoped.status, 200)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a scoped request logs no bare-slug deprecation warning; a bare one still does', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspaceInstance(instancesDir, 'alpha', 'only-here')

    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, async (base) => {
      const scopedWarnings = await captureWarnings(async () => {
        const res = await fetch(`${base}/api/instance?slug=only-here&scope=alpha`)
        assert.equal(res.status, 200)
      })
      assert.deepEqual(
        scopedWarnings.filter((w) => w.includes('workspace-unqualified')),
        [],
        'a scoped request must not take the deprecated path'
      )

      // The bare slug still resolves — ADR-0031 makes that backward compatibility a hard
      // requirement — and still warns, so the deprecation stays visible to whoever can act on it.
      const bareWarnings = await captureWarnings(async () => {
        const res = await fetch(`${base}/api/instance?slug=only-here`)
        assert.equal(res.status, 200)
      })
      assert.equal(bareWarnings.filter((w) => w.includes('workspace-unqualified')).length > 0, true)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a numeric reference resolves within the one workspace its number names, with no bare-slug search', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspaceInstance(instancesDir, 'alpha', 'shared-slug')
    seedWorkspaceInstance(instancesDir, 'beta', 'shared-slug')

    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, async (base) => {
      // Numbers are assigned lazily on first list, exactly as a real dashboard load would.
      const listed = await fetch(`${base}/api/instances`)
      assert.equal(listed.status, 200)
      const instances = await listed.json()
      const refs = instances.map((i) => i.ref).filter(Boolean)
      assert.equal(refs.length, 2, 'both instances should carry a numeric reference')

      // A ref's workspace number already pins down exactly one scope, so resolving one must never
      // fall back to the ambiguous cross-workspace slug search — which would throw here, not warn.
      for (const ref of refs) {
        const warnings = await captureWarnings(async () => {
          const res = await fetch(`${base}/api/instance?ref=${encodeURIComponent(ref)}`)
          assert.equal(res.status, 200, `expected ref ${ref} to resolve`)
          assert.equal((await res.json()).slug, 'shared-slug')
        })
        assert.deepEqual(
          warnings.filter((w) => w.includes('workspace-unqualified')),
          [],
          `ref ${ref} must resolve within its own workspace`
        )
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
