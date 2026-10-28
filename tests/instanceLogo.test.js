import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createInstance, readInstance, updateInstanceLogo } from '../lib/instance.js'
import { loadDefinition, writeDefinitionLogo } from '../lib/definition.js'
import { renderArtefact, referenceDocBase64 } from '../lib/render.js'
import { runLocalWorkspaceCompute } from '../lib/localWorkspace.js'
import { definitionHeaderLogo, definitionOffersInstanceLogo, instanceLogoProblem } from '../lib/instanceLogo.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { LOGO_ALT_TEXT, readHeaderLogo } from '../web/lib/definitionLogo.js'
import {
  INSTANCE_LOGO_KEY,
  instanceLogoPath,
  instanceLogoRecordPath,
  instanceLogoStatus,
  withInstanceLogoPath,
} from '../web/lib/instanceLogo.js'
import { renderInstanceYaml, withStoredInstanceLogo } from '../web/lib/localInstanceFiles.js'
import { sectionHeaders } from './helpers/wordHeaders.js'
import { jpegImage, pngImage } from './helpers/logoImages.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #224 (spec #223, ADR-0058 and ADR-0059 amendments for #224): an Instance can have its own header
// logo, chosen in the "+ New Workspace" wizard and changed in Instance Settings. It overrides the
// Definition's logo (#222): a render shows the Instance's logo, else the Definition's, else whatever
// the reference document ships with (Contoso, for design v3). The image is stored with the Instance,
// in its `assets/` folder, and its record names it under `logo:`. The render hands Pandoc a copy of
// the reference document with the header logo replaced; the Definition's own files never change.
// The setting is offered only for a Definition whose reference documents carry a header logo.
//
// The fixtures are tests/instanceSettings.test.js's one-stage Definition: `branded` ships design
// v3's shared reference document (the Contoso logo in its header); `plain` ships none, so it offers
// no Logo. The render tests use the bundled design v3 example, which renders every Artefact.

const V3_REFERENCE = readFileSync(join('definitions', 'design', '3', 'templates', 'reference.docx'))
const CONTOSO = (await readHeaderLogo(new Uint8Array(V3_REFERENCE))).bytes
// The Contoso logo's box in design v3's header, in EMUs (tests/definitionLogo.test.js).
const CONTOSO_BOX = { cx: 1084569, cy: 418011 }
const WIDE_LOGO = pngImage(400, 100)
const NOT_AN_IMAGE = Buffer.from('this is not a picture of anything, just some text that is long enough')

const MODULE = `id: summary\ntitle: Summary\npurpose: What this is\nfields:\n  - id: overview\n    title: Overview\n    type: markdown\n`

