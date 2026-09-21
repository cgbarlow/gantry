import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspacePats } from '../src/credentials.js'

test('undefined/empty env var parses to an empty map', () => {
  assert.deepEqual(parseWorkspacePats(undefined), {})
  assert.deepEqual(parseWorkspacePats(''), {})
  assert.deepEqual(parseWorkspacePats('   '), {})
})

test('parses a well-formed JSON object', () => {
  assert.deepEqual(parseWorkspacePats('{"ws-1": "pat-1", "ws-2": "pat-2"}'), { 'ws-1': 'pat-1', 'ws-2': 'pat-2' })
})

test('rejects invalid JSON', () => {
  assert.throws(() => parseWorkspacePats('{not json'), /valid JSON/)
})

test('rejects a JSON array', () => {
  assert.throws(() => parseWorkspacePats('["ws-1"]'), /JSON object/)
})

test('rejects a non-string PAT value', () => {
  assert.throws(() => parseWorkspacePats('{"ws-1": 12345}'), /non-empty string/)
})

test('rejects an empty-string PAT value', () => {
  assert.throws(() => parseWorkspacePats('{"ws-1": ""}'), /non-empty string/)
})
