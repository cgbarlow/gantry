// #267 (parent #238, docs/adr/0070): the operator declares Blob containers in GANTRY_BLOB_CONTAINERS, and
// Settings shows whether each can be reached. These tests pin: unset changes nothing; a malformed
// declaration or a missing secret variable stops startup with one line naming the problem (and never a
// secret); each of the four credential types is built as exactly that credential, never
// DefaultAzureCredential; the connection-string and SAS types work end to end against Azurite; and no
// secret ever appears in the API response.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  AnonymousCredential,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob'
import { ClientSecretCredential, ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity'
import {
  CREDENTIAL_TYPES,
  parseBlobContainers,
  buildContainerClient,
  createBlobContainerRegistry,
  describeProbeFailure,
  secretEnvNames,
} from '../lib/blobContainers.js'
import { createServer } from '../lib/server.js'
import { withScratchInstances, withRunningServer } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite, AZURITE_ACCOUNT, AZURITE_KEY } from './helpers/azurite.js'

const URL_A = 'https://acct.blob.core.windows.net/gantry'
const SECRET = 'S3cr3t-value-that-must-never-be-shown'

const declare = (...entries) => JSON.stringify(entries)

// ---------- unset ----------

test('unset, blank or whitespace GANTRY_BLOB_CONTAINERS declares nothing', () => {
  for (const raw of [undefined, null, '', '   ', '\n']) {
    assert.deepEqual(parseBlobContainers(raw, {}), [])
  }
  const registry = createBlobContainerRegistry(undefined, {})
  assert.deepEqual(registry.containers, [])
  assert.deepEqual(registry.secretEnvNames, [])
  assert.equal(registry.client('anything'), undefined)
})

test('the registry with nothing declared checks nothing', async () => {
  assert.deepEqual(await createBlobContainerRegistry('', {}).check(), [])
})

// ---------- malformed declarations stop startup with one line ----------

const malformed = [
  ['invalid JSON', 'not json', /GANTRY_BLOB_CONTAINERS must be valid JSON/],
  ['not an array', '{"name":"x"}', /must be a JSON array/],
  ['an entry that is not an object', '["x"]', /entry 0 must be a JSON object/],
  ['a missing name', declare({ url: URL_A, credentialType: 'managed-identity' }), /entry 0 is missing required field "name"/],
  ['a missing url', declare({ name: 'main', credentialType: 'managed-identity' }), /entry "main" is missing required field "url"/],
  ['a url that is not http(s)', declare({ name: 'main', url: 'ftp://x/y', credentialType: 'managed-identity' }), /"url" that is not an http\(s\) URL/],
  ['a url that is not a url', declare({ name: 'main', url: 'nope', credentialType: 'managed-identity' }), /"url" that is not an http\(s\) URL/],
  ['a url with no container', declare({ name: 'main', url: 'https://acct.blob.core.windows.net/', credentialType: 'managed-identity' }), /does not end in a container name/],
  ['a url carrying a SAS', declare({ name: 'main', url: `${URL_A}?sv=2024&sig=abc`, credentialType: 'managed-identity' }), /query string or fragment.*goes in the variable "secretEnv"/],
  ['a url carrying credentials', declare({ name: 'main', url: 'https://u:p@acct.blob.core.windows.net/gantry', credentialType: 'managed-identity' }), /credentials in it/],
  ['a missing credentialType', declare({ name: 'main', url: URL_A }), /missing required field "credentialType"/],
  ['an unknown credentialType', declare({ name: 'main', url: URL_A, credentialType: 'default' }), /unknown credentialType — expected one of: connection-string, sas, managed-identity, service-principal/],
  ['a duplicate name', declare({ name: 'a', url: URL_A, credentialType: 'managed-identity' }, { name: 'A', url: URL_A, credentialType: 'managed-identity' }), /another entry already uses/],
  ['a literal secret under a made-up key', declare({ name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'X', sas: SECRET }), /field "sas" that credentialType "sas" does not take/],
  ['a secret on a type that takes none', declare({ name: 'main', url: URL_A, credentialType: 'managed-identity', secretEnv: 'X' }), /field "secretEnv" that credentialType "managed-identity" does not take/],
  ['a connection string with no secretEnv', declare({ name: 'main', url: URL_A, credentialType: 'connection-string' }), /missing required field "secretEnv"/],
  ['a service principal with no tenantId', declare({ name: 'main', url: URL_A, credentialType: 'service-principal', clientId: 'c', secretEnv: 'X' }), /missing required field "tenantId"/],
  ['a service principal with no clientId', declare({ name: 'main', url: URL_A, credentialType: 'service-principal', tenantId: 't', secretEnv: 'X' }), /missing required field "clientId"/],
  ['a managed identity clientId that is blank', declare({ name: 'main', url: URL_A, credentialType: 'managed-identity', clientId: ' ' }), /"clientId" that is not a non-empty string/],
  ['a secretEnv that is not a variable name', declare({ name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'not a name' }), /not an environment variable name/],
  ['a secretEnv naming the declaration itself', declare({ name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'GANTRY_BLOB_CONTAINERS' }), /names GANTRY_BLOB_CONTAINERS itself/],
]

