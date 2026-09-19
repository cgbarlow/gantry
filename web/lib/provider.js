// The "+ New Workspace" wizard's own Provider picker (#8, docs/adr/0037): shown as step 1's very
// first choice, ahead of any location field, because it decides which location fields the wizard
// collects next (Organization/Project/Repository for Azure DevOps, Owner/Repository for GitHub) —
// mirrors web/lib/ticketingSystem.js's `TICKETING_SYSTEMS` "known but visibly disabled" convention
// for `atlassian` (modelled in lib/workspaceRegistry.js's own `PROVIDERS` enum, never selectable
// today, per ADR-0037's "Atlassian... deliberately not implemented").
//
// `gitlab` (ADR-0041) is listed the same "known but visibly disabled" way, deliberately for a
// different reason than atlassian: GitLab's content store, stage branches, sign-off, work items,
// identity and Library repos (settings.js's own `LIBRARY_REPO_PROVIDERS`) are all already built and
// registered (lib/provider.js's `SUPPORTED_PROVIDERS`) — only this wizard's own Register-a-new-
// workspace step (#25) hasn't been wired up to offer Namespace/Project fields for it yet, so
// `registerProvider` can never actually become `'gitlab'` through this picker today. Flip
// `disabled` to `false` and add the location-field branch alongside the existing github/azure-devops
// ternaries once #25 lands — do not remove this entry meanwhile, since a disabled-but-listed row is
// what tells an architect GitLab exists as a Provider rather than looking unsupported outright.
export const PROVIDERS = [
  { id: 'azure-devops', label: 'Azure DevOps', disabled: false },
  { id: 'github', label: 'GitHub', disabled: false },
  { id: 'gitlab', label: 'GitLab', disabled: true, disabledReason: 'Coming soon' },
  { id: 'atlassian', label: 'Atlassian', disabled: true, disabledReason: 'Coming soon' },
]

export const DEFAULT_PROVIDER = 'azure-devops'
