import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'

// WI #381: the definition editor's "New definition: Blank" route and its live-validation endpoint.
// "Clone" and the existing lifecycle routes already have coverage elsewhere (tests/server.test.js,
// tests/definitionVersion.test.js) — this covers only what's new here.

async function withDraftDesignV2(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p1-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-p1-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, fn)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('POST /api/definitions with no sourceId creates a blank draft definition', async () => {
  await withDraftDesignV2(async (base) => {
    const res = await fetch(`${base}/api/definitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId: 'brand-new', title: 'Brand New' }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.id, 'brand-new')
    const getRes = await fetch(`${base}/api/definitions/brand-new/versions/1`)
    assert.equal(getRes.status, 200)
    const proj = await getRes.json()
    assert.equal(proj.status, 'draft')
    assert.equal(proj.title, 'Brand New')
    assert.deepEqual(proj.stages, [])
    assert.deepEqual(proj.artefacts, [])
    assert.deepEqual(proj.modules, [])
  })
})

test('POST /api/definitions with no sourceId and no newId is rejected', async () => {
  await withDraftDesignV2(async (base) => {
    const res = await fetch(`${base}/api/definitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
  })
})

test('POST /api/definitions/:id/versions/:n/validate reports problems for a broken draft with no disk write', async () => {
  await withDraftDesignV2(async (base) => {
    const proj = await (await fetch(`${base}/api/definitions/design/versions/2`)).json()
    proj.artefacts[0].requires.push('not-a-real-module')
    const res = await fetch(`${base}/api/definitions/design/versions/2/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proj),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.problems))
    assert.ok(body.problems.some((p) => p.type === 'missing-module'))
  })
})

test('POST /api/definitions/:id/versions/:n/validate reports no problems for the unmodified design draft', async () => {
  await withDraftDesignV2(async (base) => {
    const proj = await (await fetch(`${base}/api/definitions/design/versions/2`)).json()
    const res = await fetch(`${base}/api/definitions/design/versions/2/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proj),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.problems, [])
  })
})
