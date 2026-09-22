import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceSettingsEntryMode } from '../web/pages/settings.js'

// #123 (parent #109, ADR-0047) — Workspace Settings is reachable a second way now: directly by
// workspace id (`?id=`), not only through an instance's own `?slug=`. `workspaceSettingsEntryMode`
// is the pure decision `RemoteWorkspaceSettingsPage` makes from its `query` prop before it fetches
// anything — which of the two entry modes this is, or neither. The actual fetching/rendering per mode
// (the new 'workspace-not-found' state, the existing 'no-slug'/'no-workspace' states, credential entry
// landing in the right slot either way) is browser behaviour, covered in tests/settings.playwright.test.js;
// what's asserted here is the routing decision that gates it.

test('an `?id=` query resolves the workspace directly, the existing `?slug=` entry unchanged', () => {
  assert.equal(workspaceSettingsEntryMode({ id: 'ws-123' }), 'id')
  assert.equal(workspaceSettingsEntryMode({ slug: 'my-initiative' }), 'slug')
})

test('`id` wins when both are present — there is no meaningful way to want both', () => {
  assert.equal(workspaceSettingsEntryMode({ id: 'ws-123', slug: 'my-initiative' }), 'id')
})

test('neither param present (a bookmarked/direct `/settings/workspace` URL) resolves to neither', () => {
  assert.equal(workspaceSettingsEntryMode({}), 'neither')
  assert.equal(workspaceSettingsEntryMode(undefined), 'neither')
  assert.equal(workspaceSettingsEntryMode({ from: '/' }), 'neither')
})

test('an empty-string id or slug is treated the same as absent', () => {
  assert.equal(workspaceSettingsEntryMode({ id: '' }), 'neither')
  assert.equal(workspaceSettingsEntryMode({ id: '', slug: '' }), 'neither')
  assert.equal(workspaceSettingsEntryMode({ id: '', slug: 'my-initiative' }), 'slug')
})
