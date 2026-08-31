import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../lib/server.js'

// WI #278: `gantry serve` must serve its packaged assets (web shell, the bundled
// node_modules for the browser import map, the built-in definitions/ and docs/)
// regardless of `process.cwd()` — they resolve relative to the gantry install, not
// the directory the command happens to be run from. Sibling of WI #277.

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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

async function assertPackageAssetsServed(base) {
  // GET / -> the app-shell HTML
  const rootRes = await fetch(`${base}/`)
  assert.equal(rootRes.status, 200)
  const html = await rootRes.text()
  assert.ok(html.includes('<div id="app"'), 'GET / should return the app-shell HTML')

  // The generated import map must reference resolvable /node_modules/ paths, and
  // the server must actually serve one of them.
  const importMapMatch = html.match(/"imports"\s*:\s*\{[^}]+\}/)
  assert.ok(importMapMatch, 'index.html should contain a generated import map')
  const mappedMatch = importMapMatch[0].match(/"(\/node_modules\/[^"]+)"/)
  assert.ok(mappedMatch, 'import map should contain at least one /node_modules/ entry')
  const assetRes = await fetch(`${base}${mappedMatch[1]}`)
  assert.equal(assetRes.status, 200, `mapped asset ${mappedMatch[1]} should be served`)

  // A definition-backed endpoint that needs the packaged definitions/ dir.
  const defsRes = await fetch(`${base}/api/definitions`)
  assert.equal(defsRes.status, 200)
  const defs = await defsRes.json()
  assert.ok(
    Array.isArray(defs) && defs.some((d) => d.id === 'design'),
    'GET /api/definitions should list the built-in "design" definition'
  )

  // The user guide is read from the packaged docs/ dir.
  const guideRes = await fetch(`${base}/api/user-guide`)
  assert.equal(guideRes.status, 200)
  const guide = await guideRes.json()
  assert.ok(typeof guide.markdown === 'string' && guide.markdown.length > 0)
}

test('serve: packaged assets resolve from a foreign cwd (not the repo root)', async () => {
  const foreignCwd = mkdtempSync(join(tmpdir(), 'gantry-foreign-cwd-'))
  const originalCwd = process.cwd()
  process.chdir(foreignCwd)
  try {
    await withRunningServer({}, assertPackageAssetsServed)
  } finally {
    process.chdir(originalCwd)
    rmSync(foreignCwd, { recursive: true, force: true })
  }
})

test('serve: packaged assets still resolve when cwd IS the repo root (no regression)', async () => {
  const originalCwd = process.cwd()
  process.chdir(repoRoot)
  try {
    await withRunningServer({}, assertPackageAssetsServed)
  } finally {
    process.chdir(originalCwd)
  }
})
