// ---------- Registered-but-unrepresented workspaces (#122, parent #109, docs/adr/0047) ----------
// `GET /api/instances` only ever contributes a row for a workspace it could actually build a row
// for — a Provider-backed workspace with no credential (request or shared) that resolved for it
// contributes nothing, and so is indistinguishable from a workspace that was never registered at all.
// `GET /api/workspaces` (uncredentialed, lib/workspaceRegistry.js) already lists every *registered*
// workspace regardless of readability — this module is the client-side join between the two: for every
// workspace `GET /api/workspaces` knows about that has zero rows in `instances`, it builds a placeholder
// group so the dashboard still renders a row for it.
//
// Kept free of any preact/htm import (plain data in, plain data out) so it's unit-testable with a bare
// Node `import` — see tests/dashboardWorkspaces.test.js. web/app.js's MasterDetailView is what turns a
// placeholder group into markup.
//
// `GET /api/workspaces` only ever lists Provider-backed workspaces (lib/workspaceRegistry.js has no
// concept of a local/server-directory workspace at all — that's a different registry, `GET
// /api/server-workspaces`) — so every placeholder this module produces is, by construction, for a
// workspace that has a credential slot to offer. A local workspace with zero instances simply never
// reaches this join and so never sprouts a credential prompt it has no use for.

// A placeholder row's title/subtitle for a workspace with no instance of its own to read one from
// (unlike `groupInstancesByWorkspace`'s populated rows, in web/app.js) — one branch per Provider
// (lib/provider.js's enum), mirroring that module's own `describeProviderLocation` convention:
// `repository` is always the title (the thing a person is actually looking for), the provider's own
// "where" fields are the subtitle. Atlassian's Jira fields (`jiraSite`/`jiraProjectKey`) aren't a repo
// location and are left off the subtitle for the same reason `describeProviderLocation` leaves them off
// its own label — this is describing a repo, not a work-item tracker.
export function describeRegisteredWorkspace(workspace) {
  const location = workspace.location ?? {}
  const title = location.repository ?? ''
  switch (workspace.provider) {
    case 'azure-devops':
      return { title, subtitle: `${location.organization}/${location.project}` }
    case 'github':
      return { title, subtitle: location.owner }
    case 'gitlab':
      return { title, subtitle: location.namespace }
    case 'atlassian':
      return { title, subtitle: location.owner }
    default:
      return { title, subtitle: workspace.provider }
  }
}

// The placeholder counterpart of web/app.js's own `isAzureDevOpsBacked` — over a `GET /api/workspaces`
// row's `provider` field (this route never denormalizes a `kind`, only an instance row does) rather than
// an instance row's `workspace.kind`. Lets the dashboard hide an Azure-DevOps-backed placeholder the
// same way #301 already hides a populated Azure-DevOps-backed row when advanced mode is off.
export function isAzureDevOpsProviderWorkspace(workspace) {
  return workspace.provider === 'azure-devops'
}

// The join itself: every workspace in `workspaces` (a `GET /api/workspaces` listing — archived ones
// excluded by the caller not passing `?archived=1`, the same convention `ArchivedWorkspacesPanel`'s own
// separate fetch already uses) that has no row at all in `instances` (`GET /api/instances`) becomes its
// own placeholder group.
//
// `state`: `'unreadable'` when the workspace's own registry entry already proves it has at least one
// registered instance (`workspace.hasRegisteredInstances` — lib/instanceRegistry.js's
// `workspaceHasRegisteredInstances`, #122): a slug was registered there at some point, which can only
// have happened with a working credential at the time, so its absence from `instances` *now* can only
// mean the current request can't read it. `'empty'` otherwise — nothing has ever been registered here at
// all, which is a real, distinct fact from "confirmed empty": it's equally true of a workspace nobody has
// ever had a working credential for. The `'empty'` state's own copy (web/app.js's MasterDetailView) is
// worded as "nothing registered yet", never "this workspace is empty" — and offers the exact same
// credential action `'unreadable'` does, since adding one is what turns an actually-empty workspace's
// state into a confirmed one, or an actually-populated one's into real rows (see this repo's own ADR-0047
// and #122's issue body: "a workspace with nothing discovered inside it had no route to its own
// credential field").
export function unrepresentedWorkspaceGroups(instances, workspaces) {
  const representedIds = new Set(instances.map((inst) => inst.workspace?.id).filter(Boolean))
  return workspaces
    .filter((workspace) => !representedIds.has(workspace.id))
    .map((workspace) => {
      const { title, subtitle } = describeRegisteredWorkspace(workspace)
      return {
        key: `workspace:${workspace.id}`,
        kind: 'placeholder',
        state: workspace.hasRegisteredInstances ? 'unreadable' : 'empty',
        title,
        subtitle,
        workspaceId: workspace.id,
        isAzureDevOps: isAzureDevOpsProviderWorkspace(workspace),
        instances: [],
      }
    })
}
