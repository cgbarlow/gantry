import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reorder } from '../web/lib/reorder.js'

test('reorder moves first to last', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'd', 'a'])
})

test('reorder moves last to first', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c'])
})

test('reorder moves middle element', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 1, 2), ['a', 'c', 'b', 'd'])
})

test('reorder is no-op when from===to', () => {
  const arr = ['a', 'b', 'c']
  assert.deepEqual(reorder(arr, 1, 1), ['a', 'b', 'c'])
})

test('reorder clamps out-of-range indices', () => {
  // from -5 clamps to 0, to 10 clamps to last
  assert.deepEqual(reorder(['a', 'b', 'c'], -5, 10), ['b', 'c', 'a'])
  assert.deepEqual(reorder(['a', 'b', 'c'], 10, -5), ['c', 'a', 'b'])
})

test('reorder does not mutate input', () => {
  const input = ['a', 'b', 'c']
  const copy = [...input]
  const result = reorder(input, 0, 2)
  assert.deepEqual(input, copy)
  assert.notEqual(result, input)
  assert.deepEqual(result, ['b', 'c', 'a'])
})

test('reorder empty list returns empty', () => {
  assert.deepEqual(reorder([], 0, 1), [])
})
