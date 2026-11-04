// #319 (docs/adr/0072): a **code repository** as a Source document. It is a pointer, never a copy: a Provider repository and branch
// (GitHub, Azure DevOps, GitLab or Bitbucket), optionally narrowed to some folders, that the AI reads live with tools. Nothing from the
// repository is stored in the Instance; every read records the commit it saw, and a citation names that commit.
//
// This module is pure (no DOM, no Node built-ins) so the browser (the panel, the AI's tools, the editor's citations), the server
// (lib/repositorySource.js reads through the existing Provider clients; lib/render.js prints the Sources appendix) and the MCP server's
// route share one description of the pointer, the paths that are always skipped, the web addresses and the links file.

/** The Providers a pointer can name, with the name the architect sees. `atlassian` is the Bitbucket half of an Atlassian suite. */
export const REPOSITORY_PROVIDERS = Object.freeze([
  { id: 'github', label: 'GitHub' },
  { id: 'azure-devops', label: 'Azure DevOps' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'atlassian', label: 'Bitbucket' },
])

// The location keys of each Provider, as lib/provider.js and the Provider clients already name them. A pointer to Bitbucket needs only the
// repository half of an Atlassian location (`owner`/`repository`), never its Jira site. Bitbucket has no self-hosted base address (ADR-0042).
const LOCATION_KEYS = Object.freeze({
  github: { required: ['owner', 'repository'], optional: ['baseUrl'] },
  'azure-devops': { required: ['organization', 'project', 'repository'], optional: ['baseUrl'] },
  gitlab: { required: ['namespace', 'repository'], optional: ['baseUrl'] },
  atlassian: { required: ['owner', 'repository'], optional: [] },
})

/** The location fields the panel asks for, per Provider, in order: `[{ key, label, optional? }]`. */
export function repositoryLocationFields(provider) {
  const keys = LOCATION_KEYS[provider]
  if (!keys) return []
  const labels = { owner: provider === 'atlassian' ? 'Workspace' : 'Owner', organization: 'Organization', project: 'Project', namespace: 'Group', repository: provider === 'gitlab' ? 'Project' : 'Repository', baseUrl: 'Self-hosted API address' }
  return [...keys.required.map((key) => ({ key, label: labels[key] })), ...keys.optional.map((key) => ({ key, label: labels[key], optional: true }))]
}

export const repositoryProviderLabel = (provider) => REPOSITORY_PROVIDERS.find((p) => p.id === provider)?.label ?? String(provider ?? '')

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** A repository-relative path made plain: no leading or trailing slash, no empty, `.` or `..` segment. `null` for a path that tries to climb out. */
export function cleanRepositoryPath(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.join('/')
}

/**
 * The pointer a manifest entry records, `{ provider, location, branch, folders? }`, keys in a fixed order, or `null` when it is not one.
 * `location` holds exactly the provider's own fields; `branch` is the branch the pointer follows; `folders` (optional) narrows it.
 */
export function normalizeSourceRepository(value) {
  if (!value || typeof value !== 'object') return null
  const provider = text(value.provider)
  const keys = LOCATION_KEYS[provider]
  if (!keys) return null
  const location = {}
  for (const key of keys.required) {
    const v = text(value.location?.[key])
    if (!v) return null
    location[key] = v
  }
  for (const key of keys.optional) {
    const v = text(value.location?.[key])
    if (v) location[key] = v
  }
  const branch = text(value.branch)
  if (!branch) return null
  const folders = [...new Set((Array.isArray(value.folders) ? value.folders : []).map(cleanRepositoryPath).filter(Boolean))]
  return { provider, location, branch, ...(folders.length ? { folders } : {}) }
}

/** Whether a manifest entry is a repository pointer (and not a kept file). */
export function isRepositorySource(entry) {
  return normalizeSourceRepository(entry?.repository) !== null
}

/** `owner/repository`, `organization/project/repository` or `group/project`: how a pointer's repository is named in a sentence. */
export function repositoryName(repository) {
  const keys = LOCATION_KEYS[repository?.provider]
  if (!keys) return ''
  return keys.required.map((key) => repository.location?.[key]).join('/')
}

/** The default title of a pointer: its repository's own name. */
export const defaultRepositoryTitle = (repository) => String(repository?.location?.repository ?? 'Repository')

