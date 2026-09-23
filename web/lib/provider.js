// The "+ New Workspace" wizard's own Provider picker (#8, docs/adr/0037): shown as step 1's very
// first choice, ahead of any location field, because it decides which location fields the wizard
// collects next (Organization/Project/Repository for Azure DevOps, Owner/Repository for GitHub).
//
// `gitlab` (ADR-0041, #25) is a real, selectable Provider choice: its content store, stage branches,
// sign-off, work items, identity and Library repos (settings.js's own `LIBRARY_REPO_PROVIDERS`) are
// all built and registered (lib/provider.js's `SUPPORTED_PROVIDERS`), and this wizard's own
// Register-a-new-workspace step now offers Namespace/Project (+ optional self-hosted base URL) fields
// for it, mirroring the github/azure-devops ternaries.
//
// `atlassian` (ADR-0042, #48) is now a real, selectable Provider choice too — the last one ADR-0037
// modelled but left "known but visibly disabled". Its split-suite capabilities (Bitbucket Cloud
// content store, Jira Cloud work items, Bitbucket-backed identity for reviewers, Jira-backed identity
// for assignees — lib/providerRegistry.js's `atlassian` entry) landed across #40-#45; this ticket
// (#48) is what actually wires the wizard's Register step to collect its four location fields
// (`owner`/`repository` for Bitbucket, `jiraSite`/`jiraProjectKey` for Jira) and its two PATs
// (`web/lib/credential.js`'s `{bitbucket, jira}` shape, #40), and end-to-end registers a real
// workspace via `POST /api/workspaces` (`lib/repoCheck.js`'s `checkAtlassianRepo`). No provider is
// left in the "known but disabled" state any more.
export const PROVIDERS = [
  { id: 'azure-devops', label: 'Azure DevOps', disabled: false },
  { id: 'github', label: 'GitHub', disabled: false },
  { id: 'gitlab', label: 'GitLab', disabled: false },
  { id: 'atlassian', label: 'Atlassian', disabled: false },
]

export const DEFAULT_PROVIDER = 'azure-devops'

// ---------- Work-item link shape (#136) ----------
// `lib/workItemLink.js` records an instance's work-item link in the shape its own Provider uses:
// Azure DevOps as `{ organization, project, workItemType, parentId, stages }`, GitHub (docs/adr/0040)
// as `{ provider: 'github', owner, repository, parentNumber, stages }`. The writer has always known
// about both. The *reader* didn't: every display site in web/ read `workItem.parentId`, which is
// `undefined` for a GitHub-linked instance — so the module editor's Work item details panel rendered
// a bare "#", Settings rendered "#undefined" under an "Azure DevOps work item" heading, and the
// dashboard's own "Track Work Item" affordance was gated off entirely (`hasManageLinks`).
//
// The same writer-knows/reader-doesn't drift as #135's dashboard crash, in a different layer. These
// two helpers are the single place the shape difference is resolved, so a fifth display site can't
// reintroduce it.

/**
 * The parent work item's own reference — GitHub's issue `parentNumber` or Azure DevOps' `parentId` —
 * or `null` for an unlinked instance (or a link recording neither, which is a malformed record rather
 * than a supported state). Both are rendered to the user as `#<ref>` and both are what
 * `workItemWebUrlFor`'s `wiId` argument expects, so callers need not know which they got.
 */
export function workItemParentRef(workItem) {
  if (!workItem) return null
  return workItem.parentNumber ?? workItem.parentId ?? null
}

/**
 * How to label a work-item link in a read-only summary, per Provider: the section heading, the
 * location rows above the parent, and what the parent itself is called. Kept as plain data (no
 * markup) so it stays unit-testable and so each screen renders it in its own idiom.
 *
 * Azure DevOps carries a work-item *type* (Task, Bug, ...); GitHub issues are untyped and
 * docs/adr/0040 drops the concept rather than emulating it, so that row is simply absent there —
 * never rendered as an empty or invented value.
 */
export function describeWorkItemLink(workItem) {
  if (!workItem) return null
  if (workItem.provider === 'github') {
    return {
      heading: 'GitHub issue',
      unlinkedText: "This instance isn't linked to a GitHub issue.",
      rows: [
        { k: 'Owner', v: workItem.owner },
        { k: 'Repository', v: workItem.repository },
      ],
      parentLabel: 'Parent issue',
    }
  }
  if (workItem.provider === 'gitlab') {
    return {
      heading: 'GitLab issue',
      unlinkedText: "This instance isn't linked to a GitLab issue.",
      rows: [
        { k: 'Namespace', v: workItem.namespace },
        { k: 'Repository', v: workItem.repository },
      ],
      parentLabel: 'Parent issue',
    }
  }
  return {
    heading: 'Azure DevOps work item',
    unlinkedText: "This instance isn't linked to an Azure DevOps work item.",
    rows: [
      { k: 'Organization', v: workItem.organization },
      { k: 'Project', v: workItem.project },
      { k: 'Work item type', v: workItem.workItemType },
    ],
    parentLabel: 'Parent work item',
  }
}
