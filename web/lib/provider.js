// The "+ New Workspace" wizard's own Provider picker (#8, docs/adr/0037): shown as step 1's very
// first choice, ahead of any location field, because it decides which location fields the wizard
// collects next (Organization/Project/Repository for Azure DevOps, Owner/Repository for GitHub) —
// mirrors web/lib/ticketingSystem.js's `TICKETING_SYSTEMS` "known but visibly disabled" convention
// for `atlassian` (modelled in lib/workspaceRegistry.js's own `PROVIDERS` enum, never selectable
// today, per ADR-0037's "Atlassian... deliberately not implemented").
//
// `gitlab` (ADR-0041, #25) is a real, selectable Provider choice: its content store, stage branches,
// sign-off, work items, identity and Library repos (settings.js's own `LIBRARY_REPO_PROVIDERS`) are
// all built and registered (lib/provider.js's `SUPPORTED_PROVIDERS`), and this wizard's own
// Register-a-new-workspace step now offers Namespace/Project (+ optional self-hosted base URL) fields
// for it, mirroring the github/azure-devops ternaries. Only `atlassian` remains "known but visibly
// disabled" (never implemented, ADR-0037) — a disabled-but-listed row so an architect sees Atlassian
// exists as a modeled Provider rather than looking wholly unsupported.
export const PROVIDERS = [
  { id: 'azure-devops', label: 'Azure DevOps', disabled: false },
  { id: 'github', label: 'GitHub', disabled: false },
  { id: 'gitlab', label: 'GitLab', disabled: false },
  { id: 'atlassian', label: 'Atlassian', disabled: true, disabledReason: 'Coming soon' },
]

export const DEFAULT_PROVIDER = 'azure-devops'