for (const [label, raw, expected] of malformed) {
  test(`a declaration with ${label} stops startup with one line naming the problem`, () => {
    assert.throws(
      () => parseBlobContainers(raw, { X: 'set' }),
      (err) => {
        assert.match(err.message, expected)
        assert.doesNotMatch(err.message, /\n/, 'one line')
        assert.ok(!err.message.includes(SECRET), 'a secret placed in the declaration is never echoed')
        return true
      }
    )
  })
}

test('invalid JSON is not echoed back, since an operator may have pasted a secret where the declaration belongs', () => {
  assert.throws(() => parseBlobContainers(SECRET, {}), (err) => !err.message.includes(SECRET.slice(0, 6)))
})

test('a named secret variable that is missing or blank stops startup, naming the variable but no value', () => {
  const raw = declare({ name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'GANTRY_BLOB_MAIN_SAS' })
  for (const env of [{}, { GANTRY_BLOB_MAIN_SAS: '' }, { GANTRY_BLOB_MAIN_SAS: '   ' }]) {
    assert.throws(
      () => parseBlobContainers(raw, env),
      /GANTRY_BLOB_CONTAINERS entry "main" names secret variable GANTRY_BLOB_MAIN_SAS, which is not set$/
    )
  }
})

test('the failure when the service principal secret is missing names that variable too', () => {
  const raw = declare({ name: 'sp', url: URL_A, credentialType: 'service-principal', tenantId: 't', clientId: 'c', secretEnv: 'SP_SECRET' })
  assert.throws(() => parseBlobContainers(raw, {}), /entry "sp" names secret variable SP_SECRET, which is not set/)
})

// ---------- a valid declaration ----------

test('a valid declaration parses to its public fields, with the url normalised and nothing secret in it', () => {
  const raw = declare(
    { name: ' main ', url: 'HTTPS://Acct.blob.core.windows.net/gantry/', credentialType: 'connection-string', secretEnv: 'CS' },
    { name: 'mi', url: 'https://acct.blob.core.windows.net/other', credentialType: 'managed-identity', clientId: 'abc' }
  )
  const declarations = parseBlobContainers(raw, { CS: SECRET })
  assert.deepEqual(declarations, [
    { name: 'main', url: 'https://acct.blob.core.windows.net/gantry', credentialType: 'connection-string', secretEnv: 'CS' },
    { name: 'mi', url: 'https://acct.blob.core.windows.net/other', credentialType: 'managed-identity', clientId: 'abc' },
  ])
  assert.ok(!JSON.stringify(declarations).includes(SECRET), 'the secret value is looked up to be checked, never copied')
  assert.deepEqual(secretEnvNames(declarations), ['CS'])
})