function writeFixtureDefinition(definitionsDir, id, { referenceDocx } = {}) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    `id: ${id}\nversion: 1\nstatus: published\ntitle: ${id}\ndescription: A one-stage fixture\nstages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
  )
  writeFileSync(join(dir, 'modules', 'summary.yaml'), MODULE)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
  if (referenceDocx) writeFileSync(join(dir, 'templates', 'reference.docx'), referenceDocx)
}

async function withLibrary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-224-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(instancesDir, { recursive: true })
  try {
    writeFixtureDefinition(definitionsDir, 'branded', { referenceDocx: V3_REFERENCE })
    writeFixtureDefinition(definitionsDir, 'plain')
    return await fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A scratch copy of the bundled design v3 example and its Definition, so a render can be judged and
// the Definition's logo replaced without touching the repo.
async function withDesignExample(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-224-v3-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'kiwi-cover-mutual'), { recursive: true })
    rmSync(join(instancesDir, 'kiwi-cover-mutual', 'out'), { recursive: true, force: true })
    return await fn({ definitionsDir, instancesDir, slug: 'kiwi-cover-mutual' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const referenceDocHashes = (definitionsDir) => {
  const dir = join(definitionsDir, 'design', '3', 'templates')
  return Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith('.docx')).map((n) => [n, sha(readFileSync(join(dir, n)))]))
}

// The first picture in a .docx's page headers, as a reader sees it: the image it shows, its alt text
// and its size, from the headers its sections use (tests/helpers/wordHeaders.js).
async function headerPicture(docx) {
  const logo = await readHeaderLogo(new Uint8Array(docx))
  if (!logo) return null
  for (const { xml } of sectionHeaders(docx)) {
    const drawing = [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map(([d]) => d).find((d) => d.includes('<pic:pic'))
    if (!drawing) continue
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(drawing)
    return { image: Buffer.from(logo.bytes), descr: /<wp:docPr [^>]*descr="([^"]*)"/.exec(drawing)?.[1], extent: { cx: Number(extent[1]), cy: Number(extent[2]) } }
  }
  return null
}

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const put = (body, headers = {}) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

// ---------- The setting itself ----------

describe('the Logo setting', () => {
  test('the record names the logo by its path in the instance\'s assets folder, and nothing else is read as one', () => {
    assert.equal(INSTANCE_LOGO_KEY, 'logo')
    assert.equal(instanceLogoRecordPath('png'), 'assets/instance-logo.png')
    assert.equal(instanceLogoRecordPath('jpeg'), 'assets/instance-logo.jpeg')
    assert.equal(instanceLogoPath({ logo: 'assets/instance-logo.png' }), 'assets/instance-logo.png')
    assert.equal(instanceLogoPath({ logo: 'assets/brand.JPG' }), 'assets/brand.JPG')
    for (const logo of [undefined, '', 'instance-logo.png', '../assets/instance-logo.png', 'assets/../../secret.png', 'modules/x.png', 'assets/logo.gif', 'assets/a/b.png', 42]) {
      assert.equal(instanceLogoPath({ logo }), null, JSON.stringify(logo))
    }
    assert.deepEqual(instanceLogoStatus({ logo: 'assets/instance-logo.png' }), { own: true, source: 'instance' })
    assert.deepEqual(instanceLogoStatus({}), { own: false, source: 'definition' })
    assert.deepEqual(withInstanceLogoPath({ slug: 's', logo: 'assets/instance-logo.png' }, null), { slug: 's' })
    assert.deepEqual(withInstanceLogoPath({ slug: 's' }, 'assets/instance-logo.jpeg'), { slug: 's', logo: 'assets/instance-logo.jpeg' })
  })

  test('the Local Workspace writers record it only when one was uploaded, as the server does', () => {
    const base = { definition: 'd', slug: 's', stage: 'st', assignee: '', definitionVersion: 1 }
    assert.doesNotMatch(renderInstanceYaml(base), /logo/)
    assert.match(renderInstanceYaml({ ...base, logo: 'assets/instance-logo.png' }), /^logo: assets\/instance-logo\.png$/m)
    assert.equal(withStoredInstanceLogo({ slug: 's' }, 'assets/instance-logo.png'), 'logo: assets/instance-logo.png\nslug: s\n')
    assert.equal(withStoredInstanceLogo({ slug: 's', logo: 'assets/instance-logo.png' }, null), 'slug: s\n')
  })

  test('it is offered only when the Definition\'s reference documents carry a header logo, which is the Definition\'s logo', () =>
    withLibrary(({ definitionsDir }) => {
      const branded = loadDefinition('branded', { definitionsDir, version: 1 })
      const plain = loadDefinition('plain', { definitionsDir, version: 1 })
      const logo = definitionHeaderLogo(branded)
      assert.deepEqual(Buffer.from(logo.bytes), Buffer.from(CONTOSO))
      assert.equal(logo.document, 'reference.docx')
      assert.equal(logo.contentType, 'image/png')
      assert.equal(definitionOffersInstanceLogo(branded), true)
      assert.equal(definitionHeaderLogo(plain), null)
      assert.equal(definitionOffersInstanceLogo(plain), false)
      // Every packaged Definition ships the Contoso logo, so each offers it.
      assert.equal(definitionOffersInstanceLogo(loadDefinition('design', { version: 3 })), true)
      assert.equal(definitionOffersInstanceLogo(loadDefinition('recruitment-onboarding', { version: 1 })), true)
    }))

  test('a file that isn\'t a PNG or JPEG is refused, and so is any logo for a Definition that offers none', () =>
    withLibrary(({ definitionsDir }) => {
      const branded = loadDefinition('branded', { definitionsDir, version: 1 })
      const plain = loadDefinition('plain', { definitionsDir, version: 1 })
      assert.equal(instanceLogoProblem(branded, WIDE_LOGO), null)
      assert.equal(instanceLogoProblem(branded, jpegImage(300, 300)), null)
      assert.equal(instanceLogoProblem(branded, NOT_AN_IMAGE), 'The logo must be a PNG or JPEG image.')
      assert.match(instanceLogoProblem(plain, WIDE_LOGO), /Definition "plain" v1 has no logo in its reference documents' page header, so its instances have no Logo setting/)
    }))
})

// ---------- Creating an Instance ----------

describe('creating an instance with a logo', () => {
  test('stores the image in the instance\'s assets folder and names it in the record; without one the record has no key', () =>
    withLibrary(({ definitionsDir, instancesDir }) => {
      createInstance('branded', 'with-logo', { definitionsDir, instancesDir, logo: WIDE_LOGO })
      assert.equal(readInstance('with-logo', { instancesDir }).logo, 'assets/instance-logo.png')
      assert.deepEqual(readFileSync(join(instancesDir, 'with-logo', 'assets', 'instance-logo.png')), WIDE_LOGO)

      createInstance('branded', 'jpeg-logo', { definitionsDir, instancesDir, logo: jpegImage(200, 100) })
      assert.equal(readInstance('jpeg-logo', { instancesDir }).logo, 'assets/instance-logo.jpeg')

      createInstance('branded', 'no-logo', { definitionsDir, instancesDir })
      assert.equal(INSTANCE_LOGO_KEY in readInstance('no-logo', { instancesDir }), false)
      assert.equal(existsSync(join(instancesDir, 'no-logo', 'assets')), false)
    }))

  test('refuses a non-image, or a logo for a Definition without one, before writing anything', () =>
    withLibrary(({ definitionsDir, instancesDir }) => {
      assert.throws(() => createInstance('branded', 'bad-image', { definitionsDir, instancesDir, logo: NOT_AN_IMAGE }), /must be a PNG or JPEG/)
      assert.throws(() => createInstance('plain', 'plain-logo', { definitionsDir, instancesDir, logo: WIDE_LOGO }), /has no logo in its reference documents/)
      assert.equal(existsSync(join(instancesDir, 'bad-image')), false)
      assert.equal(existsSync(join(instancesDir, 'plain-logo')), false)
    }))
})

// ---------- The rendered document ----------

describe('the rendered document', () => {
  test('every Artefact shows the Instance\'s logo in its header, fitted at its own proportions in the original space; the reference documents are untouched', () =>
    withDesignExample(async ({ definitionsDir, instancesDir, slug }) => {
      const before = referenceDocHashes(definitionsDir)
      updateInstanceLogo(slug, WIDE_LOGO, { instancesDir })
      for (const artefact of ['soap', 'soap-full', 'hld', 'sad', 'ssad', 'as-built']) {
        const { docxBytes } = renderArtefact(slug, artefact, { instancesDir, definitionsDir, deliverToClient: true })
        const picture = await headerPicture(docxBytes)
        assert.deepEqual(picture.image, WIDE_LOGO, `${artefact}: the header shows the Instance's logo`)
        assert.equal(picture.descr, LOGO_ALT_TEXT, artefact)
        // A 4:1 logo fills the box's width and is shorter than it, never stretched.
        assert.equal(picture.extent.cx, CONTOSO_BOX.cx, artefact)
        assert.ok(picture.extent.cy <= CONTOSO_BOX.cy, artefact)
        assert.ok(Math.abs(picture.extent.cx / picture.extent.cy - 4) < 0.01, `${artefact}: keeps its aspect ratio`)
      }
      assert.deepEqual(referenceDocHashes(definitionsDir), before, 'the Definition\'s reference documents are not modified')
      assert.deepEqual(readdirSync(tmpdir()).filter((n) => /^gantry-reference-/.test(n)), [], 'the render\'s copy is removed')
    }))

  test('without a logo of its own the document shows the reference document\'s own logo (Contoso), exactly as before', () =>
    withDesignExample(async ({ definitionsDir, instancesDir, slug }) => {
      const { docxBytes, referenceDocPath } = renderArtefact(slug, 'soap', { instancesDir, definitionsDir, deliverToClient: true })
      assert.deepEqual((await headerPicture(docxBytes)).image, Buffer.from(CONTOSO))
      const dryRun = renderArtefact(slug, 'soap', { instancesDir, definitionsDir, dryRun: true })
      assert.equal(dryRun.referenceDocBytes, null)
      assert.equal(referenceDocBase64(dryRun), readFileSync(referenceDocPath).toString('base64'), 'the browser\'s Pandoc gets the Definition\'s file unchanged')
    }))

  test('the Instance\'s logo wins over the Definition\'s, and removing it shows the Definition\'s again', () =>
    withDesignExample(async ({ definitionsDir, instancesDir, slug }) => {
      const definitionLogo = pngImage(100, 100, [0xcc, 0x22, 0x22])
      await writeDefinitionLogo('design', 3, definitionLogo, { definitionsDir })
      const render = async () => (await headerPicture(renderArtefact(slug, 'hld', { instancesDir, definitionsDir, deliverToClient: true }).docxBytes)).image

      assert.deepEqual(await render(), definitionLogo, 'the Definition\'s logo, with none of the Instance\'s own')
      updateInstanceLogo(slug, WIDE_LOGO, { instancesDir })
      assert.deepEqual(await render(), WIDE_LOGO, 'the Instance\'s own logo')
      updateInstanceLogo(slug, null, { instancesDir })
      assert.deepEqual(await render(), definitionLogo, 'the Definition\'s again')
      assert.equal(existsSync(join(instancesDir, slug, 'assets', 'instance-logo.png')), false)
    }))

  test('the browser\'s Pandoc is handed the reference document with the Instance\'s logo, from a dry run', () =>
    withDesignExample(async ({ definitionsDir, instancesDir, slug }) => {
      updateInstanceLogo(slug, WIDE_LOGO, { instancesDir })
      const dryRun = renderArtefact(slug, 'soap', { instancesDir, definitionsDir, dryRun: true })
      assert.deepEqual(Buffer.from((await readHeaderLogo(Buffer.from(referenceDocBase64(dryRun), 'base64'))).bytes), WIDE_LOGO)
    }))

  test('a Local Workspace\'s render sends its logo as an asset beside the instance.yaml naming it, and both its compile and its native render show it', () =>
    withLibrary(async ({ definitionsDir }) => {
      const payload = {
        definitionId: 'branded',
        definitionVersion: 1,
        instanceYaml: renderInstanceYaml({ definition: 'branded', slug: 'local-logo', stage: 'draft', assignee: '', definitionVersion: 1, logo: 'assets/instance-logo.png' }),
        moduleFiles: { summary: '---\nmodule: summary\nstatus: draft\nowner: ""\n---\n\n# Summary\n\n## Overview\n\nHello.\n' },
        assets: [{ id: 'instance-logo.png', base64: b64(WIDE_LOGO) }],
        artefact: 'brief',
      }
      const compiled = await runLocalWorkspaceCompute('compile', payload, { definitionsDir })
      assert.deepEqual(Buffer.from((await readHeaderLogo(Buffer.from(compiled.referenceDocBase64, 'base64'))).bytes), WIDE_LOGO)
      const rendered = await runLocalWorkspaceCompute('render', payload, { definitionsDir })
      assert.deepEqual((await headerPicture(Buffer.from(rendered.docxBase64, 'base64'))).image, WIDE_LOGO)
    }))
})

