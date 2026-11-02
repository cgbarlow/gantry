// GANTRY_BLOB_CONTAINERS (#267, parent #238, docs/adr/0070): the Azure Blob containers an operator
// declares to a deployment, so that a server workspace can be stored in one rather than on the
// server's disk. A declaration names each container, gives its URL and says which kind of credential
// reaches it; any secret sits in a *separate* environment variable that the declaration names, never
// in the declaration itself. This is the third server-held credential after library repos
// (docs/adr/0036, `GANTRY_LIBRARY_PAT_*`) and shared workspaces (docs/adr/0047,
// `GANTRY_SHARED_WORKSPACE_PATS`): it belongs to the deployment, no architect holds it.
//
// Three deliberate rules, each of them load-bearing:
//   1. **Exactly the declared credential type, never `DefaultAzureCredential`.** That chain tries
//      environment, workload identity, managed identity, then the developer's own CLI and VS Code
//      sign-ins, in order, so what authenticated a request would depend on whatever happened to be
//      present in the process. An operator who declared managed identity must get managed identity or
//      a clear failure, not a silent fallback to someone's `az login`.
//   2. **Names only, never values** (the same rule as `lib/envVarCheck.js`). A startup error names the
//      variable that is missing, never what any variable holds, and nothing returned by this module
//      for display carries a secret: not the connection string, not the SAS token, not a client
//      secret, and not an SDK error message that might have echoed a signed URL.
//   3. **Unset means nothing changes.** `GANTRY_BLOB_CONTAINERS` unset or blank parses to no
//      containers and nothing here runs.
//
// Two steps a caller composes, in the same shape as `lib/workspaceBootstrap.js`: `parseBlobContainers`
// validates the raw string and checks that every named secret variable is set (throwing one line, before
// the server listens), and `createBlobContainerRegistry` builds one SDK client per declaration and
// answers "can it be reached right now". The registry is also how the later storage work (#268 on) gets
// a container's client by name — the client never leaves this module for display.
import { BlobServiceClient, ContainerClient, StorageSharedKeyCredential, AnonymousCredential } from '@azure/storage-blob'
import { ClientSecretCredential, ManagedIdentityCredential } from '@azure/identity'

const ENV_VAR_NAME = 'GANTRY_BLOB_CONTAINERS'

export const CREDENTIAL_TYPES = ['connection-string', 'sas', 'managed-identity', 'service-principal']

