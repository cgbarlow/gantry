import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeRegisteredWorkspace,
  isAzureDevOpsProviderWorkspace,
  unrepresentedWorkspaceGroups,
  workspacesNeedingOwnListing,
  describeInstanceRowWorkspace,
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


// ---------------------------------------------------------------------------
// #135: `describeInstanceRowWorkspace` — the populated-row counterpart of
// `describeRegisteredWorkspace` above. These two describe the same workspace from two different
// payloads, and the reason this function exists is that they drifted: web/app.js read `.name` for
// every row-workspace kind that wasn't Azure DevOps, which is a field only the server-directory shape
// has. A GitHub- or GitLab-backed row therefore produced `title: undefined`, and
// `groupInstancesByWorkspace`'s own `sort` threw `undefined.localeCompare` — taking the entire
// dashboard down rather than mislabelling one row. Unreachable until #131 made Provider-backed rows
// appear on the dashboard at all.
// ---------------------------------------------------------------------------

test('describeInstanceRowWorkspace: a GitHub row titles on its repository, not the absent name field', () => {
  // The exact shape lib/registry.js's `rowGitHubWorkspace` emits: no `name`, no top-level
  // `repository` — the repo lives under `location`, and reading `.name` here is what crashed #131.
  const workspace = { kind: 'github', id: 'ws-1', location: { owner: 'cgbarlow', repository: 'gantry-workspace-testing' }, owner: 'c.barlow' }
  assert.deepEqual(describeInstanceRowWorkspace(workspace), { title: 'gantry-workspace-testing', subtitle: 'cgbarlow' })
})

test('describeInstanceRowWorkspace: a GitLab row titles on its repository, subtitles on its namespace', () => {
  const workspace = { kind: 'gitlab', id: 'ws-2', location: { namespace: 'acme-group', repository: 'acme-repo' }, owner: 'someone' }
  assert.deepEqual(describeInstanceRowWorkspace(workspace), { title: 'acme-repo', subtitle: 'acme-group' })
})

test('describeInstanceRowWorkspace: Azure DevOps keeps reading its denormalized top-level fields', () => {
  // This shape alone denormalizes repository/organization/project to the top level — the one kind the
  // pre-#135 code got right, pinned so the fix cannot regress it.
  const workspace = { kind: 'azureDevOps', id: 'ws-3', organization: 'acme-org', project: 'acme-project', repository: 'acme-repo' }
  assert.deepEqual(describeInstanceRowWorkspace(workspace), { title: 'acme-repo', subtitle: 'acme-org/acme-project' })
})

test('describeInstanceRowWorkspace: a server-directory row keeps its name and description', () => {
  const workspace = { kind: 'directory', id: 'examples', name: 'Examples', description: 'Bundled with Gantry' }
  assert.deepEqual(describeInstanceRowWorkspace(workspace), { title: 'Examples', subtitle: 'Bundled with Gantry' })
})

test('describeInstanceRowWorkspace: a server-directory row with no description falls back, as before', () => {
  const workspace = { kind: 'directory', id: 'examples', name: 'Examples' }
  assert.deepEqual(describeInstanceRowWorkspace(workspace), { title: 'Examples', subtitle: 'Server workspace' })
})

test('describeInstanceRowWorkspace: no workspace at all is the local-instance case', () => {
  assert.deepEqual(describeInstanceRowWorkspace(undefined), { title: null, subtitle: 'Server instance' })
})

test('describeInstanceRowWorkspace: every known kind yields a sortable, non-empty title', () => {
  // The actual regression guard. `groupInstancesByWorkspace` sorts on `title`, so a kind that yields
  // `undefined` is not a cosmetic defect — it throws and the dashboard renders nothing at all.
  const rows = [
    { kind: 'github', id: 'a', location: { owner: 'o', repository: 'r' } },
    { kind: 'gitlab', id: 'b', location: { namespace: 'n', repository: 'r' } },
    { kind: 'azureDevOps', id: 'c', organization: 'o', project: 'p', repository: 'r' },
    { kind: 'atlassian', id: 'd', location: { owner: 'o', repository: 'r' } },
    { kind: 'directory', id: 'e', name: 'Examples' },
  ]
  for (const workspace of rows) {
    const { title } = describeInstanceRowWorkspace(workspace)
    assert.equal(typeof title, 'string', `kind ${workspace.kind} produced a non-string title`)
    assert.ok(title.length > 0, `kind ${workspace.kind} produced an empty title`)
    assert.doesNotThrow(() => title.localeCompare('x'), `kind ${workspace.kind} produced an unsortable title`)
  }
})

test('describeInstanceRowWorkspace: an unrecognised kind degrades to its id rather than to undefined', () => {
  // A shape nobody has invented yet must still sort. Labelling a row with an id is recoverable;
  // labelling it `undefined` crashes the page, which is the failure this whole function exists for.
  const { title } = describeInstanceRowWorkspace({ kind: 'some-future-provider', id: 'ws-9' })
  assert.equal(title, 'ws-9')
})
