import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildImportMap } from '../lib/importmap.js'

test('resolves every root specifier and its transitive dependencies to a real file on disk', () => {
  const { imports } = buildImportMap(['codemirror', '@codemirror/state', '@codemirror/lang-markdown', 'markdown-it', 'dompurify'])

  for (const specifier of ['codemirror', '@codemirror/state', '@codemirror/lang-markdown', 'markdown-it', 'dompurify']) {
    assert.ok(specifier in imports, `expected an entry for "${specifier}"`)
  }

  for (const [specifier, path] of Object.entries(imports)) {
    assert.match(path, /^\/node_modules\//)
    const onDisk = join('.', path)
    assert.ok(existsSync(onDisk), `resolved path for "${specifier}" does not exist: ${onDisk}`)
  }
})

test('follows transitive dependencies — @codemirror/lang-markdown pulls in @lezer/markdown', () => {
  const { imports } = buildImportMap(['@codemirror/lang-markdown'])
  assert.ok('@lezer/markdown' in imports)
  assert.ok('@lezer/common' in imports)
})
