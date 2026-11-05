import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPOSITORY_READER_SETTINGS, repositoryReaderSettings } from '../lib/repositorySettings.js'
import { READ_ENV_VARS } from '../lib/envVarCheck.js'
import { createServer } from '../lib/server.js'

// #335: what an operator can change about how the server reads a code repository a Source document points at. Each setting is a
// `GANTRY_REPOSITORY_*` environment variable with a sensible default; a test (or an embedder) hands createServer the values directly.

const MB = 1024 * 1024
const DEFAULTS = {
  searchTimeLimitMs: 30_000,
  searchParallelReads: 8,
  requestTimeLimitMs: 15_000,
  retries: 2,
  retryWaitMs: 500,
  copyMemoryBytes: 512 * MB,
  copyRepositoryBytes: 150 * MB,
  copyIdleMs: 2 * 60 * 60_000,
  headRecheckMs: 60_000,
  archiveTimeLimitMs: 300_000,
}

test('with nothing set, a search may take 30 seconds and reads 8 files at once; a request to the Provider may take 15 seconds, and a temporary failure is tried twice more, after 0.5 and then 1 second', () => {
  assert.deepEqual(repositoryReaderSettings(undefined, {}), DEFAULTS)
})

// #336
test('an operator changes the time limit per request, the retries and the wait with GANTRY_REPOSITORY_REQUEST_TIME_LIMIT_SECONDS, GANTRY_REPOSITORY_RETRIES and GANTRY_REPOSITORY_RETRY_WAIT_MILLISECONDS', () => {
  const env = { GANTRY_REPOSITORY_REQUEST_TIME_LIMIT_SECONDS: '20', GANTRY_REPOSITORY_RETRIES: '0', GANTRY_REPOSITORY_RETRY_WAIT_MILLISECONDS: '250' }
  assert.deepEqual(repositoryReaderSettings(undefined, env), { ...DEFAULTS, requestTimeLimitMs: 20_000, retries: 0, retryWaitMs: 250 })
  for (const [name, value, range] of [
    ['GANTRY_REPOSITORY_REQUEST_TIME_LIMIT_SECONDS', '0', 'from 1 to 300'],
    ['GANTRY_REPOSITORY_RETRIES', '6', 'from 0 to 5'],
    ['GANTRY_REPOSITORY_RETRY_WAIT_MILLISECONDS', '-1', 'from 0 to 10000'],
  ]) {
    assert.throws(() => repositoryReaderSettings(undefined, { [name]: value }), new RegExp(`^Error: ${name} must be a whole number ${range} `))
  }
})

// #338
test('with nothing set, Repository copies take at most 512 MB together and 150 MB each, are dropped after 2 hours unused, a branch head is asked again after a minute, and an archive may take 5 minutes to download', () => {
  const settings = repositoryReaderSettings(undefined, {})
  assert.deepEqual(
    [settings.copyMemoryBytes, settings.copyRepositoryBytes, settings.copyIdleMs, settings.headRecheckMs, settings.archiveTimeLimitMs],
    [512 * MB, 150 * MB, 2 * 60 * 60_000, 60_000, 300_000]
  )
})

test('an operator changes them with GANTRY_REPOSITORY_COPY_MEMORY_MB (0 keeps none), _COPY_LIMIT_MB, _COPY_IDLE_MINUTES, _HEAD_RECHECK_SECONDS and _ARCHIVE_TIME_LIMIT_SECONDS', () => {
  const env = {
    GANTRY_REPOSITORY_COPY_MEMORY_MB: '0',
    GANTRY_REPOSITORY_COPY_LIMIT_MB: '40',
    GANTRY_REPOSITORY_COPY_IDLE_MINUTES: '30',
    GANTRY_REPOSITORY_HEAD_RECHECK_SECONDS: '0',
    GANTRY_REPOSITORY_ARCHIVE_TIME_LIMIT_SECONDS: '90',
  }
  assert.deepEqual(repositoryReaderSettings(undefined, env), { ...DEFAULTS, copyMemoryBytes: 0, copyRepositoryBytes: 40 * MB, copyIdleMs: 30 * 60_000, headRecheckMs: 0, archiveTimeLimitMs: 90_000 })
  for (const [name, value, range] of [
    ['GANTRY_REPOSITORY_COPY_MEMORY_MB', '-1', 'from 0 to 65536'],
    ['GANTRY_REPOSITORY_COPY_LIMIT_MB', '0', 'from 1 to 65536'],
    ['GANTRY_REPOSITORY_COPY_IDLE_MINUTES', '0', 'from 1 to 10080'],
    ['GANTRY_REPOSITORY_HEAD_RECHECK_SECONDS', '3601', 'from 0 to 3600'],
    ['GANTRY_REPOSITORY_ARCHIVE_TIME_LIMIT_SECONDS', '4', 'from 5 to 3600'],
  ]) {
    assert.throws(() => repositoryReaderSettings(undefined, { [name]: value }), new RegExp(`^Error: ${name} must be a whole number ${range} `))
  }
})

test('an operator changes them with GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS and GANTRY_REPOSITORY_SEARCH_PARALLEL_READS', () => {
  const env = { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: ' 45 ', GANTRY_REPOSITORY_SEARCH_PARALLEL_READS: '4' }
  assert.deepEqual(repositoryReaderSettings(undefined, env), { ...DEFAULTS, searchTimeLimitMs: 45_000, searchParallelReads: 4 })
  assert.deepEqual(repositoryReaderSettings(undefined, { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: '' }), DEFAULTS, 'empty is unset')
})

test('a test or an embedder gives the values directly, and they win over the environment', () => {
  const env = { GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS: '45' }
  assert.deepEqual(repositoryReaderSettings({ searchTimeLimitMs: 250, retries: 0 }, env), { ...DEFAULTS, searchTimeLimitMs: 250, retries: 0 })
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
