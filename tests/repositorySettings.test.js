import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPOSITORY_READER_SETTINGS, repositoryReaderSettings } from '../lib/repositorySettings.js'
import { READ_ENV_VARS } from '../lib/envVarCheck.js'
import { createServer } from '../lib/server.js'

// #335: what an operator can change about how the server reads a code repository a Source document points at. Each setting is a
// `GANTRY_REPOSITORY_*` environment variable with a sensible default; a test (or an embedder) hands createServer the values directly.

test('with nothing set, a search may take 30 seconds and reads 8 files at once', () => {
  assert.deepEqual(repositoryReaderSettings(undefined, {}), { searchTimeLimitMs: 30_000, searchParallelReads: 8 })
})

test('an operator changes them with GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS and GANTRY_REPOSITORY_SEARCH_PARALLEL_READS', () => {
  const env = { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: ' 45 ', GANTRY_REPOSITORY_SEARCH_PARALLEL_READS: '4' }
  assert.deepEqual(repositoryReaderSettings(undefined, env), { searchTimeLimitMs: 45_000, searchParallelReads: 4 })
  assert.deepEqual(repositoryReaderSettings(undefined, { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: '' }), { searchTimeLimitMs: 30_000, searchParallelReads: 8 }, 'empty is unset')
})

test('a test or an embedder gives the values directly, and they win over the environment', () => {
  const env = { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: '45' }
  assert.deepEqual(repositoryReaderSettings({ searchTimeLimitMs: 250 }, env), { searchTimeLimitMs: 250, searchParallelReads: 8 })
})

test('a value that is not a whole number in range stops startup with one line naming the setting and what it takes', () => {
  for (const [name, value, range] of [
    ['GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS', 'soon', 'from 1 to 600'],
    ['GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS', '0', 'from 1 to 600'],
    ['GANTRY_REPOSITORY_SEARCH_PARALLEL_READS', '2.5', 'from 1 to 32'],
    ['GANTRY_REPOSITORY_SEARCH_PARALLEL_READS', '100', 'from 1 to 32'],
  ]) {
    assert.throws(() => repositoryReaderSettings(undefined, { [name]: value }), (err) => {
      assert.match(err.message, new RegExp(`^${name} must be a whole number ${range} \\(.+\\); it is "${value.replace('.', '\\.')}"\\.$`))
      return true
    })
  }
  assert.throws(() => createServer({ env: { GANTRY_REPOSITORY_SEARCH_PARALLEL_READS: 'lots' } }), /^Error: GANTRY_REPOSITORY_SEARCH_PARALLEL_READS must be a whole number/)
})

test('every setting is read from the process environment by its own name, and the unread-variable check knows it', (t) => {
  for (const setting of REPOSITORY_READER_SETTINGS) {
    assert.ok(READ_ENV_VARS.includes(setting.envVar), setting.envVar)
    const before = process.env[setting.envVar]
    t.after(() => (before === undefined ? delete process.env[setting.envVar] : (process.env[setting.envVar] = before)))
    process.env[setting.envVar] = String(setting.min)
    assert.equal(repositoryReaderSettings()[setting.option], setting.min * setting.scale, setting.envVar)
  }
})
