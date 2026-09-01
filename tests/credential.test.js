import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCredential } from '../lib/credential.js'
import { basicAuthHeader } from './helpers/lifecycle.js'

function reqWithAuthHeader(value) {
  return { headers: value === undefined ? {} : { authorization: value } }
}


test('extracts the PAT from a well-formed Basic auth header (empty username, PAT as password)', () => {
  assert.equal(getCredential(reqWithAuthHeader(basicAuthHeader('my-real-pat'))), 'my-real-pat')
})

test('returns null when there is no Authorization header at all', () => {
  assert.equal(getCredential(reqWithAuthHeader(undefined)), null)
})

test('returns null for a non-Basic auth scheme', () => {
  assert.equal(getCredential(reqWithAuthHeader('Bearer some-token')), null)
})

test('returns null for a Basic header with no username/password separator', () => {
  const noColon = Buffer.from('just-a-pat-no-colon', 'utf8').toString('base64')
  assert.equal(getCredential(reqWithAuthHeader(`Basic ${noColon}`)), null)
})

test('returns null for a Basic header whose password half is empty', () => {
  assert.equal(getCredential(reqWithAuthHeader(basicAuthHeader(''))), null)
})

test('returns null for malformed (non-base64) Basic auth content', () => {
  assert.equal(getCredential(reqWithAuthHeader('Basic %%%not-base64%%%')), null)
})

test('ignores a non-empty username half — only the password half is treated as the PAT', () => {
  const encoded = Buffer.from('someuser:my-real-pat', 'utf8').toString('base64')
  assert.equal(getCredential(reqWithAuthHeader(`Basic ${encoded}`)), 'my-real-pat')
})
