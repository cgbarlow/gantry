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