// ---------- The server API: a local instance ----------

function withServer(fn) {
  return withLibrary(({ definitionsDir, instancesDir }) => withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base, instancesDir })))
}

const localRecord = (instancesDir, slug) => parseYAML(readFileSync(join(instancesDir, 'default', slug, 'instance.yaml'), 'utf8'))
const localAsset = (instancesDir, slug, name) => join(instancesDir, 'default', slug, 'assets', name)

describe('the server API', () => {
  test('creating with a logo stores it; GET /api/instance reports it as the instance\'s own and GET /api/instance/logo serves it', () =>
    withServer(async ({ base, instancesDir }) => {
      assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'branded', slug: 'own', logoImageBase64: b64(WIDE_LOGO) }))).status, 201)
      assert.equal(localRecord(instancesDir, 'own').logo, 'assets/instance-logo.png')
      assert.deepEqual(readFileSync(localAsset(instancesDir, 'own', 'instance-logo.png')), WIDE_LOGO)

      assert.deepEqual((await (await fetch(`${base}/api/instance?slug=own`)).json()).instanceLogo, { own: true, source: 'instance' })
      const logo = await (await fetch(`${base}/api/instance/logo?slug=own`)).json()
      assert.deepEqual({ source: logo.source, contentType: logo.contentType, extension: logo.extension }, { source: 'instance', contentType: 'image/png', extension: 'png' })
      assert.deepEqual(Buffer.from(logo.imageBase64, 'base64'), WIDE_LOGO)

      assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'branded', slug: 'none' }))).status, 201)
      assert.deepEqual((await (await fetch(`${base}/api/instance?slug=none`)).json()).instanceLogo, { own: false, source: 'definition' })
      const definitions = await (await fetch(`${base}/api/instance/logo?slug=none`)).json()
      assert.equal(definitions.source, 'definition')
      assert.deepEqual(Buffer.from(definitions.imageBase64, 'base64'), Buffer.from(CONTOSO))
      assert.equal(INSTANCE_LOGO_KEY in localRecord(instancesDir, 'none'), false)
    }))

  test('PUT replaces the logo (a JPEG drops the PNG) and DELETE goes back to the Definition\'s', () =>
    withServer(async ({ base, instancesDir }) => {
      await fetch(`${base}/api/instances`, json({ definition: 'branded', slug: 'changing', logoImageBase64: b64(WIDE_LOGO) }))
      const jpeg = jpegImage(300, 300)
      const replaced = await fetch(`${base}/api/instance/logo?slug=changing`, put({ imageBase64: b64(jpeg) }))
      assert.equal(replaced.status, 200)
      assert.deepEqual(await replaced.json(), { slug: 'changing', instanceLogo: { own: true, source: 'instance' } })
      assert.equal(localRecord(instancesDir, 'changing').logo, 'assets/instance-logo.jpeg')
      assert.deepEqual(readFileSync(localAsset(instancesDir, 'changing', 'instance-logo.jpeg')), jpeg)
      assert.equal(existsSync(localAsset(instancesDir, 'changing', 'instance-logo.png')), false)
      assert.equal((await (await fetch(`${base}/api/instance/logo?slug=changing`)).json()).extension, 'jpeg')

      const removed = await fetch(`${base}/api/instance/logo?slug=changing`, { method: 'DELETE' })
      assert.deepEqual(await removed.json(), { slug: 'changing', instanceLogo: { own: false, source: 'definition' } })
      assert.equal(INSTANCE_LOGO_KEY in localRecord(instancesDir, 'changing'), false)
      assert.equal(existsSync(localAsset(instancesDir, 'changing', 'instance-logo.jpeg')), false)
      assert.equal((await (await fetch(`${base}/api/instance/logo?slug=changing`)).json()).source, 'definition')
      assert.equal(localRecord(instancesDir, 'changing').definition, 'branded', 'every other field is kept')
    }))

  test('refuses a non-image and a logo for a Definition without one; such a Definition offers no Logo at all', () =>
    withServer(async ({ base, instancesDir }) => {
      const badCreate = await fetch(`${base}/api/instances`, json({ definition: 'branded', slug: 'bad', logoImageBase64: b64(NOT_AN_IMAGE) }))
      assert.equal(badCreate.status, 400)
      assert.match((await badCreate.json()).error, /must be a PNG or JPEG/)
      const plainCreate = await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-logo', logoImageBase64: b64(WIDE_LOGO) }))
      assert.equal(plainCreate.status, 400)
      assert.match((await plainCreate.json()).error, /has no logo in its reference documents/)
      assert.equal(existsSync(join(instancesDir, 'default', 'plain-logo')), false)

      await fetch(`${base}/api/instances`, json({ definition: 'branded', slug: 'branded-one' }))
      const badPut = await fetch(`${base}/api/instance/logo?slug=branded-one`, put({ imageBase64: b64(NOT_AN_IMAGE) }))
      assert.equal(badPut.status, 422)
      assert.match((await badPut.json()).error, /must be a PNG or JPEG/)
      assert.equal((await fetch(`${base}/api/instance/logo?slug=branded-one`, put({}))).status, 400)
      assert.equal(INSTANCE_LOGO_KEY in localRecord(instancesDir, 'branded-one'), false, 'a refused write writes nothing')

      await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-one' }))
      assert.equal('instanceLogo' in (await (await fetch(`${base}/api/instance?slug=plain-one`)).json()), false)
      assert.equal((await fetch(`${base}/api/instance/logo?slug=plain-one`)).status, 404)
      const plainPut = await fetch(`${base}/api/instance/logo?slug=plain-one`, put({ imageBase64: b64(WIDE_LOGO) }))
      assert.equal(plainPut.status, 400)
      assert.match((await plainPut.json()).error, /have no Logo setting/)
    }))
})