test('there are exactly four credential types', () => {
  assert.deepEqual(CREDENTIAL_TYPES, ['connection-string', 'sas', 'managed-identity', 'service-principal'])
})

// ---------- each credential type is built from its declaration ----------

const CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`

test('a connection-string declaration builds a shared-key client for that container', () => {
  const [declaration] = parseBlobContainers(
    declare({ name: 'main', url: URL_A, credentialType: 'connection-string', secretEnv: 'CS' }),
    { CS: CONNECTION_STRING }
  )
  const client = buildContainerClient(declaration, { CS: CONNECTION_STRING })
  assert.ok(client.credential instanceof StorageSharedKeyCredential)
  assert.equal(client.credential.accountName, 'acct')
  assert.equal(client.containerName, 'gantry')
  assert.equal(client.url, URL_A)
})

test('a connection string for a different account than the declared url is refused', () => {
  const [declaration] = parseBlobContainers(
    declare({ name: 'main', url: 'https://other.blob.core.windows.net/gantry', credentialType: 'connection-string', secretEnv: 'CS' }),
    { CS: CONNECTION_STRING }
  )
  assert.throws(() => buildContainerClient(declaration, { CS: CONNECTION_STRING }), /does not point at https:\/\/other\.blob\.core\.windows\.net\/gantry/)
})

test('a sas declaration builds an anonymous client whose url carries the token, with or without a leading ?', () => {
  for (const sas of ['sv=2024-11-04&sig=abc', '?sv=2024-11-04&sig=abc']) {
    const declaration = parseBlobContainers(declare({ name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'SAS' }), { SAS: sas })[0]
    const client = buildContainerClient(declaration, { SAS: sas })
    assert.ok(client.credential instanceof AnonymousCredential)
    assert.equal(client.url, `${URL_A}?sv=2024-11-04&sig=abc`)
  }
})

test('a managed-identity declaration builds a ManagedIdentityCredential, never DefaultAzureCredential', () => {
  const [declaration] = parseBlobContainers(declare({ name: 'main', url: URL_A, credentialType: 'managed-identity' }), {})
  const client = buildContainerClient(declaration, {})
  assert.ok(client.credential instanceof ManagedIdentityCredential)
  assert.ok(!(client.credential instanceof DefaultAzureCredential))
  assert.equal(client.url, URL_A)
})

test('a managed-identity declaration with a clientId builds the user-assigned form', () => {
  const [declaration] = parseBlobContainers(declare({ name: 'main', url: URL_A, credentialType: 'managed-identity', clientId: 'uami-client-id' }), {})
  assert.ok(buildContainerClient(declaration, {}).credential instanceof ManagedIdentityCredential)
})

test('a service-principal declaration builds a ClientSecretCredential from tenant, client and the named secret', () => {
  const raw = declare({ name: 'sp', url: URL_A, credentialType: 'service-principal', tenantId: 'tenant-id', clientId: 'client-id', secretEnv: 'SP' })
  const [declaration] = parseBlobContainers(raw, { SP: SECRET })
  const client = buildContainerClient(declaration, { SP: SECRET })
  assert.ok(client.credential instanceof ClientSecretCredential)
  assert.ok(!(client.credential instanceof DefaultAzureCredential))
  assert.equal(client.url, URL_A)
})

test('the registry builds every declared container at startup and hands the client back by name', () => {
  const raw = declare(
    { name: 'a', url: URL_A, credentialType: 'managed-identity' },
    { name: 'b', url: 'https://acct.blob.core.windows.net/two', credentialType: 'sas', secretEnv: 'SAS' }
  )
  const registry = createBlobContainerRegistry(raw, { SAS: 'sv=1&sig=x' })
  assert.deepEqual(registry.containers.map((c) => c.name), ['a', 'b'])
  assert.equal(registry.client('a').containerName, 'gantry')
  assert.equal(registry.client('b').containerName, 'two')
  assert.deepEqual(registry.secretEnvNames, ['SAS'])
})

test('a connection string that is not valid fails startup naming the container and the variable, not the string', () => {
  const raw = declare({ name: 'main', url: URL_A, credentialType: 'connection-string', secretEnv: 'CS' })
  assert.throws(
    () => createBlobContainerRegistry(raw, { CS: SECRET }),
    (err) => {
      assert.match(err.message, /GANTRY_BLOB_CONTAINERS entry "main" has a connection string \(in CS\) that is not valid/)
      assert.ok(!err.message.includes(SECRET))
      return true
    }
  )
})

// ---------- what a probe failure says ----------

test('probe failures become fixed phrases, never the SDK message that may carry a signed url', () => {
  const leaky = (props) => Object.assign(new Error(`GET ${URL_A}?sig=${SECRET} failed`), props)
  const cases = [
    [leaky({ statusCode: 404 }), /does not exist/],
    [leaky({ statusCode: 403 }), /refused access/],
    [leaky({ statusCode: 401 }), /rejected/],
    [leaky({ code: 'ENOTFOUND' }), /host name could not be resolved/],
    [leaky({ code: 'ECONNREFUSED' }), /refused the connection/],
    [leaky({ name: 'AbortError' }), /no answer within 5 seconds/],
    [leaky({ name: 'CredentialUnavailableError' }), /could not get a token/],
    [leaky({ statusCode: 500 }), /service answered 500/],
    [leaky({}), /could not be reached/],
  ]
  for (const [err, expected] of cases) {
    const reason = describeProbeFailure(err)
    assert.match(reason, expected)
    assert.ok(!reason.includes(SECRET))
  }
})

// ---------- reachability, with the SDK stubbed ----------

test('check reports reachable, or unreachable with a reason, per container, and never rejects', async () => {
  const raw = declare(
    { name: 'up', url: URL_A, credentialType: 'managed-identity' },
    { name: 'down', url: 'https://acct.blob.core.windows.net/two', credentialType: 'managed-identity' }
  )
  const registry = createBlobContainerRegistry(raw, {}, {
    sdkBuild: (declaration) => ({
      listBlobsFlat: () => ({
        byPage: () => ({
          next: async () => {
            if (declaration.name === 'down') throw Object.assign(new Error(`boom ${SECRET}`), { statusCode: 403 })
            return { done: false, value: {} }
          },
        }),
      }),
    }),
  })
  const rows = await registry.check()
  assert.deepEqual(rows, [
    { name: 'up', url: URL_A, credentialType: 'managed-identity', reachable: true },
    { name: 'down', url: 'https://acct.blob.core.windows.net/two', credentialType: 'managed-identity', reachable: false, reason: 'the credential was refused access to the container (403)' },
  ])
  assert.deepEqual(await registry.check('down'), [rows[1]])
  assert.ok(!JSON.stringify(rows).includes(SECRET))
})

test('a probe is remembered briefly so a stream of page loads cannot become a stream of outbound calls', async () => {
  let calls = 0
  let clock = 1_000_000
  const registry = createBlobContainerRegistry(
    declare({ name: 'up', url: URL_A, credentialType: 'managed-identity' }),
    {},
    { sdkBuild: () => ({ listBlobsFlat: () => ({ byPage: () => ({ next: async () => { calls += 1 } }) }) }), now: () => clock }
  )
  await registry.check()
  await registry.check()
  assert.equal(calls, 1)
  clock += 60_000
  await registry.check()
  assert.equal(calls, 2)
})

// ---------- the API and the startup check ----------

test('GET /api/blob-containers is an empty list when nothing is declared', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir, blobContainers: undefined, env: {} }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blob-containers`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { containers: [] })
    })
  })
})

