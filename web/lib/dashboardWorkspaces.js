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

// #131 (parent #109, docs/adr/0047): the providers whose repos gantry can actually list instances out
// of — `lib/instanceRegistry.js`'s own `PROVIDER_ENTRY_KIND` keys, mirrored here so the dashboard never
// asks for a workspace-scoped listing the server would only reject with a 400 (an Atlassian workspace
// has no instance-registry entry kind yet). Mirrored by hand rather than fetched, exactly as
// `describeRegisteredWorkspace` above mirrors `lib/provider.js`'s own enum.
const LISTABLE_PROVIDERS = ['azure-devops', 'github', 'gitlab']

/**
 * #131: which workspaces the dashboard should fetch its own, credentialed, workspace-scoped listing
 * for (`GET /api/workspaces/:id/instances`) — the ids of every registered workspace that
 *
 *   (a) the browser holds a stored credential for (`hasCredential`, injected so this stays a pure
 *       function over plain data — web/lib/credential.js is a signals module, and this file
 *       deliberately imports nothing), and
 *   (b) contributes no row at all to the unscoped `GET /api/instances` listing.
 *
 * (b) is the same set `unrepresentedWorkspaceGroups` above turns into placeholder rows — i.e. exactly
 * the workspaces the dashboard is currently unable to show anything for. A workspace the shared
 * listing can already show (its rows are there, whether read with the request's own credential or a
 * deployment-held one, #121) is never asked for again, so a deployment with a shared credential
 * configured issues no extra requests at all, and neither does a dashboard of purely local
 * workspaces. The bound on request volume is therefore "at most one per credentialed Provider-backed
 * workspace the dashboard cannot otherwise show" — and web/lib/workspaceDiscovery.js caps even that at
 * one attempt per workspace per page-session.
 */
export function workspacesNeedingOwnListing(instances, workspaces, hasCredential) {
  const representedIds = new Set((instances ?? []).map((inst) => inst.workspace?.id).filter(Boolean))
  return (workspaces ?? [])
    .filter((workspace) => workspace?.id && !representedIds.has(workspace.id))
    .filter((workspace) => LISTABLE_PROVIDERS.includes(workspace.provider))
    .filter((workspace) => hasCredential(workspace.id))
    .map((workspace) => workspace.id)
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
        // #187: 'blank' — every instance here is archived, so it is simply an empty workspace.
        state: workspace.hasRegisteredInstances ? 'unreadable' : workspace.hasArchivedInstances ? 'blank' : 'empty',
        title,
        subtitle,
        workspaceId: workspace.id,
        isAzureDevOps: isAzureDevOpsProviderWorkspace(workspace),
        instances: [],
      }
    })
}

// #135: the populated-row counterpart of `describeRegisteredWorkspace` above, over an *instance row's*
// denormalized `workspace` (lib/registry.js's `rowWorkspace`/`rowGitHubWorkspace`/`rowGitLabWorkspace`/
// `rowServerWorkspace`) rather than a `GET /api/workspaces` record. The two shapes genuinely differ and
// only three of the four row shapes carry anything usable at the top level: the Azure DevOps shape
// denormalizes `repository`/`organization`/`project`, a server-directory one carries `name`/
// `description`, and the GitHub and GitLab ones carry neither — their repo lives under `location`, the
// same as a `GET /api/workspaces` record's does.
//
// web/app.js's `groupInstancesByWorkspace` used to read `.name` for every kind that wasn't Azure
// DevOps, which left `title` `undefined` for a GitHub- or GitLab-backed workspace and threw in that
// function's own `sort` (`a.title.localeCompare`). It was unreachable until #131: before it, a
// Provider-backed row needed a credential the dashboard's own listing request never carried, so these
// rows never reached the grouping at all. #131 made them reachable and the latent bug became a crash
// that took the whole dashboard down.
//
// Falls back to the workspace id rather than an empty string for an unrecognised shape: a row labelled
// with an id is recoverable, a row labelled `undefined` crashes the page and a row labelled '' is
// invisible.
export function describeInstanceRowWorkspace(workspace) {
  if (!workspace) return { title: null, subtitle: 'Server instance' }
  const location = workspace.location ?? {}
  switch (workspace.kind) {
    case 'azureDevOps':
      return { title: workspace.repository, subtitle: `${workspace.organization}/${workspace.project}` }
    case 'github':
      return { title: location.repository ?? workspace.id, subtitle: location.owner ?? 'GitHub' }
    case 'gitlab':
      return { title: location.repository ?? workspace.id, subtitle: location.namespace ?? 'GitLab' }
    case 'atlassian':
      return { title: location.repository ?? workspace.id, subtitle: location.owner ?? 'Atlassian' }
    case 'directory':
      return { title: workspace.name, subtitle: workspace.description || 'Server workspace' }
    default:
      return {
        title: workspace.name ?? location.repository ?? workspace.id,
        subtitle: workspace.kind ?? 'Workspace',
      }
  }
}

// The dashboard's "+ New Instance" button in a selected workspace's header: the same `/new-instance`
// shortcut the Instance Switcher's own "+ New Instance" link uses, which opens the wizard's New
// Instance step already scoped to that workspace. Returns null wherever that shortcut can't create
// into the workspace: a server directory workspace such as the bundled Examples (the wizard only
// resolves `?workspace=` against `GET /api/workspaces`, which lists Provider workspaces), and a local
// workspace whose folder isn't granted yet.
export function workspaceNewInstanceHref(group) {
  if (group.kind === 'local') {
    return group.state === 'granted' ? `/new-instance?local=${encodeURIComponent(group.entry.id)}` : null
  }
  if (group.kind === 'placeholder') return `/new-instance?workspace=${encodeURIComponent(group.workspaceId)}`
  const workspace = group.instances.find((inst) => inst.workspace)?.workspace
  if (!workspace || workspace.kind === 'directory') return null
  return `/new-instance?workspace=${encodeURIComponent(workspace.id)}`
}
