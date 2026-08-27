// Builds the Azure DevOps web URL for a file at a specific branch. Keeping
// this construction shared avoids render and approval links disagreeing about
// how a repository path or branch is encoded.
export function artefactFileUrl(azureDevOps, path, branch) {
  const url = new URL(
    `${(azureDevOps.baseUrl ?? 'https://dev.azure.com').replace(/\/+$/, '')}/${encodeURIComponent(azureDevOps.organization)}/` +
      `${encodeURIComponent(azureDevOps.project)}/_git/${encodeURIComponent(azureDevOps.repository)}`
  )
  url.searchParams.set('path', `/${path.replace(/^\/+/, '')}`)
  url.searchParams.set('version', `GB${branch}`)
  url.searchParams.set('_a', 'contents')
  return url.toString()
}
