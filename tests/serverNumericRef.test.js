// WI200 / docs/adr/0024 — numeric references layered over slugs. These tests exercise the new
// `?ref=` resolution `lib/server.js`'s `resolveSlugParam`/`resolveStageIdParam` add, alongside the
// pre-existing `?slug=`/`?stage=` params, which must keep resolving unchanged (ADR-0024 decision #3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, writeInstanceStage } from '../lib/instance.js'

async function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

test('GET /api/instance?ref=w0i1 resolves the same instance as ?slug= for a local instance', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const bySlug = await (await fetch(`${base}/api/instance?slug=alpha`)).json()
      const byRef = await (await fetch(`${base}/api/instance?ref=w0i1`)).json()
      assert.equal(byRef.slug, 'alpha')
      assert.equal(byRef.ref, 'w0i1')
      assert.equal(byRef.workspaceNumber, 0)
      assert.equal(byRef.instanceNumber, 1)
      assert.deepEqual(byRef.stage, bySlug.stage)
      assert.deepEqual(byRef.modules, bySlug.modules)
    })
  })
})

test('GET /api/instance?ref=w0 (workspace-only) defaults to that workspace\'s instance 1', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'first-created', { instancesDir })
    createInstance('design', 'second-created', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?ref=w0`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.slug, 'first-created')
      assert.equal(body.instanceNumber, 1)
    })
  })
})

test('GET /api/instance?ref=w0i1 (instance-only, no stage) defaults to stage 1, even when the instance\'s persisted current stage is later', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    // Moves the instance's own persisted stage pointer directly (bypassing the "Advance to next stage" gate check —
    // irrelevant to what this test is exercising, which is purely the numeric-ref defaulting behavior).
    writeInstanceStage('alpha', 'hld-define', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      // ...a plain slug-only request (no ref) keeps defaulting to that persisted *current* stage (unchanged, pre-existing behavior)...
      const bySlug = await (await fetch(`${base}/api/instance?slug=alpha`)).json()
      assert.notEqual(bySlug.stage.id, 'shape')

      // ...but a numeric instance-only ref defaults to stage 1 specifically (ADR-0024's "instance-only resolves to stage 1").
      const byRef = await (await fetch(`${base}/api/instance?ref=w0i1`)).json()
      assert.equal(byRef.stage.id, 'shape')
      assert.equal(byRef.stage.number, 1)
    })
  })
})

test('GET /api/instance?ref=w0i1s2 resolves a specific stage number', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?ref=w0i1s2`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.stage.id, 'hld-define')
      assert.equal(body.stage.number, 2)
    })
  })
})

test('an explicit ?stage= still wins over a ref\'s own embedded stage number', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?ref=w0i1s2&stage=detailed-design`)
      const body = await res.json()
      assert.equal(body.stage.id, 'detailed-design')
    })
  })
})

test('GET /api/instance?ref=<unknown> reports 400, not 500, and never falls back to a default slug', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir, slug: 'alpha' }, async (base) => {
      const res = await fetch(`${base}/api/instance?ref=w99i1`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /Unknown reference/)
    })
  })
})

test('the legacy ?slug=&?stage= params keep resolving exactly as before, unaffected by ref support existing', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?slug=alpha&stage=hld-define`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.slug, 'alpha')
      assert.equal(body.stage.id, 'hld-define')
    })
  })
})

test('GET /api/instances rows and GET /api/workspaces rows carry numeric references', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const rows = await (await fetch(`${base}/api/instances`)).json()
      const alpha = rows.find((r) => r.slug === 'alpha')
      assert.equal(alpha.workspaceNumber, 0)
      assert.equal(alpha.instanceNumber, 1)
      assert.equal(alpha.ref, 'w0i1')

      const workspaces = await (await fetch(`${base}/api/workspaces`)).json()
      assert.deepEqual(workspaces, [])
    })
  })
})
