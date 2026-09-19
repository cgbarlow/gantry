// The "+ New Workspace" wizard's own Provider picker (#8, docs/adr/0037): shown as step 1's very
// first choice, ahead of any location field, because it decides which location fields the wizard
// collects next (Organization/Project/Repository for Azure DevOps, Owner/Repository for GitHub) —
// mirrors web/lib/ticketingSystem.js's `TICKETING_SYSTEMS` "known but visibly disabled" convention
// for `atlassian` (modelled in lib/workspaceRegistry.js's own `PROVIDERS` enum, never selectable
// today, per ADR-0037's "Atlassian... deliberately not implemented").
export const PROVIDERS = [
  { id: 'azure-devops', label: 'Azure DevOps', disabled: false },
  { id: 'github', label: 'GitHub', disabled: false },
  { id: 'atlassian', label: 'Atlassian', disabled: true, disabledReason: 'Coming soon' },
]

export const DEFAULT_PROVIDER = 'azure-devops'
