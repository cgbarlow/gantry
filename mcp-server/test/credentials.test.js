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

// #130's rule 1 ("names only, never values") applied to this parser's own error. The likeliest way to
// reach the invalid-JSON branch is pasting a bare PAT where the map was expected — and `JSON.parse`'s
// own message embeds the first ~10 characters of its input, which used to be interpolated straight
// into this error and from there into the deploy log.
test('an invalid-JSON error never echoes any part of the value — it holds credentials', () => {
  const pastedBarePat = 'ghp_SECRETTOKENVALUE0123456789'
  assert.throws(
    () => parseWorkspacePats(pastedBarePat),
    (err) => {
      assert.equal(err.message.includes(pastedBarePat), false, 'full value leaked')
      // Any run of 4+ characters of the value is already too much of a credential to log.
      for (let i = 0; i + 4 <= pastedBarePat.length; i += 1) {
        assert.equal(err.message.includes(pastedBarePat.slice(i, i + 4)), false, `value fragment "${pastedBarePat.slice(i, i + 4)}" leaked into: ${err.message}`)
      }
      assert.match(err.message, /^GANTRY_MCP_WORKSPACE_PATS must be valid JSON:/)
      return true
    }
  )
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