/** A key for one repository on one Provider host, the same however its pointer is narrowed or which branch it follows: what the architect's token for it is kept under. */
export function repositoryKey(repository) {
  const r = normalizeSourceRepository(repository)
  if (!r) return ''
  return ['source-repository', r.provider, r.location.baseUrl ?? '', repositoryName(r)].join('|')
}

// --- what is always skipped ---------------------------------------------------------------------------------------------

/** Folders of vendored code and build output, skipped wherever they sit. */
export const SKIPPED_REPOSITORY_FOLDERS = Object.freeze([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'vendors', 'third_party', 'third-party', 'Pods', 'Carthage',
  '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo',
  'coverage', '__pycache__', '.venv', 'venv', '.tox', '.gradle', '.terraform',
])

/** The extensions of binaries: pictures, fonts, archives, compiled code, media, office files and databases. */
export const BINARY_REPOSITORY_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.psd', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz', '.jar', '.war', '.ear', '.nupkg', '.whl', '.exe', '.dll', '.so', '.dylib',
  '.a', '.lib', '.o', '.class', '.pyc', '.pyo', '.wasm', '.bin', '.dat', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.webm', '.flac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.db', '.min.js', '.min.css', '.map',
])

const SKIPPED_FOLDER_SET = new Set(SKIPPED_REPOSITORY_FOLDERS.map((f) => f.toLowerCase()))

