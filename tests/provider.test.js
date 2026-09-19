import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS,
  DEFAULT_PROVIDER,
  assertValidProvider,
  normalizeProviderLocation,
  providerLocationsMatch,
  describeProviderLocation,
} from '../lib/provider.js'

// ---------- provider enum (ADR-0037) ----------

test('PROVIDERS models azure-devops, github, gitlab and atlassian, so a future selector can list atlassian as known-but-disabled', () => {
  assert.deepEqual(PROVIDERS, ['azure-devops', 'github', 'gitlab', 'atlassian'])
})

test('DEFAULT_PROVIDER is azure-devops — the value a pre-#3 flat record is read forward as', () => {
  assert.equal(DEFAULT_PROVIDER, 'azure-devops')
})

test('assertValidProvider accepts azure-devops, github and gitlab', () => {
  assert.doesNotThrow(() => assertValidProvider('azure-devops'))
  assert.doesNotThrow(() => assertValidProvider('github'))
  assert.doesNotThrow(() => assertValidProvider('gitlab'))
})

test('assertValidProvider rejects atlassian as not supported yet', () => {
  assert.throws(() => assertValidProvider('atlassian'), /not supported yet/)
})

test('assertValidProvider rejects a completely unknown provider', () => {
  assert.throws(() => assertValidProvider('trello'), /Unknown provider/)
})

// ---------- normalizeProviderLocation ----------

test('normalizeProviderLocation validates and prunes an Azure DevOps location to organization/project/repository/baseUrl', () => {
  const location = normalizeProviderLocation('azure-devops', {
    organization: 'org',
    project: 'proj',
    repository: 'repo',
    baseUrl: 'https://ado.example.internal',
    owner: 'should-be-dropped',
  })
  assert.deepEqual(location, { organization: 'org', project: 'proj', repository: 'repo', baseUrl: 'https://ado.example.internal' })
})

test('normalizeProviderLocation validates and prunes a GitHub location to owner/repository/baseUrl — never requires a project', () => {
  const location = normalizeProviderLocation('github', {
    owner: 'octocat',
    repository: 'repo',
    project: 'should-be-dropped',
  })
  assert.deepEqual(location, { owner: 'octocat', repository: 'repo' })
})

test('normalizeProviderLocation rejects a GitHub location missing owner or repository', () => {
  assert.throws(() => normalizeProviderLocation('github', { owner: 'octocat' }), /missing: repository/)
  assert.throws(() => normalizeProviderLocation('github', { repository: 'repo' }), /missing: owner/)
})

test('normalizeProviderLocation rejects an Azure DevOps location missing any of organization/project/repository', () => {
  assert.throws(() => normalizeProviderLocation('azure-devops', {}), /missing: organization, project, repository/)
})

// ---------- gitlab (ADR-0041: {namespace, repository, baseUrl?}) ----------

test('normalizeProviderLocation validates and prunes a GitLab location to namespace/repository/baseUrl', () => {
  const location = normalizeProviderLocation('gitlab', {
    namespace: 'engineering/platform/backend-services',
    repository: 'repo',
    baseUrl: 'https://gitlab.example.internal',
    owner: 'should-be-dropped',
  })
  assert.deepEqual(location, {
    namespace: 'engineering/platform/backend-services',
    repository: 'repo',
    baseUrl: 'https://gitlab.example.internal',
  })
})

test('normalizeProviderLocation rejects a GitLab location missing namespace or repository', () => {
  assert.throws(() => normalizeProviderLocation('gitlab', { namespace: 'group' }), /missing: repository/)
  assert.throws(() => normalizeProviderLocation('gitlab', { repository: 'repo' }), /missing: namespace/)
})

test('normalizeProviderLocation omits a GitLab baseUrl entirely when absent, same as every other provider', () => {
  const location = normalizeProviderLocation('gitlab', { namespace: 'group', repository: 'repo' })
  assert.ok(!('baseUrl' in location))
})

test('normalizeProviderLocation customizes its error message with entityLabel', () => {
  assert.throws(() => normalizeProviderLocation('github', {}, { entityLabel: 'A library repo location' }), /A library repo location is missing/)
})

test('normalizeProviderLocation omits baseUrl entirely when absent, rather than storing it empty/undefined', () => {
  const location = normalizeProviderLocation('github', { owner: 'octocat', repository: 'repo' })
  assert.ok(!('baseUrl' in location))
})

// ---------- providerLocationsMatch ----------

test('providerLocationsMatch matches an exact Azure DevOps tuple', () => {
  const a = { organization: 'org', project: 'proj', repository: 'repo' }
  const b = { organization: 'org', project: 'proj', repository: 'repo' }
  assert.equal(providerLocationsMatch('azure-devops', a, b), true)
})

test('providerLocationsMatch treats baseUrl as part of the tuple', () => {
  const a = { organization: 'org', project: 'proj', repository: 'repo', baseUrl: 'https://a.example' }
  const b = { organization: 'org', project: 'proj', repository: 'repo' }
  assert.equal(providerLocationsMatch('azure-devops', a, b), false)
})

test('providerLocationsMatch treats an absent baseUrl as equal whether undefined or omitted', () => {
  const a = { owner: 'octocat', repository: 'repo', baseUrl: undefined }
  const b = { owner: 'octocat', repository: 'repo' }
  assert.equal(providerLocationsMatch('github', a, b), true)
})

test('providerLocationsMatch does not confuse a GitHub owner/repository tuple with an Azure DevOps one sharing the repository name — caller must already have matched on provider', () => {
  // organization/project are simply not part of the github schema, so an azure-devops-shaped `b`
  // compared under the 'github' schema only ever looks at owner/repository.
  const githubLocation = { owner: 'shared', repository: 'shared-repo' }
  const azureDevOpsShaped = { organization: 'shared', project: 'shared', repository: 'shared-repo' }
  assert.equal(providerLocationsMatch('github', githubLocation, azureDevOpsShaped), false)
})

// ---------- describeProviderLocation (#4: a display name any lib consumer can build without ----------
// ---------- knowing each provider's own field names) ----------------------------------------------

test('describeProviderLocation renders an Azure DevOps location as organization/project/repository', () => {
  assert.equal(
    describeProviderLocation('azure-devops', { organization: 'org', project: 'proj', repository: 'repo' }),
    'org/proj/repo'
  )
})

test('describeProviderLocation renders a GitHub location as owner/repository — never "undefined/undefined/repo"', () => {
  assert.equal(describeProviderLocation('github', { owner: 'octocat', repository: 'repo' }), 'octocat/repo')
})

test('describeProviderLocation renders a GitLab location as namespace/repository, namespace kept as one opaque segment', () => {
  assert.equal(
    describeProviderLocation('gitlab', { namespace: 'engineering/platform/backend-services', repository: 'repo' }),
    'engineering/platform/backend-services/repo'
  )
})

// ---------- providerLocationsMatch (gitlab) ----------

test('providerLocationsMatch matches an exact GitLab tuple, namespace included', () => {
  const a = { namespace: 'group/subgroup', repository: 'repo' }
  const b = { namespace: 'group/subgroup', repository: 'repo' }
  assert.equal(providerLocationsMatch('gitlab', a, b), true)
})

test('providerLocationsMatch treats a different GitLab namespace as a non-match', () => {
  const a = { namespace: 'group/subgroup', repository: 'repo' }
  const b = { namespace: 'group/other-subgroup', repository: 'repo' }
  assert.equal(providerLocationsMatch('gitlab', a, b), false)
})