// Which fields each credential type takes. `name`, `url` and `credentialType` are always required.
const FIELDS_BY_TYPE = {
  'connection-string': { required: ['secretEnv'], optional: [] },
  sas: { required: ['secretEnv'], optional: [] },
  'managed-identity': { required: [], optional: ['clientId'] },
  'service-principal': { required: ['tenantId', 'clientId', 'secretEnv'], optional: [] },
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// How long one "can it be reached" probe may take. A container host that does not answer must not make
// the Settings page hang, and must not hold a server's startup (the probe is never part of startup).
const PROBE_TIMEOUT_MS = 5000
// How long a probe's answer is kept. The endpoint that serves it is not credentialed, so this bounds
// how many outbound requests a stream of page loads can cause to one per container per window.
const PROBE_CACHE_MS = 15000

function describeEntry(index, declaration) {
  const name = declaration !== null && typeof declaration === 'object' && typeof declaration.name === 'string' ? declaration.name.trim() : ''
  return name ? `entry "${name}"` : `entry ${index}`
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Normalises a container URL for comparison and display: no trailing slash, host lower-cased. Returns
 * `null` for anything that is not an http(s) URL.
 */
function normaliseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return { parsed, text: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` }
}

/**
 * Parses and validates `GANTRY_BLOB_CONTAINERS`' raw string into an array of declarations, each
 * `{ name, url, credentialType, secretEnv?, tenantId?, clientId? }` (`url` normalised). `env` is where
 * each declaration's named secret variable is looked up — only to check it is set and non-blank; no
 * value is copied into the result, which is safe to hold, log and serialise.
 *
 * Throws one actionable line, before anything is built, naming the first problem found: invalid JSON,
 * not an array, an entry that is not an object, a missing or duplicate name, a bad URL, an unknown
 * credential type, a field that type does not take (this is what catches a secret pasted into the
 * declaration under a made-up key — the message names the key, never the value), a missing field it
 * does require, or a named secret variable that is not set.
 *
 * Unset or blank returns `[]` — a no-op, not an error.
 */
export function parseBlobContainers(raw, env = process.env) {
  if (raw === undefined || raw === null || raw.trim() === '') return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The expected shape is what an operator needs here. `JSON.parse`'s own message echoes the start of
    // its input, and rule 2 above applies to every message this module throws.
    throw new Error(
      `${ENV_VAR_NAME} must be valid JSON: an array of container declarations, ` +
        '[{"name":"<name>","url":"<container url>","credentialType":"<type>","secretEnv":"<variable name>"}]'
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${ENV_VAR_NAME} must be a JSON array of container declarations`)
  }

  const seenNames = new Set()
  return parsed.map((entry, index) => {
    const label = describeEntry(index, entry)
    const fail = (message) => {
      throw new Error(`${ENV_VAR_NAME} ${label} ${message}`)
    }

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('must be a JSON object')

    if (!isNonEmptyString(entry.name)) fail('is missing required field "name"')
    const name = entry.name.trim()
    if (seenNames.has(name.toLowerCase())) fail('has a name that another entry already uses')
    seenNames.add(name.toLowerCase())

    if (!isNonEmptyString(entry.url)) fail('is missing required field "url"')
    const normalised = normaliseUrl(entry.url.trim())
    if (!normalised) fail('has a "url" that is not an http(s) URL')
    if (normalised.parsed.search || normalised.parsed.hash) {
      // A SAS token belongs in the variable `secretEnv` names. Refusing it here keeps a secret out of the
      // declaration (which is shown in Settings) rather than trusting every later place to hide it.
      fail('has a "url" with a query string or fragment — the container URL has neither; a SAS token goes in the variable "secretEnv" names')
    }
    if (normalised.parsed.username || normalised.parsed.password) fail('has a "url" with credentials in it')
    if (normalised.parsed.pathname.replace(/\/+$/, '') === '') fail('has a "url" that does not end in a container name')

    const credentialType = entry.credentialType
    if (!CREDENTIAL_TYPES.includes(credentialType)) {
      fail(
        credentialType === undefined
          ? `is missing required field "credentialType" — one of: ${CREDENTIAL_TYPES.join(', ')}`
          : `has an unknown credentialType — expected one of: ${CREDENTIAL_TYPES.join(', ')}`
      )
    }

    const { required, optional } = FIELDS_BY_TYPE[credentialType]
    const allowed = new Set(['name', 'url', 'credentialType', ...required, ...optional])
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) fail(`has a field "${key}" that credentialType "${credentialType}" does not take`)
    }
    for (const key of required) {
      if (!isNonEmptyString(entry[key])) fail(`is missing required field "${key}" for credentialType "${credentialType}"`)
    }
    for (const key of optional) {
      if (entry[key] !== undefined && !isNonEmptyString(entry[key])) fail(`has a "${key}" that is not a non-empty string`)
    }

    const declaration = { name, url: normalised.text, credentialType }
    for (const key of [...required, ...optional]) {
      if (entry[key] !== undefined) declaration[key] = entry[key].trim()
    }

    if (declaration.secretEnv !== undefined) {
      if (!ENV_NAME_PATTERN.test(declaration.secretEnv)) fail('has a "secretEnv" that is not an environment variable name')
      if (declaration.secretEnv === ENV_VAR_NAME) fail(`has a "secretEnv" that names ${ENV_VAR_NAME} itself`)
      const value = env?.[declaration.secretEnv]
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`names secret variable ${declaration.secretEnv}, which is not set`)
      }
    }

    return declaration
  })
}

/** The names of the secret variables a set of declarations read — so the unread-variable startup check can leave them alone. */
export function secretEnvNames(declarations) {
  return declarations.map((d) => d.secretEnv).filter((name) => typeof name === 'string')
}

/** Last path segment of a container URL — the container's name. */
function containerNameOf(urlText) {
  const segments = new URL(urlText).pathname.split('/').filter(Boolean)
  return decodeURIComponent(segments[segments.length - 1])
}

/**
 * Builds the SDK `ContainerClient` for one declaration, using exactly the credential type it declares
 * and nothing else (rule 1 at the top of this file). Reads the declaration's named secret from `env`.
 * No network call happens here: a bad connection string or a URL that disagrees with it throws now, a
 * bad key or an unreachable host only shows when the container is first used or probed.
 *
 * - `connection-string`: the account's shared key, from the connection string.
 * - `sas`: the token is appended to the container URL (a leading `?` is tolerated).
 * - `managed-identity`: `ManagedIdentityCredential`, with `clientId` for a user-assigned identity.
 * - `service-principal`: `ClientSecretCredential` from `tenantId`, `clientId` and the named secret.
 */
export function buildContainerClient(declaration, env = process.env) {
  const secret = declaration.secretEnv === undefined ? undefined : env?.[declaration.secretEnv]
  switch (declaration.credentialType) {
    case 'connection-string': {
      const client = BlobServiceClient.fromConnectionString(secret).getContainerClient(containerNameOf(declaration.url))
      // The connection string, not the declaration, decides which account is contacted. If they
      // disagree the Settings page would show one URL while another account was being written to.
      const actual = normaliseUrl(client.url)
      if (!actual || actual.text.toLowerCase() !== declaration.url.toLowerCase()) {
        throw new Error(`the connection string in ${declaration.secretEnv} does not point at ${declaration.url}`)
      }
      return client
    }
    case 'sas':
      return new ContainerClient(`${declaration.url}?${secret.replace(/^\?/, '')}`, new AnonymousCredential())
    case 'managed-identity':
      return new ContainerClient(
        declaration.url,
        declaration.clientId ? new ManagedIdentityCredential({ clientId: declaration.clientId }) : new ManagedIdentityCredential()
      )
    case 'service-principal':
      return new ContainerClient(declaration.url, new ClientSecretCredential(declaration.tenantId, declaration.clientId, secret))
    default:
      throw new Error(`unknown credentialType "${declaration.credentialType}"`)
  }
}

