import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCredential, getSecondaryCredential } from '../lib/credential.js'
import { basicAuthHeader } from './helpers/lifecycle.js'

function reqWithAuthHeader(value) {
  return { headers: value === undefined ? {} : { authorization: value } }
}

function reqWithSecondaryAuthHeader(value) {
  return { headers: value === undefined ? {} : { 'x-gantry-secondary-authorization': value } }
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

// getSecondaryCredential (#48, ADR-0042): the Jira half of an Atlassian workspace registration's
// two-token proof — same Basic-auth decoding as getCredential, over a different header
// (`X-Gantry-Secondary-Authorization`), so the two credentials never collide on the wire.

test('getSecondaryCredential extracts the PAT from a well-formed Basic header on the secondary header', () => {
  assert.equal(getSecondaryCredential(reqWithSecondaryAuthHeader(basicAuthHeader('my-jira-pat'))), 'my-jira-pat')
})

test('getSecondaryCredential returns null when the secondary header is absent, even if the primary Authorization header is set', () => {
  const req = { headers: { authorization: basicAuthHeader('my-real-pat') } }
  assert.equal(getSecondaryCredential(req), null)
})

test('getCredential and getSecondaryCredential read independent headers on the same request', () => {
  const req = {
    headers: {
      authorization: basicAuthHeader('bitbucket-pat'),
      'x-gantry-secondary-authorization': basicAuthHeader('jira-pat'),
    },
  }
  assert.equal(getCredential(req), 'bitbucket-pat')
  assert.equal(getSecondaryCredential(req), 'jira-pat')
})
