import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance, readModule, writeModules, writeModule, updateInstanceAssignee, updateInstanceSettings, updateInstanceLogo, readInstanceLogoImage, parseModuleFile, listInstanceSlugsInStorage } from '../lib/instance.js'
import { createAsset, listAssets, getAsset, readAssetFile } from '../lib/assets.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { advanceStage } from '../lib/stageAdvancement.js'
import { renderArtefact } from '../lib/render.js'
import { loadDefinition } from '../lib/definition.js'
import { StorageConflictError } from '../lib/storage.js'
import {
  openDefinition,
  listDefinitionsInStorage,
  createBlankDefinitionInStorage,
  createDraftVersionInStorage,
  cloneDefinitionInStorage,
  publishDefinitionVersionInStorage,
  archiveDefinitionInStorage,
  restoreDefinitionInStorage,
  isDefinitionArchivedInStorage,
  loadDefinitionChangelogFromStorage,
  readDefinitionTemplateFromStorage,
  writeDefinitionTemplateToStorage,
  readDefinitionReferenceDocxFromStorage,
  writeDefinitionReferenceDocxToStorage,
  readDefinitionLogoFromStorage,
  writeDefinitionLogoToStorage,
} from '../lib/definitionStorage.js'
import { createInMemoryStorage } from './helpers/inMemoryStorage.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { pngImage } from './helpers/logoImages.js'
import { docxPart } from './helpers/wordDocx.js'
import { copyTreeIntoStorage } from './helpers/copyTreeIntoStorage.js'
import { draftDesignV3Copy } from './helpers/designDraft.js'

// #265 (ADR-0070): a server workspace can be kept in a store other than the server's disk. These run
// one against an in-memory store that has only the asynchronous half of the storage seam (no
// `exists`, `readText`, `writeText`...), so any part of the app that still reached for the disk would
// fail here. The workspace "folder" is a path under a scratch directory that must never come to exist,
// and the temp directory is pointed at a second scratch directory that must be left empty: Pandoc's
// working files and the copies of a Definition are scratch, and persist nothing.

const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'open-questions']

let root
let scratchTemp
let workspaceDir
let originalTmpdir

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gantry-storage-workspace-'))
  scratchTemp = mkdtempSync(join(tmpdir(), 'gantry-storage-scratch-'))
  originalTmpdir = process.env.TMPDIR
  process.env.TMPDIR = scratchTemp
  workspaceDir = join(root, 'workspace')
})

after(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmpdir
  rmSync(root, { recursive: true, force: true })
  rmSync(scratchTemp, { recursive: true, force: true })
})

const NO_LIBRARY = () => join(root, 'no-library')