// ---------- Every Provider: saved on the stage branch ----------

const binaryOn = async (provider, client, path, branch) =>
  provider === 'azure-devops' ? Buffer.from(await client.getFileContent(path, { branch }), 'base64') : Buffer.from(await client.getFileBytes(path, { branch }))

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    // POST /api/instances doesn't create on GitLab, so the instance is seeded and registered, as
    // tests/instanceSettings.test.js does.
    name: 'GitLab',
    provider: 'gitlab',
    serverOptions: {},
    fakeServerOptions: (slug) => ({ files: { [`/gantry-workspace/${slug}/instance.yaml`]: `definition: branded\ndefinitionVersion: 1\nslug: ${slug}\nstage: draft\nassignee: ""\n` } }),
    register: (ctx, slug, instancesDir) => {
      registerInstance(slug, { kind: 'gitlab', namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, { instancesDir })
      registerWorkspace({ provider: 'gitlab', location: { namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
    },
    client: (ctx) => createGitLabClient({ namespace: ctx.namespace, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
]

for (const { name, provider, serverOptions, location, fakeServerOptions, register, client: clientFor } of PROVIDERS) {
  test(`${name}-backed: Replace and Remove write the logo and the record together on the stage branch, and GET serves it from there`, () =>
    withLibrary(({ definitionsDir }) =>
      withScratchInstances((instancesDir) =>
        withRunningServerForProvider(
          provider,
          { options: { definitionsDir, instancesDir, ...serverOptions }, fakeServerOptions: fakeServerOptions?.('remote-logo') },
          async (ctx) => {
            const auth = { Authorization: basicAuthHeader(ctx.pat) }
            const slug = 'remote-logo'
            if (register) register(ctx, slug, instancesDir)
            else {
              const created = await fetch(`${ctx.gantryBase}/api/instances`, json({ definition: 'branded', slug, ...location(ctx) }, auth))
              assert.equal(created.status, 201, await created.text())
            }
            const client = clientFor(ctx)
            const branch = stageBranchName(slug, 'draft')
            const recordOn = async (ref) => parseYAML(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`, { branch: ref }))

            const res = await fetch(`${ctx.gantryBase}/api/instance/logo?slug=${slug}`, put({ imageBase64: b64(WIDE_LOGO) }, auth))
            assert.equal(res.status, 200, await res.clone().text())
            assert.deepEqual(await res.json(), { slug, instanceLogo: { own: true, source: 'instance' } })
            assert.equal((await recordOn(branch)).logo, 'assets/instance-logo.png')
            assert.deepEqual(await binaryOn(provider, client, `gantry-workspace/${slug}/assets/instance-logo.png`, branch), WIDE_LOGO)
            assert.equal(INSTANCE_LOGO_KEY in (await recordOn('main')), false, 'main is untouched until the stage is approved')

            const served = await (await fetch(`${ctx.gantryBase}/api/instance/logo?slug=${slug}`, { headers: auth })).json()
            assert.equal(served.source, 'instance')
            assert.deepEqual(Buffer.from(served.imageBase64, 'base64'), WIDE_LOGO)
            assert.deepEqual((await (await fetch(`${ctx.gantryBase}/api/instance?slug=${slug}`, { headers: auth })).json()).instanceLogo, { own: true, source: 'instance' })

            const removed = await fetch(`${ctx.gantryBase}/api/instance/logo?slug=${slug}`, { method: 'DELETE', headers: auth })
            assert.deepEqual(await removed.json(), { slug, instanceLogo: { own: false, source: 'definition' } })
            assert.equal(INSTANCE_LOGO_KEY in (await recordOn(branch)), false)
            assert.equal(await client.fileExists(`gantry-workspace/${slug}/assets/instance-logo.png`, branch), false)

            const bad = await fetch(`${ctx.gantryBase}/api/instance/logo?slug=${slug}`, put({ imageBase64: b64(NOT_AN_IMAGE) }, auth))
            assert.equal(bad.status, 422)
          }
        )
      )
    ))
}

for (const { name, provider, serverOptions, location, client: clientFor } of PROVIDERS.filter((p) => !p.register)) {
  test(`${name}-backed: a logo chosen in the wizard is stored with the new instance, and a render's reference document carries it`, () =>
    withLibrary(({ definitionsDir }) =>
      withScratchInstances((instancesDir) =>
        withRunningServerForProvider(provider, { options: { definitionsDir, instancesDir, ...serverOptions } }, async (ctx) => {
          const auth = { Authorization: basicAuthHeader(ctx.pat) }
          const slug = 'created-logo'
          const created = await fetch(`${ctx.gantryBase}/api/instances`, json({ definition: 'branded', slug, logoImageBase64: b64(WIDE_LOGO), ...location(ctx) }, auth))
          assert.equal(created.status, 201, await created.text())
          const client = clientFor(ctx)
          assert.equal(parseYAML(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`)).logo, 'assets/instance-logo.png')
          assert.deepEqual(await binaryOn(provider, client, `gantry-workspace/${slug}/assets/instance-logo.png`, 'main'), WIDE_LOGO)

          // The WASM prepare route fetches the repo's assets and compiles, as every Provider render does.
          const prep = await fetch(`${ctx.gantryBase}/api/instance/render-wasm-prepare/brief?slug=${slug}`, { method: 'POST', headers: auth })
          assert.equal(prep.status, 200, await prep.clone().text())
          const { referenceDocBase64: prepared } = await prep.json()
          assert.deepEqual(Buffer.from((await readHeaderLogo(Buffer.from(prepared, 'base64'))).bytes), WIDE_LOGO)
        })
      )
    ))
}

test('Azure DevOps-backed: a logo for a Definition without one is refused without starting a stage branch', () =>
  withLibrary(({ definitionsDir }) =>
    withScratchInstances((instancesDir) =>
      withRunningServerForProvider('azure-devops', { options: { definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true } }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const slug = 'plain-remote'
        const created = await fetch(`${ctx.gantryBase}/api/instances`, json({ definition: 'plain', slug, ...PROVIDERS[0].location(ctx) }, auth))
        assert.equal(created.status, 201, await created.text())
        for (const init of [put({ imageBase64: b64(WIDE_LOGO) }, auth), { method: 'DELETE', headers: auth }]) {
          const res = await fetch(`${ctx.gantryBase}/api/instance/logo?slug=${slug}`, init)
          assert.equal(res.status, 400)
          assert.match((await res.json()).error, /have no Logo setting/)
        }
        assert.equal(await PROVIDERS[0].client(ctx).branchExists(stageBranchName(slug, 'draft')), false)
      })
    )
  ))

test('Azure DevOps-backed: importing a Local Workspace instance carries the Logo chosen in the wizard', () =>
  withLibrary(({ definitionsDir }) =>
    withScratchInstances((instancesDir) =>
      withRunningServerForProvider('azure-devops', { options: { definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true } }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const slug = 'imported-logo'
        const res = await fetch(
          `${ctx.gantryBase}/api/instances/import`,
          json({ definition: 'branded', slug, stage: 'draft', modules: [], assets: [], logoImageBase64: b64(WIDE_LOGO), ...PROVIDERS[0].location(ctx) }, auth)
        )
        assert.equal(res.status, 201, await res.clone().text())
        const client = PROVIDERS[0].client(ctx)
        assert.equal(parseYAML(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`)).logo, 'assets/instance-logo.png')
        assert.deepEqual(await binaryOn('azure-devops', client, `gantry-workspace/${slug}/assets/instance-logo.png`, 'main'), WIDE_LOGO)
      })
    )
  ))