/**
 * Turns whatever went wrong reaching a container into a short reason an operator can act on — and
 * nothing more. Deliberately not `err.message`: an SDK error can carry the request URL (a SAS token
 * included) and a service response body, and this string ends up in an uncredentialed API response.
 */
export function describeProbeFailure(err) {
  const status = err?.statusCode ?? err?.status
  const code = typeof err?.code === 'string' ? err.code : ''
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return 'no answer within 5 seconds'
  }
  if (status === 404 || code === 'ContainerNotFound') return 'the container does not exist (404)'
  if (status === 401) return 'the credential was rejected (401)'
  if (status === 403) return 'the credential was refused access to the container (403)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name could not be resolved'
  if (code === 'ECONNREFUSED') return 'the host refused the connection'
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'the connection was dropped'
  if (err?.name === 'CredentialUnavailableError' || err?.name === 'AuthenticationError' || err?.name === 'AggregateAuthenticationError') {
    return 'the identity could not get a token'
  }
  if (typeof status === 'number') return `the service answered ${status}`
  return 'the container could not be reached'
}

/**
 * Builds a registry for the given raw `GANTRY_BLOB_CONTAINERS` value: one client per declaration, built
 * now so a bad credential fails startup rather than the first use (any error is rethrown as one line
 * naming the container). `env` is read for the named secret variables only.
 *
 * - `containers`: the public view, `[{ name, url, credentialType }]` in declaration order. Safe to
 *   serialise: it holds no secret and no client.
 * - `client(name)`: the SDK `ContainerClient` for a declared container (`undefined` for an unknown
 *   name) — for the storage layer, never for display.
 * - `check(name?)`: probes reachability (one List Blobs for a single result, the call a container-scoped SAS is allowed and the one the storage layer needs anyway; Get Container Properties is refused to such a SAS) and resolves
 *   `[{ name, url, credentialType, reachable, reason? }]`. Never rejects: a failure is a row with
 *   `reachable: false` and a reason from `describeProbeFailure`. Probes run in parallel, time out, and
 *   are remembered briefly (`PROBE_CACHE_MS`).
 * - `secretEnvNames`: the variables the declarations read.
 *
 * `options.sdkBuild` replaces `buildContainerClient` and `options.now` the clock, for tests.
 */
export function createBlobContainerRegistry(raw, env = process.env, options = {}) {
  const declarations = parseBlobContainers(raw, env)
  const build = options.sdkBuild ?? buildContainerClient
  const now = options.now ?? Date.now

  const clients = new Map()
  for (const declaration of declarations) {
    try {
      clients.set(declaration.name, build(declaration, env))
    } catch (err) {
      throw new Error(`${ENV_VAR_NAME} entry "${declaration.name}" ${describeBuildFailure(err, declaration)}`)
    }
  }

  const containers = declarations.map(({ name, url, credentialType }) => Object.freeze({ name, url, credentialType }))
  const probes = new Map()

  async function probe(container) {
    const client = clients.get(container.name)
    try {
      await client.listBlobsFlat({ abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).byPage({ maxPageSize: 1 }).next()
      return { ...container, reachable: true }
    } catch (err) {
      return { ...container, reachable: false, reason: describeProbeFailure(err) }
    }
  }

  function check(name) {
    const wanted = name === undefined ? containers : containers.filter((c) => c.name === name)
    return Promise.all(
      wanted.map((container) => {
        const cached = probes.get(container.name)
        if (cached && now() - cached.at < PROBE_CACHE_MS) return cached.result
        const result = probe(container)
        probes.set(container.name, { at: now(), result })
        return result
      })
    )
  }

  return {
    containers,
    client: (name) => clients.get(name),
    check,
    secretEnvNames: secretEnvNames(declarations),
  }
}

// A build failure's message can come from the SDK (a malformed connection string). It is reduced to a
// fixed phrase per credential type unless it is this module's own deliberate message, for rule 2.
function describeBuildFailure(err, declaration) {
  if (err instanceof Error && /^the connection string in [A-Za-z_][A-Za-z0-9_]* does not point at /.test(err.message)) return err.message
  if (declaration.credentialType === 'connection-string') return `has a connection string (in ${declaration.secretEnv}) that is not valid`
  if (declaration.credentialType === 'sas') return `has a SAS token (in ${declaration.secretEnv}) that is not usable`
  return 'has a credential that could not be built'
}