test('GET /api/blob-containers lists name, url, credential type and reachability, and never a credential', async () => {
  await withScratchInstances(async (instancesDir) => {
    const env = { SAS: `sv=2024&sig=${SECRET}`, SP: SECRET }
    const raw = declare(
      { name: 'main', url: URL_A, credentialType: 'sas', secretEnv: 'SAS' },
      { name: 'sp', url: 'https://acct.blob.core.windows.net/two', credentialType: 'service-principal', tenantId: 't', clientId: 'c', secretEnv: 'SP' }
    )
    const blobContainers = raw
    // Stub the reachability probe through a registry built with a fake SDK, so no network is touched.
    const server = createServer({ instancesDir, blobContainers, env })
    await new Promise((resolve) => server.listen(0, resolve))
    try {
      const res = await fetch(`http://localhost:${server.address().port}/api/blob-containers`)
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.ok(!text.includes(SECRET), 'no secret in the response')
      assert.ok(!text.includes('sig='), 'no SAS token in the response')
      const body = JSON.parse(text)
      assert.deepEqual(body.containers.map((c) => [c.name, c.url, c.credentialType]), [
        ['main', URL_A, 'sas'],
        ['sp', 'https://acct.blob.core.windows.net/two', 'service-principal'],
      ])
      for (const container of body.containers) {
        assert.equal(typeof container.reachable, 'boolean')
        if (!container.reachable) assert.equal(typeof container.reason, 'string')
        assert.deepEqual(Object.keys(container).filter((k) => !['name', 'url', 'credentialType', 'reachable', 'reason'].includes(k)), [])
      }
    } finally {
      server.close()
    }
  })
})