/** Why a path is never read, as a short phrase (`vendored code or build output`, `a binary file`), or null when it can be. */
export function skippedRepositoryPath(path) {
  const clean = cleanRepositoryPath(path)
  if (clean === null) return 'outside the repository'
  const parts = clean.split('/')
  if (parts.some((part) => SKIPPED_FOLDER_SET.has(part.toLowerCase()))) return 'vendored code or build output'
  const name = (parts[parts.length - 1] ?? '').toLowerCase()
  if (BINARY_REPOSITORY_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'a binary file'
  return null
}

/** Whether bytes read from a repository are a binary file after all: a NUL in the first 8,000 bytes, as git itself decides. */
export function looksBinary(bytes) {
  const n = Math.min(bytes?.length ?? 0, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * Whether `path` lies within the pointer's folders (or is one of the folders on the way down to them, when `orAbove`). A pointer with no
 * folders takes the whole repository.
 */
export function withinRepositoryFolders(repository, path, { orAbove = false } = {}) {
  const folders = repository?.folders ?? []
  if (folders.length === 0) return true
  const clean = cleanRepositoryPath(path) ?? ''
  return folders.some((folder) => clean === folder || clean.startsWith(`${folder}/`) || (orAbove && (clean === '' || folder.startsWith(`${clean}/`))))
}

// --- web addresses ------------------------------------------------------------------------------------------------------
// The Provider's own web page for a repository, a branch or a file at a commit. The same derivations as lib/githubFileUrl.js,
// lib/azureDevOpsFileUrl.js, lib/gitlabFileUrl.js and lib/atlassianFileUrl.js, which the browser cannot import (web/app.js's
// githubWebBaseUrl is the same kind of mirror): a `baseUrl` is always the API root, and a person clicks the web root.

const encodePath = (path) => (cleanRepositoryPath(path) ?? '').split('/').filter(Boolean).map(encodeURIComponent).join('/')

function repositoryWebRoot(repository) {
  const l = repository.location
  if (repository.provider === 'github') {
    const raw = (l.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    const web = raw === 'https://api.github.com' ? 'https://github.com' : raw.replace(/\/api\/v3$/i, '')
    return `${web}/${encodeURIComponent(l.owner)}/${encodeURIComponent(l.repository)}`
  }
  if (repository.provider === 'gitlab') {
    const raw = (l.baseUrl ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '')
    const web = raw === 'https://gitlab.com/api/v4' ? 'https://gitlab.com' : raw.replace(/\/api\/v4$/i, '')
    return `${web}/${String(l.namespace).split('/').filter(Boolean).map(encodeURIComponent).join('/')}/${encodeURIComponent(l.repository)}`
  }
  if (repository.provider === 'azure-devops') {
    return `${(l.baseUrl ?? 'https://dev.azure.com').replace(/\/+$/, '')}/${encodeURIComponent(l.organization)}/${encodeURIComponent(l.project)}/_git/${encodeURIComponent(l.repository)}`
  }
  return `https://bitbucket.org/${encodeURIComponent(l.owner)}/${encodeURIComponent(l.repository)}`
}

/**
 * The web address of the repository on its Provider: at its branch (what **Download** opens), or, with `path` and/or `commit`, of that file
 * or folder as it was at that commit (what a citation opens). `''` when `repository` is not a pointer.
 */
export function repositoryWebAddress(value, { path = '', commit = '' } = {}) {
  const repository = normalizeSourceRepository(value)
  if (!repository) return ''
  const root = repositoryWebRoot(repository)
  const ref = text(commit) || repository.branch
  const file = encodePath(path)
  if (repository.provider === 'azure-devops') {
    const url = new URL(root)
    if (file) url.searchParams.set('path', `/${cleanRepositoryPath(path)}`)
    url.searchParams.set('version', `${text(commit) ? 'GC' : 'GB'}${ref}`)
    return url.toString()
  }
  if (repository.provider === 'github') return `${root}/${file ? 'blob' : 'tree'}/${encodeURIComponent(ref)}${file ? `/${file}` : ''}`
  if (repository.provider === 'gitlab') return `${root}/-/${file ? 'blob' : 'tree'}/${encodeURIComponent(ref)}${file ? `/${file}` : ''}`
  return `${root}/src/${encodeURIComponent(ref)}/${file}`
}

/** A commit as it is shown to a person: its first seven characters. */
export const shortCommit = (commit) => String(commit ?? '').slice(0, 7)

// --- citations ----------------------------------------------------------------------------------------------------------
// A citation of a repository is the ordinary `source:<id>` link with the file and the commit it was read at after it:
//
//     [orders service](source:billing-api?path=src/orders/service.ts&commit=3f2a9c1e...)
//
// A citation without them still names the repository. Every other Source document's citation is unchanged.

/** The part of a citation's address after the id: `?path=…&commit=…`, or '' when there is neither. Slashes stay readable; anything that would end the link is escaped. */
export function repositoryCitationQuery({ path, commit } = {}) {
  const parts = []
  const clean = cleanRepositoryPath(path)
  if (clean) parts.push(`path=${encodeURIComponent(clean).replace(/%2F/g, '/').replace(/\(/g, '%28').replace(/\)/g, '%29')}`)
  if (text(commit)) parts.push(`commit=${encodeURIComponent(text(commit))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

/** `source:<id>?path=…&commit=…` taken apart: `{ id, path?, commit? }`, or null when the address is not a citation. */
export function parseSourceAddress(address) {
  const match = /^source:([A-Za-z0-9][A-Za-z0-9_-]*)(?:\?([^\s)]*))?$/.exec(String(address ?? ''))
  if (!match) return null
  const out = { id: match[1] }
  for (const pair of (match[2] ?? '').split('&')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const key = pair.slice(0, at)
    let value = pair.slice(at + 1)
    try {
      value = decodeURIComponent(value)
    } catch {
      continue
    }
    if (key === 'path' && cleanRepositoryPath(value)) out.path = cleanRepositoryPath(value)
    if (key === 'commit' && value.trim()) out.commit = value.trim()
  }
  return out
}

// --- the links file that Download all adds --------------------------------------------------------------------------------

export const REPOSITORY_LINKS_FILENAME = 'Code repositories.txt'

/**
 * The short text file **Download all (.zip)** adds for the repositories among the Source documents: each one's title, web address, branch
 * and the commits cited, never any code. `citedCommits(id)` lists the commits the Instance's content cites for a pointer. `''` when there
 * is no pointer.
 */
export function repositoryLinksText(entries, citedCommits = () => []) {
  const pointers = (entries ?? []).filter((e) => !e?.removedAt && isRepositorySource(e))
  if (pointers.length === 0) return ''
  const lines = ['Code repositories among these Source documents. They are read live from their Provider; no code is included here.', '']
  for (const entry of pointers) {
    const repository = normalizeSourceRepository(entry.repository)
    const commits = [...new Set(citedCommits(entry.id) ?? [])]
    lines.push(
      `${entry.title || entry.id} (${repositoryProviderLabel(repository.provider)}, ${repositoryName(repository)})`,
      `  Address: ${repositoryWebAddress(repository)}`,
      `  Branch: ${repository.branch}`,
      ...(repository.folders ? [`  Folders: ${repository.folders.join(', ')}`] : []),
      `  Commits cited: ${commits.length ? commits.join(', ') : 'none yet'}`,
      ''
    )
  }
  return lines.join('\n')
}
