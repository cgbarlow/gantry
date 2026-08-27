// Builds the Azure DevOps web URL for a repository. Keeping this construction shared avoids render and approval links disagreeing about how an organisation, project, or repository is encoded.
function repositoryUrl(azureDevOps) {
  return new URL(
    `${(azureDevOps.baseUrl ?? 'https://dev.azure.com').replace(/\/+$/, '')}/${encodeURIComponent(azureDevOps.organization)}/` +
      `${encodeURIComponent(azureDevOps.project)}/_git/${encodeURIComponent(azureDevOps.repository)}`
  )
}

// Builds the Azure DevOps web URL for a file at a specific branch.
export function artefactFileUrl(azureDevOps, path, branch) {
  const url = repositoryUrl(azureDevOps)
  url.searchParams.set('path', `/${path.replace(/^\/+/, '')}`)
  url.searchParams.set('version', `GB${branch}`)
  url.searchParams.set('_a', 'contents')
  return url.toString()
}

// Builds the Azure DevOps web URL for a specific commit.
export function commitUrl(azureDevOps, commitId) {
  const url = repositoryUrl(azureDevOps)
  url.pathname += `/commit/${encodeURIComponent(commitId)}`
  return url.toString()
}