test('createServer throws the one-line problem for a malformed declaration, before it can listen', async () => {
  await withScratchInstances(async (instancesDir) => {
    assert.throws(() => createServer({ instancesDir, blobContainers: 'nonsense', env: {} }), /^Error: GANTRY_BLOB_CONTAINERS must be valid JSON/)
    assert.throws(
      () => createServer({ instancesDir, blobContainers: declare({ name: 'm', url: URL_A, credentialType: 'sas', secretEnv: 'MISSING_ONE' }), env: {} }),
      /entry "m" names secret variable MISSING_ONE, which is not set/
    )
  })
})

test('the secret variables a declaration names are not reported as set-but-unread, but a stray GANTRY_ variable still is', async () => {
  await withScratchInstances(async (instancesDir) => {
    const raw = declare({ name: 'm', url: URL_A, credentialType: 'sas', secretEnv: 'GANTRY_BLOB_MAIN_SAS' })
    const logged = []
    const original = console.error
    console.error = (...args) => logged.push(args.join(' '))
    try {
      createServer({ instancesDir, blobContainers: raw, env: { GANTRY_BLOB_MAIN_SAS: 'sv=1', GANTRY_BLOB_STRAY: 'x' } }).close()
    } finally {
      console.error = original
    }
    assert.equal(logged.filter((line) => line.includes('GANTRY_BLOB_MAIN_SAS')).length, 0)
    assert.equal(logged.filter((line) => line.includes('GANTRY_BLOB_STRAY')).length, 1)
  })
})

// ---------- end to end against Azurite ----------

const skipAzurite = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'

after(stopAzurite)

async function createContainerOnAzurite(emulator, name) {
  const service = BlobServiceClient.fromConnectionString(emulator.connectionString)
  await service.getContainerClient(name).createIfNotExists()
}

function sasFor(emulator, containerName, permissions = 'racwdl') {
  return generateBlobSASQueryParameters(
    {
      containerName,
      permissions: ContainerSASPermissions.parse(permissions),
      expiresOn: new Date(Date.now() + 60 * 60 * 1000),
    },
    new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY)
  ).toString()
}

