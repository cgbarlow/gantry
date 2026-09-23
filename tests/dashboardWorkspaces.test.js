import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeRegisteredWorkspace,
  isAzureDevOpsProviderWorkspace,
  unrepresentedWorkspaceGroups,
  workspacesNeedingOwnListing,
} from '../web/lib/dashboardWorkspaces.js'

// #122 (parent #109, docs/adr/0047): the dashboard's client-side join between `GET /api/workspaces`
// (every registered workspace) and `GET /api/instances` (every row this request could actually build) —
// see web/lib/dashboardWorkspaces.js's own module doc comment for the full rationale.

test('describeRegisteredWorkspace: Azure DevOps titles on repository, subtitles on organization/project', () => {
  const workspace = {
    provider: 'azure-devops',
    location: { organization: 'acme-org', project: 'acme-project', repository: 'acme-repo' },
  }
  assert.deepEqual(describeRegisteredWorkspace(workspace), { title: 'acme-repo', subtitle: 'acme-org/acme-project' })
})

test('describeRegisteredWorkspace: GitHub titles on repository, subtitles on owner', () => {
  const workspace = { provider: 'github', location: { owner: 'octocat', repository: 'hello-world' } }
  assert.deepEqual(describeRegisteredWorkspace(workspace), { title: 'hello-world', subtitle: 'octocat' })
})

test('describeRegisteredWorkspace: GitLab titles on repository, subtitles on namespace', () => {
  const workspace = { provider: 'gitlab', location: { namespace: 'acme/group', repository: 'widgets' } }
  assert.deepEqual(describeRegisteredWorkspace(workspace), { title: 'widgets', subtitle: 'acme/group' })
})

test('describeRegisteredWorkspace: Atlassian titles on repository, subtitles on the Bitbucket owner — never the Jira fields', () => {
  const workspace = {
    provider: 'atlassian',
    location: { owner: 'acme-team', repository: 'widgets', jiraSite: 'acme.atlassian.net', jiraProjectKey: 'WID' },
  }
  assert.deepEqual(describeRegisteredWorkspace(workspace), { title: 'widgets', subtitle: 'acme-team' })
})

test('isAzureDevOpsProviderWorkspace is true only for provider "azure-devops"', () => {
  assert.equal(isAzureDevOpsProviderWorkspace({ provider: 'azure-devops' }), true)
  assert.equal(isAzureDevOpsProviderWorkspace({ provider: 'github' }), false)
  assert.equal(isAzureDevOpsProviderWorkspace({ provider: 'gitlab' }), false)
  assert.equal(isAzureDevOpsProviderWorkspace({ provider: 'atlassian' }), false)
})

test('unrepresentedWorkspaceGroups omits a workspace that already has a row in instances', () => {
  const instances = [{ slug: 'a', workspace: { id: 'ws-1', kind: 'azureDevOps' } }]
  const workspaces = [
    { id: 'ws-1', provider: 'azure-devops', location: { organization: 'o', project: 'p', repository: 'r' }, hasRegisteredInstances: true },
  ]
  assert.deepEqual(unrepresentedWorkspaceGroups(instances, workspaces), [])
})

test('unrepresentedWorkspaceGroups produces an "unreadable" placeholder when the workspace has registered instances but no rows', () => {
  const instances = []
  const workspaces = [
    {
      id: 'ws-1',
      provider: 'azure-devops',
      location: { organization: 'o', project: 'p', repository: 'r' },
      hasRegisteredInstances: true,
    },
  ]
  const groups = unrepresentedWorkspaceGroups(instances, workspaces)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'placeholder')
  assert.equal(groups[0].state, 'unreadable')
  assert.equal(groups[0].workspaceId, 'ws-1')
  assert.equal(groups[0].isAzureDevOps, true)
  assert.deepEqual(groups[0].instances, [])
})

test('unrepresentedWorkspaceGroups produces an "empty" placeholder when the workspace has never registered any instance', () => {
  const instances = []
  const workspaces = [
    {
      id: 'ws-2',
      provider: 'github',
      location: { owner: 'octocat', repository: 'hello-world' },
      hasRegisteredInstances: false,
    },
  ]
  const groups = unrepresentedWorkspaceGroups(instances, workspaces)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].state, 'empty')
  assert.equal(groups[0].isAzureDevOps, false)
})

test('unrepresentedWorkspaceGroups only builds a placeholder for a workspace with zero rows — one with any row is left out entirely, even alongside an unrepresented one', () => {
  const instances = [{ slug: 'a', workspace: { id: 'ws-1', kind: 'azureDevOps' } }]
  const workspaces = [
    { id: 'ws-1', provider: 'azure-devops', location: { organization: 'o', project: 'p', repository: 'r1' }, hasRegisteredInstances: true },
    { id: 'ws-2', provider: 'github', location: { owner: 'octocat', repository: 'r2' }, hasRegisteredInstances: false },
  ]
  const groups = unrepresentedWorkspaceGroups(instances, workspaces)
  assert.deepEqual(
    groups.map((g) => g.workspaceId),
    ['ws-2']
  )
})

