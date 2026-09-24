import { z } from 'zod'
import { errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

async function listWorkspaces({ includeArchived }, { gantryClient }) {
  // #189: discover first, so each Provider-backed workspace's `hasRegisteredInstances` reflects its
  // real instances rather than whether a browser has listed it since gantry serve last restarted.
  await gantryClient.discoverProviderInstances?.()
  const [providerRes, serverRes] = await Promise.all([
    gantryClient.request({ path: '/api/workspaces', query: includeArchived ? { archived: '1' } : undefined }),
    gantryClient.request({ path: '/api/server-workspaces' }),
  ])

  if (!providerRes.ok) return upstreamErrorResult(providerRes)
  if (!serverRes.ok) return upstreamErrorResult(serverRes)

  if (!Array.isArray(providerRes.body) || !Array.isArray(serverRes.body)) {
    return errorResult('gantry serve returned an unexpected shape listing workspaces', {
      workspaces: providerRes.body,
      serverWorkspaces: serverRes.body,
    })
  }

  return okResult({
    workspaces: [
      ...providerRes.body.map((workspace) => ({ ...workspace, kind: 'provider-backed' })),
      ...serverRes.body.map((workspace) => ({ ...workspace, kind: 'server-directory' })),
    ],
  })
}

export const tools = [
  {
    name: 'list_workspaces',
    description:
      '1. Lists every workspace this gantry serve instance knows about. ' +
      '2. Each result is tagged "kind": "provider-backed" (Azure DevOps, GitHub, GitLab, or Atlassian — carries "provider" and "location") or "kind": "server-directory" (no Provider, no PAT). ' +
      '3. Pass includeArchived: true to also include archived Provider-backed workspaces. ' +
      '4. Use a result\'s "id" to target that workspace in every other workspace- or instance-scoped tool.',
    inputSchema: {
      includeArchived: z
        .boolean()
        .optional()
        .describe('Include archived Provider-backed workspaces (default false). Server-directory workspaces have no archived state here.'),
    },
    handler: listWorkspaces,
  },
]