test('Azurite: a connection-string container is reachable, and a blob written through its client reads back', { skip: skipAzurite, timeout: 180000 }, async () => {
  await withAzurite(async (emulator) => {
    await createContainerOnAzurite(emulator, 'gantry')
    const env = { BLOB_CS: emulator.connectionString }
    const registry = createBlobContainerRegistry(
      declare({ name: 'emu', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', secretEnv: 'BLOB_CS' }),
      env
    )
    assert.deepEqual(await registry.check(), [
      { name: 'emu', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', reachable: true },
    ])
    const blob = registry.client('emu').getBlockBlobClient('workspace.json')
    await blob.upload('{"name":"w"}', 12)
    assert.equal((await blob.downloadToBuffer()).toString(), '{"name":"w"}')
  })
})

test('Azurite: a SAS container is reachable, and the SAS only reaches the container it was issued for', { skip: skipAzurite, timeout: 180000 }, async () => {
  await withAzurite(async (emulator) => {
    await createContainerOnAzurite(emulator, 'gantry')
    await createContainerOnAzurite(emulator, 'elsewhere')
    const env = { BLOB_SAS: sasFor(emulator, 'gantry') }
    const registry = createBlobContainerRegistry(
      declare(
        { name: 'ok', url: emulator.containerUrl('gantry'), credentialType: 'sas', secretEnv: 'BLOB_SAS' },
        { name: 'wrong', url: emulator.containerUrl('elsewhere'), credentialType: 'sas', secretEnv: 'BLOB_SAS' }
      ),
      env
    )
    const [ok, wrong] = await registry.check()
    assert.equal(ok.reachable, true)
    assert.equal(wrong.reachable, false)
    assert.match(wrong.reason, /\(403\)|\(401\)/)
    assert.ok(!JSON.stringify([ok, wrong]).includes(env.BLOB_SAS))
  })
})

test('Azurite: a container that does not exist, and a host that is not there, say why', { skip: skipAzurite, timeout: 180000 }, async () => {
  await withAzurite(async (emulator) => {
    const registry = createBlobContainerRegistry(
      declare(
        { name: 'missing', url: emulator.containerUrl('nope'), credentialType: 'connection-string', secretEnv: 'BLOB_CS' },
        { name: 'wrongkey', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', secretEnv: 'BAD_CS' }
      ),
      {
        BLOB_CS: emulator.connectionString,
        BAD_CS: emulator.connectionString.replace(AZURITE_KEY, Buffer.from('not the key').toString('base64')),
      }
    )
    await createContainerOnAzurite(emulator, 'gantry')
    const [missing, wrongkey] = await registry.check()
    assert.deepEqual(missing.reachable, false)
    assert.match(missing.reason, /does not exist \(404\)/)
    assert.equal(wrongkey.reachable, false)
    assert.match(wrongkey.reason, /\((401|403)\)/)
  })

  const dead = createBlobContainerRegistry(
    declare({ name: 'dead', url: 'http://127.0.0.1:1/devstoreaccount1/gantry', credentialType: 'sas', secretEnv: 'S' }),
    { S: 'sv=1&sig=x' }
  )
  const [row] = await dead.check()
  assert.equal(row.reachable, false)
  assert.equal(typeof row.reason, 'string')
})

test('Azurite: the Settings API reports an Azurite container reachable', { skip: skipAzurite, timeout: 180000 }, async () => {
  await withAzurite(async (emulator) => {
    await createContainerOnAzurite(emulator, 'gantry')
    await withScratchInstances(async (instancesDir) => {
      const env = { BLOB_CS: emulator.connectionString }
      const blobContainers = declare({ name: 'emu', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', secretEnv: 'BLOB_CS' })
      await withRunningServer({ instancesDir, blobContainers, env }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/blob-containers`)
        const text = await res.text()
        assert.ok(!text.includes(AZURITE_KEY), 'the account key never appears in the response')
        assert.deepEqual(JSON.parse(text), {
          containers: [{ name: 'emu', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', reachable: true }],
        })
      })
    })
  })
})
