// #129: both MCP-only env vars were renamed to carry the `GANTRY_MCP_` prefix, with no alias — the
// old names read as though the *gantry serve* web service owned them, and setting them there did
// nothing, silently. Mirrors the main repo's `tests/workspaceBootstrap.test.js` guard on the retired
// `GANTRY_BOOTSTRAP_PATS` name: the old spellings must not survive anywhere they'd actually be read,
// or shown to an operator (or to the model, via tool descriptions and server instructions) as live
// guidance. The README is deliberately excluded — it documents the rename, so it names both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname
// Built at runtime so this file itself never contains the literal strings being searched for.
const OLD_NAMES = ['GANTRY' + '_WORKSPACE_PATS', 'GANTRY' + '_BASE_URL']
const SCAN_ROOTS = ['src', '.env.example']
// #130: the one place the retired names are *supposed* to survive — a table of retired names mapped to
// what replaced them, so an operator who still has an old one set is told so at startup rather than met
// with silence. They are named there as history, never as live guidance, which is the distinction this
// guard is actually protecting.
const EXCLUDED_FILES = new Set([join(PACKAGE_ROOT, 'src', 'envVarCheck.js')])

// #135: a scan root that isn't present is skipped rather than thrown on. This guard runs inside the
// container build's own test stage (mcp-server/Dockerfile's `FROM source AS test`), which copies only
// `src/` and `test/` — so `.env.example` is legitimately absent there, and `statSync` on it failed the
// build outright, taking the MCP server's deploy down. The guard's real job is catching a developer
// reintroducing the retired name in the repo, where every root does exist; a root that isn't in a
// given build context has nothing to check. `scannedAnything` below is what stops this tolerance
// quietly turning the whole guard into a no-op.
function walkFiles(path) {
  if (!existsSync(path)) return []
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)))
}

for (const oldName of OLD_NAMES) {
  test(`${oldName} (the pre-#129 name) does not survive anywhere in src/ or .env.example`, () => {
    const offenders = []
    let scannedAnything = false
    for (const root of SCAN_ROOTS) {
      for (const file of walkFiles(join(PACKAGE_ROOT, root))) {
        scannedAnything = true
        if (EXCLUDED_FILES.has(file)) continue
        const text = readFileSync(file, 'utf8')
        // `GANTRY_MCP_WORKSPACE_PATS` does not contain either old name as a substring, so a plain
        // `includes` needs no word-boundary handling.
        if (text.includes(oldName)) offenders.push(file.replace(PACKAGE_ROOT, ''))
      }
    }
    assert.deepEqual(offenders, [], `found the pre-rename env var name in: ${offenders.join(', ')}`)
    // #135: skipping an absent root is deliberate; scanning nothing at all means the roots are wrong
    // and this guard has silently stopped guarding anything.
    assert.ok(scannedAnything, `no scan root existed — checked: ${SCAN_ROOTS.join(', ')}`)
  })
}