describe('a server workspace on an in-memory store', () => {
  const storage = createInMemoryStorage()
  const instancesDir = () => join(workspaceDir, 'instances')
  const workspaceDefinitionsDir = () => join(workspaceDir, 'definitions')
  let options
  let asset

  before(async () => {
    // The workspace's own copy of design v2, put in the store: the library path is a folder that does not exist, so the Definition can only come from the store.
    await copyTreeIntoStorage(storage, join('definitions', 'design', '2'), `${workspaceDefinitionsDir()}/design/2`)
    options = { storage, instancesDir: instancesDir(), workspaceDefinitionsDir: workspaceDefinitionsDir(), definitionsDir: NO_LIBRARY() }
  })

  test('creates an Instance from a Definition kept in the store', async () => {
    const created = await createInstance('design', 'my-initiative', { ...options, owner: 'c.barlow', assignee: 'c.barlow' })
    assert.equal(created.stage, 'shape')
    assert.deepEqual(created.modules, SHAPE_MODULES)

    const record = await readInstance('my-initiative', options)
    assert.equal(record.definition, 'design')
    assert.equal(record.definitionVersion, 2)
    assert.equal(record.assignee, 'c.barlow')
    assert.deepEqual(await listInstanceSlugsInStorage(storage, instancesDir()), ['my-initiative'])

    await assert.rejects(createInstance('design', 'my-initiative', options), /already exists/)
  })

  test('saves modules, reads them back, and refuses an unknown module without writing', async () => {
    const { definition, dispose } = await openDefinition('design', { ...options, version: 2 })
    try {
      const modules = {}
      for (const id of SHAPE_MODULES) modules[id] = parseModuleFile(exampleModuleText(id, { definitionVersion: 2 }), definition.modules.get(id))
      const writesBefore = storage.writes.length
      await assert.rejects(async () => writeModules(definition, 'my-initiative', { ...modules, nope: modules.background }, options), /no module "nope"/)
      assert.equal(storage.writes.length, writesBefore)

      const saved = await writeModules(definition, 'my-initiative', modules, options)
      assert.deepEqual(saved.modules, SHAPE_MODULES)
      const background = await readModule(definition, 'my-initiative', 'background', options)
      assert.equal(background.fields.problem, modules.background.fields.problem)

      const one = await writeModule(definition, 'my-initiative', 'background', { ...modules.background, owner: 'someone' }, options)
      assert.equal(one.module, 'background')
      assert.equal((await readModule(definition, 'my-initiative', 'background', options)).owner, 'someone')
      assert.throws(() => readModule(definition, 'my-initiative', 'handover-notes-missing-module', options), /no module/)
    } finally {
      await dispose()
    }
  })

  test('updates the Instance record', async () => {
    assert.equal((await updateInstanceAssignee('my-initiative', 'someone.else', options)).assignee, 'someone.else')
    assert.equal((await readInstance('my-initiative', options)).assignee, 'someone.else')
    await assert.rejects(readInstance('nobody', options), /No instance "nobody".*Available instances: my-initiative/)
  })

  test('uploads an asset, lists it with where it is used, and reads its bytes back', async () => {
    asset = await createAsset(
      'my-initiative',
      { filename: 'flow.png', buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'), name: 'Flow', source: 'https://draw.io/flow', uploadedBy: 'c.barlow' },
      options
    )
    assert.match(asset.filename, /\.png$/)

    await assert.rejects(createAsset('my-initiative', { filename: 'x.png', buffer: Buffer.from('x'), source: '' }, options), /Source location is required/)
    await assert.rejects(createAsset('my-initiative', { filename: 'x.gif', buffer: Buffer.from('x'), source: 'https://a.example' }, options), /Unsupported image file type/)

    // Two uploads at once keep both entries.
    await Promise.all(
      ['a', 'b', 'c'].map((n) => createAsset('my-initiative', { filename: `${n}.png`, buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'), source: `https://draw.io/${n}` }, options))
    )

    // Reference it from a module, so "used in" shows.
    const { definition, dispose } = await openDefinition('design', { ...options, version: 2 })
    try {
      const background = await readModule(definition, 'my-initiative', 'background', options)
      await writeModule(definition, 'my-initiative', 'background', { ...background, fields: { ...background.fields, problem: `${background.fields.problem}\n\n![Flow](asset:${asset.id})` } }, options)
      const listed = await listAssets(definition, 'my-initiative', options)
      assert.equal(listed.length, 4)
      assert.deepEqual(listed.find((a) => a.id === asset.id).usedIn, ['Background and context'])
    } finally {
      await dispose()
    }

    const { path } = await getAsset('my-initiative', asset.id, options)
    assert.ok(path.startsWith(instancesDir()))
    const file = await readAssetFile('my-initiative', asset.id, options)
    assert.deepEqual(file.bytes, Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
    await assert.rejects(getAsset('my-initiative', 'no-such-asset', options), /No asset "no-such-asset"/)
  })

  test('reports stage status and a gate check through the store', async () => {
    const status = await getStatus('my-initiative', options)
    assert.equal(status.definition, 'design')
    assert.equal(status.stage.id, 'shape')
    assert.equal(status.modules.length, SHAPE_MODULES.length)
    assert.equal(status.complete, true)

    const check = await checkGate('my-initiative', options)
    assert.equal(check.pass, true)
    assert.equal(check.gate, 'business-case')
  })

  test('a module with no saved file reads as missing', async () => {
    await createInstance('design', 'fresh', options)
    const { removed } = { removed: await storage.remove(join(instancesDir(), 'fresh', 'modules', 'dependencies.md')) }
    assert.equal(removed, true)
    const status = await getStatus('fresh', options)
    assert.equal(status.modules.find((m) => m.id === 'dependencies')?.exists ?? status.modules.find((m) => m.moduleId === 'dependencies')?.exists, false)
    assert.equal(status.complete, false)
    await assert.rejects(advanceStage('fresh', options), /has not passed/)
  })

  test('renders to a .docx in memory, with the asset embedded, persisting nothing', async () => {
    const writesBefore = storage.writes.length
    const result = await renderArtefact('my-initiative', 'soap', options)
    assert.ok(result.docxBytes.length > 1000)
    assert.equal(result.docxPath, null)
    assert.equal(result.mdPath, null)
    assert.match(result.markdown, /Source: \[https:\/\/draw\.io\/flow\]/)
    assert.ok(Buffer.from(result.docxBytes).includes('word/media/'), 'the uploaded image is in the document')
    assert.match(docxPart(result.docxBytes, 'word/document.xml'), /<w:drawing>/)
    assert.equal(storage.writes.length, writesBefore, 'a render writes nothing to the store')
    assert.ok(![...storage.files.keys()].some((path) => /\/out\//.test(path)), 'no out/ folder in the store')

    const markdownOnly = await renderArtefact('my-initiative', 'soap', { ...options, format: 'md' })
    assert.equal(markdownOnly.format, 'md')
    assert.equal(markdownOnly.docxBytes, undefined)
    assert.match(markdownOnly.markdown, /Background/)

    const dry = await renderArtefact('my-initiative', 'soap', { ...options, dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.ok(dry.referenceDocBytes.length > 1000, 'a dry run hands back the reference document, whose scratch copy is gone')
  })

  test('advances the stage', async () => {
    const advanced = await advanceStage('my-initiative', options)
    assert.equal(advanced.fromStage.id, 'shape')
    assert.equal(advanced.toStage.id, 'hld-define')
    assert.equal((await readInstance('my-initiative', options)).stage, 'hld-define')
  })

  test('writes nothing under the workspace folder or the temp directory', async () => {
    assert.equal(existsSync(workspaceDir), false, 'the workspace folder was never created on disk')
    assert.deepEqual(readdirSync(root).filter((name) => name === 'workspace'), [])
    assert.deepEqual(await readdir(scratchTemp), [], 'every scratch copy was removed')
    assert.ok([...storage.files.keys()].every((path) => path.startsWith(workspaceDir)))
  })
})

describe('an Instance logo in a store', () => {
  const storage = createInMemoryStorage()
  const options = { storage, instancesDir: 'ws/instances', definitionsDir: 'definitions' }

  test('is stored with the Instance, read back, rendered into the document and removed again', async () => {
    const logo = pngImage(400, 100)
    await createInstance('design', 'branded', { ...options, definitionVersion: 3, logo })
    const record = await readInstance('branded', options)
    assert.equal(record.logo, 'assets/instance-logo.png')
    assert.deepEqual(Buffer.from(await readInstanceLogoImage('branded', record, options)), Buffer.from(logo))
    assert.ok(storage.files.has('ws/instances/branded/assets/instance-logo.png'))

    const dry = await renderArtefact('branded', 'soap', { ...options, dryRun: true })
    assert.ok(dry.referenceDocBytes, 'the render is handed a reference document carrying the Instance logo')

    const replaced = await updateInstanceLogo('branded', pngImage(200, 200), options)
    assert.equal(replaced.logo, 'assets/instance-logo.png')
    const removed = await updateInstanceLogo('branded', null, options)
    assert.equal(removed.logo, undefined)
    assert.equal(storage.files.has('ws/instances/branded/assets/instance-logo.png'), false)
    assert.equal(await readInstanceLogoImage('branded', removed, options), null)
  })

  test('is refused, writing nothing, when the image is not a picture', async () => {
    const writesBefore = storage.writes.length
    await assert.rejects(createInstance('design', 'bad-logo', { ...options, definitionVersion: 3, logo: Buffer.from('not an image at all, just some words that are long enough') }), /PNG|JPEG|image/i)
    assert.equal(storage.writes.length, writesBefore)
  })

  test('Instance settings are written through the store', async () => {
    await updateInstanceSettings('branded', { size: 'large' }, options)
    assert.equal((await readInstance('branded', options)).size, 'large')
  })
})

describe('writes to the Instance record are conditional on what was read', () => {
  test('a write that finds instance.yaml changed since it was read fails, naming the file', async () => {
    const storage = createInMemoryStorage()
    const options = { storage, instancesDir: 'ws/instances', definitionsDir: 'definitions' }
    await createInstance('design', 'racy', { ...options, definitionVersion: 2 })

    // Another server changes the file between this one's read and write.
    const realPutText = storage.putText.bind(storage)
    let interfered = false
    storage.putText = async (path, text, opts) => {
      if (!interfered && path.endsWith('racy/instance.yaml') && opts?.ifVersion) {
        interfered = true
        await realPutText(path, `${text}\n# changed by someone else\n`)
      }
      return realPutText(path, text, opts)
    }
    await assert.rejects(updateInstanceAssignee('racy', 'me', options), (err) => err instanceof StorageConflictError && /racy\/instance\.yaml/.test(err.message))
  })
})

describe('a server workspace\'s Definitions in a store', () => {
  const storage = createInMemoryStorage()
  const dir = 'ws/definitions'

  test('are created, drafted, published, archived and listed through the store', async () => {
    assert.deepEqual(await listDefinitionsInStorage(storage, dir), [])

    await createBlankDefinitionInStorage(storage, dir, 'my-process', { title: 'My process' })
    assert.ok(storage.files.has(`${dir}/my-process/1/definition.yaml`))
    let rows = await listDefinitionsInStorage(storage, dir)
    assert.deepEqual(rows.map((r) => r.id), ['my-process'])
    assert.equal(rows[0].title, 'My process')
    assert.equal(rows[0].latestPublished, null)

    assert.match(await loadDefinitionChangelogFromStorage(storage, dir, 'my-process', 1), /Draft/)

    await publishDefinitionVersionInStorage(storage, dir, 'my-process', 1)
    rows = await listDefinitionsInStorage(storage, dir)
    assert.equal(rows[0].latestPublished, 1)

    await createDraftVersionInStorage(storage, dir, 'my-process')
    assert.ok(storage.files.has(`${dir}/my-process/2/definition.yaml`))

    await cloneDefinitionInStorage(storage, dir, 'my-process', 'my-copy')
    assert.ok(storage.files.has(`${dir}/my-copy/1/definition.yaml`))

    await archiveDefinitionInStorage(storage, dir, 'my-process')
    assert.equal(await isDefinitionArchivedInStorage(storage, dir, 'my-process'), true)
    assert.deepEqual((await listDefinitionsInStorage(storage, dir)).map((r) => r.id), ['my-copy'])
    assert.deepEqual((await listDefinitionsInStorage(storage, dir, { includeArchived: true })).map((r) => r.id), ['my-copy', 'my-process'])
    await restoreDefinitionInStorage(storage, dir, 'my-process')
    assert.equal(await isDefinitionArchivedInStorage(storage, dir, 'my-process'), false)
    assert.equal(storage.files.has(`${dir}/my-process/.archived`), false, 'restoring deletes the marker from the store')
  })

  test('keep their templates, reference documents and logo in the store', async () => {
    // design v3 is published (#308); the store's copy is a draft, since a logo and reference documents are only written to a draft.
    const draftV3 = draftDesignV3Copy()
    try {
      await copyTreeIntoStorage(storage, draftV3, `${dir}/design/3`)
    } finally {
      rmSync(draftV3, { recursive: true, force: true })
    }

    await writeDefinitionTemplateToStorage(storage, dir, 'design', 3, 'extra.md.tmpl', '# Extra\n')
    assert.equal(await readDefinitionTemplateFromStorage(storage, dir, 'design', 3, 'extra.md.tmpl'), '# Extra\n')
    assert.ok(storage.files.has(`${dir}/design/3/templates/extra.md.tmpl`))

    const reference = await readDefinitionReferenceDocxFromStorage(storage, dir, 'design', 3, 'soap')
    assert.ok(reference.length > 1000)
    await writeDefinitionReferenceDocxToStorage(storage, dir, 'design', 3, 'soap', reference)

    const { logo } = await readDefinitionLogoFromStorage(storage, dir, 'design', 3)
    assert.ok(logo?.bytes?.length > 0, 'design v3 ships a header logo')

    // A logo is replaced in a draft version.
    await createDraftVersionInStorage(storage, dir, 'design')
    assert.ok(storage.files.has(`${dir}/design/4/definition.yaml`))
    const newLogo = pngImage(300, 100)
    const written = await writeDefinitionLogoToStorage(storage, dir, 'design', 4, newLogo)
    assert.ok(written.updated.length > 0)
    assert.deepEqual(Buffer.from((await readDefinitionLogoFromStorage(storage, dir, 'design', 4)).logo.bytes), Buffer.from(newLogo))
    assert.deepEqual(Buffer.from((await readDefinitionLogoFromStorage(storage, dir, 'design', 3)).logo.bytes), Buffer.from(logo.bytes), 'the published version is untouched')
  })

  test('a write that fails changes nothing in the store', async () => {
    const before = new Map(storage.files)
    await assert.rejects(createBlankDefinitionInStorage(storage, dir, 'my-copy'), /already exists/)
    await assert.rejects(publishDefinitionVersionInStorage(storage, dir, 'my-copy', 99))
    assert.deepEqual([...storage.files.keys()].sort(), [...before.keys()].sort())
  })

  test('load the same as the disk copy they were taken from', async () => {
    const { definition, dispose } = await openDefinition('design', { storage, workspaceDefinitionsDir: dir, definitionsDir: NO_LIBRARY(), version: 3 })
    try {
      const fromDisk = loadDefinition('design', { version: 3 })
      assert.deepEqual(definition.stages, fromDisk.stages)
      assert.deepEqual(definition.artefacts, fromDisk.artefacts)
      assert.deepEqual([...definition.modules.keys()], [...fromDisk.modules.keys()])
    } finally {
      await dispose()
    }
  })

  test('fall back to the library when the workspace has none of that id', async () => {
    const { definition, dispose } = await openDefinition('design', { storage, workspaceDefinitionsDir: 'ws/empty-definitions', definitionsDir: 'definitions', version: 2 })
    try {
      assert.equal(definition.id, 'design')
      assert.ok(definition.definitionDir.startsWith('definitions'))
    } finally {
      await dispose()
    }
  })
})

test('the disk implementation behaves the same through the same functions', async () => {
  const { createLocalFilesystemStorage } = await import('../lib/storage.js')
  const disk = createLocalFilesystemStorage()
  const dir = join(root, 'disk-workspace')
  const options = { storage: disk, instancesDir: join(dir, 'instances'), definitionsDir: 'definitions' }
  await createInstance('design', 'on-disk', { ...options, definitionVersion: 2 })
  assert.ok(existsSync(join(dir, 'instances', 'on-disk', 'instance.yaml')))
  const asset = await createAsset('on-disk', { filename: 'p.png', buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'), source: 'https://draw.io/p' }, options)
  assert.ok(existsSync(join(dir, 'instances', 'on-disk', 'assets', asset.filename)))
  const status = await getStatus('on-disk', options)
  assert.equal(status.stage.id, 'shape')
  // The disk copy reads back identically through the synchronous path every disk caller still uses.
  assert.equal(readInstance('on-disk', { instancesDir: join(dir, 'instances') }).stage, 'shape')
  assert.equal(readFileSync(join(dir, 'instances', 'on-disk', 'instance.yaml'), 'utf8').includes('definitionVersion: 2'), true)
})