test('unrepresentedWorkspaceGroups returns nothing when every workspace already has a row, or none are registered', () => {
  assert.deepEqual(unrepresentedWorkspaceGroups([], []), [])
  const instances = [{ slug: 'a', workspace: { id: 'ws-1' } }]
  const workspaces = [{ id: 'ws-1', provider: 'azure-devops', location: {}, hasRegisteredInstances: true }]
  assert.deepEqual(unrepresentedWorkspaceGroups(instances, workspaces), [])
})

test('unrepresentedWorkspaceGroups ignores instances with no workspace at all (local rows)', () => {
  const instances = [{ slug: 'local-one', workspace: null }]
  const workspaces = [{ id: 'ws-1', provider: 'azure-devops', location: { organization: 'o', project: 'p', repository: 'r' }, hasRegisteredInstances: true }]
  const groups = unrepresentedWorkspaceGroups(instances, workspaces)
  assert.deepEqual(
    groups.map((g) => g.workspaceId),
    ['ws-1']
  )
})

// ---------- #131: which workspaces get their own credentialed listing ----------
// `workspacesNeedingOwnListing` is the dashboard's bound on how many workspace-scoped listing requests
// it may issue — the pure half of web/lib/workspaceDiscovery.js. Every acceptance criterion about
// *which* workspaces are touched (and, just as importantly, which are left entirely alone) is decided
// here, which is why it's a plain function over plain data rather than logic buried in a component.

const CREDENTIALS = new Set(['ws-cred'])
const hasCredential = (id) => CREDENTIALS.has(id)

test('workspacesNeedingOwnListing selects a credentialed workspace the unscoped listing shows nothing for', () => {
  const workspaces = [{ id: 'ws-cred', provider: 'github', location: { owner: 'octocat', repository: 'r' } }]
  assert.deepEqual(workspacesNeedingOwnListing([], workspaces, hasCredential), ['ws-cred'])
})

test('workspacesNeedingOwnListing leaves a workspace the browser holds NO credential for entirely alone', () => {
  const workspaces = [
    { id: 'ws-cred', provider: 'github', location: {} },
    { id: 'ws-no-cred', provider: 'github', location: {} },
  ]
  assert.deepEqual(workspacesNeedingOwnListing([], workspaces, hasCredential), ['ws-cred'])
})

test('workspacesNeedingOwnListing skips a workspace the unscoped listing already has rows for — no second, redundant request', () => {
  const instances = [{ slug: 'a', workspace: { id: 'ws-cred' } }]
  const workspaces = [{ id: 'ws-cred', provider: 'github', location: {} }]
  assert.deepEqual(workspacesNeedingOwnListing(instances, workspaces, hasCredential), [])
})

test('workspacesNeedingOwnListing skips a provider gantry cannot list instances for at all (atlassian)', () => {
  const workspaces = [{ id: 'ws-cred', provider: 'atlassian', location: {} }]
  assert.deepEqual(workspacesNeedingOwnListing([], workspaces, hasCredential), [])
})

test('workspacesNeedingOwnListing covers every listable provider', () => {
  const workspaces = ['azure-devops', 'github', 'gitlab'].map((provider) => ({ id: 'ws-cred', provider, location: {} }))
  for (const workspace of workspaces) {
    assert.deepEqual(workspacesNeedingOwnListing([], [workspace], hasCredential), ['ws-cred'])
  }
})

test('workspacesNeedingOwnListing issues nothing for an empty or missing listing/workspace set', () => {
  assert.deepEqual(workspacesNeedingOwnListing([], [], hasCredential), [])
  assert.deepEqual(workspacesNeedingOwnListing(null, null, hasCredential), [])
})

// The regression guard the ticket asks for: if the dashboard ever reverted to issuing its listing
// request with no credential available for any workspace, this set would be the *only* thing left that
// could still reach a Provider-backed workspace — so it must never silently collapse to empty while a
// credentialed, unrepresented workspace exists.
test('workspacesNeedingOwnListing: a credentialed Provider-backed workspace with nothing shown for it is never skipped', () => {
  const workspaces = [
    { id: 'ws-cred', provider: 'github', location: {}, hasRegisteredInstances: false },
    { id: 'ws-cred', provider: 'github', location: {}, hasRegisteredInstances: true },
  ]
  // Regardless of whether the server reports anything registered — a workspace whose instances were
  // discovered but are unreadable by the unscoped listing still needs its own credentialed one.
  for (const workspace of workspaces) {
    assert.deepEqual(workspacesNeedingOwnListing([], [workspace], hasCredential), ['ws-cred'])
  }
})
