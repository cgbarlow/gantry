import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// #364: the image's test stages run every test inside the ContainerFile's `source` stage, which holds
// only the folders it copies in. A test that imports from a folder left out of that list — the
// favicon's Playwright test and the live source-document check both import from scripts/ — fails to
// load there with ERR_MODULE_NOT_FOUND, and quietly, because those stages swallow their exit code by
// design (the pipeline's test-result gate only sees the tests that did load). This walks every file a
// test reaches through its relative imports and asks that each one's top-level folder is copied in.

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname)

// The image build's test stage doesn't receive the ContainerFile (it is not one of the folders it
// copies), so there this check has nothing to read and is skipped.
const CONTAINER_FILE = join(REPO_ROOT, 'ContainerFile')

// node_modules/ is never copied: the `deps` stage below `source` installs it with `npm ci`.
const INSTALLED_NOT_COPIED = new Set(['node_modules'])

// The top-level folders the `source` stage copies in: `COPY bin/ bin/` gives `bin`.
function sourceStageFolders(text) {
  const start = text.indexOf('AS source')
  assert.ok(start >= 0, 'ContainerFile has a source stage')
  const end = text.indexOf('\nFROM ', start)
  const stage = text.slice(start, end < 0 ? undefined : end)
  return new Set([...stage.matchAll(/^COPY\s+(\S+)/gm)].map((m) => m[1].replace(/\/$/, '').split('/')[0]))
}

// Relative module specifiers written as string literals: `from '../x.js'` and `import('../x.js')`.
function relativeImports(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1])
}

// Every repository file the given entry files reach through relative imports, entry files included.
function filesReachedFrom(entries) {
  const seen = new Set()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.m?js$/.test(file)) continue
    for (const specifier of relativeImports(file)) {
      const target = resolve(dirname(file), specifier)
      if (relative(REPO_ROOT, target).split('/')[0] === 'node_modules') continue
      if (existsSync(target)) pending.push(target)
    }
  }
  return seen
}

test('every folder a test imports from is copied into the image that runs the tests (#364)', { skip: !existsSync(CONTAINER_FILE) && 'no ContainerFile here' }, () => {
  const copied = sourceStageFolders(readFileSync(CONTAINER_FILE, 'utf8'))
  const testsDir = join(REPO_ROOT, 'tests')
  const testFiles = readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join(testsDir, name))
  const missing = new Map()
  for (const file of filesReachedFrom(testFiles)) {
    const folder = relative(REPO_ROOT, file).split('/')[0]
    if (copied.has(folder) || INSTALLED_NOT_COPIED.has(folder)) continue
    if (!missing.has(folder)) missing.set(folder, relative(REPO_ROOT, file))
  }
  assert.deepEqual(
    [...missing].map(([folder, file]) => `${folder}/ (for example ${file})`),
    [],
    'ContainerFile\'s source stage needs a COPY for each of these folders',
  )
})
