import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedAccessToken } from '../src/accessAuth.js'

const TOKEN = 'super-secret-token'

function reqWith(header) {
  return { headers: header === undefined ? {} : { authorization: header } }
}

test('accepts a correctly-cased Bearer header with the exact token', () => {
  assert.equal(isAuthorizedAccessToken(reqWith(`Bearer ${TOKEN}`), TOKEN), true)
})

test('accepts a lowercase "bearer" scheme', () => {
  assert.equal(isAuthorizedAccessToken(reqWith(`bearer ${TOKEN}`), TOKEN), true)
})

test('rejects a missing Authorization header', () => {
  assert.equal(isAuthorizedAccessToken(reqWith(undefined), TOKEN), false)
})

test('rejects a non-Bearer scheme', () => {
  assert.equal(isAuthorizedAccessToken(reqWith(`Basic ${TOKEN}`), TOKEN), false)
})

test('rejects a wrong token', () => {
  assert.equal(isAuthorizedAccessToken(reqWith('Bearer wrong-token'), TOKEN), false)
})

test('rejects an empty token', () => {
  assert.equal(isAuthorizedAccessToken(reqWith('Bearer '), TOKEN), false)
})

test('rejects a token that only differs in length', () => {
  assert.equal(isAuthorizedAccessToken(reqWith(`Bearer ${TOKEN}x`), TOKEN), false)
})
