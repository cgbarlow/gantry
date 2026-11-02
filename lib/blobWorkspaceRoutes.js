import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  readInstance,
  readModule,
  writeModules,
  writeModule,
  createInstance,
  updateInstanceAssignee,
  updateInstanceSettings,
  updateInstanceLogo,
  readInstanceLogoImage,
  instanceDefinitionVersion,
} from './instance.js'
import { getStatus, evaluateStage } from './status.js'
import { checkGate } from './check.js'
import { advanceStage } from './stageAdvancement.js'
import { renderArtefact } from './render.js'
import { createAsset, listAssets, readAssetFile } from './assets.js'
import { openDefinition, listDefinitionsInStorage } from './definitionStorage.js'
import { withLease } from './blobStorage.js'
import { getTextVersionedOrNull } from './storageFiles.js'
import { StorageConflictError, StorageLeaseHeldError, StorageLeaseLostError } from './storage.js'
import { describeProbeFailure } from './blobContainers.js'
import { BlobContainerUnavailableError, isBlobWorkspaceId } from './blobWorkspaces.js'
import { DuplicateServerWorkspaceError, InvalidServerWorkspaceError } from './workspaceDirectory.js'
import { isValidSlug } from './slug.js'
import { resolveInstanceWorkspaceId } from './instanceRegistry.js'
import { instanceLogoStatus, instanceLogoNotOfferedMessage } from '../web/lib/instanceLogo.js'
import { logoImageInfo, logoImageProblem } from '../web/lib/definitionLogo.js'
import { definitionHeaderLogo, definitionOffersInstanceLogo } from './instanceLogo.js'
import { chosenInstanceSettings, instanceSettingProblem, instanceSettingsProblem } from '../web/lib/instanceSettings.js'
import { stagePayloads, stageVersionOfPayloads } from '../web/lib/stageVersion.js'

/**
 * The HTTP side of a server workspace kept in a Blob container (#269, docs/adr/0070). `lib/blobWorkspaces.js` finds the
 * workspaces and numbers them; this answers the same routes `lib/server.js` answers for a workspace on the server's
 * disk (read an Instance, Save a stage, advance, render, assets, the Instance's logo and settings), reading and writing
 * the container through the asynchronous storage seam and never the server's own folder.
 *
 * `lib/server.js` hands it a request first. It answers only a request that names a workspace kept in a container; for
 * anything else it returns `false` and the disk and Provider routes carry on exactly as before.
 *
 * A Save holds a short lease on the Instance for its whole duration and every file it writes is conditional on the ETag
 * it read, so a second saver (on this server or another sharing the container) waits its turn or is refused rather than
 * leaving a stage half-written. ADR-0068's stage version is a fingerprint of the stage's content, the same here as on disk.
 */

const SAVE_LEASE_MS = 30_000
// How long a read of the containers may be reused by the requests that follow it. Listings (the dashboard, the wizard)
// always read fresh; this only spares the per-Instance routes a round trip each.
const REFRESH_MS = 3000

const sendRefusal = (sendJSON, res, ws, code = 'workspace_unavailable') =>
  sendJSON(res, 503, { error: `Workspace "${ws.name}" is unavailable: ${ws.reason ?? 'its Blob container could not be reached'}`, code, reason: ws.reason ?? null })

/** The fields of a workspace as the API lists it (`GET /api/server-workspaces`): never a credential, never a client. */
function workspaceView(ws) {
  return {
    id: ws.id,
    name: ws.name,
    description: ws.description,
    storage: 'blob',
    container: ws.container,
    number: ws.number,
    available: ws.available,
    ...(ws.available ? {} : { reason: ws.reason }),
  }
}

export function createBlobWorkspaceRoutes({ blobs, instancesDir, definitionsDir, defaultSlug, helpers, refreshMs = REFRESH_MS }) {
  const {
    sendJSON,
    readBody,
    readBodyWithLimit,
    maxLogoBodyBytes,
    resolveSlugParam,
    resolveStageIdParam,
    resolveLocalDataDir,
    buildModuleEntry,
    buildInstanceResponse,
    stageClash,
    overwriteNotes,
    moduleWriteRefusal,
    targetWordNotesFor,
    buildReviewSummaryForArtefact,
    listLibraryDefinitions,
    mimeTypes,
  } = helpers

  const store = (ws) => ({
    storage: blobs.storage(ws.container),
    instancesDir: ws.folder,
    workspaceDefinitionsDir: `${ws.folder}/definitions`,
    definitionsDir,
  })
  const instanceKey = (ws, slug) => `${ws.folder}/${slug}`
  const modulePathOf = (ws, slug, moduleId) => `${ws.folder}/${slug}/modules/${moduleId}.md`

  async function withInstanceDefinition(ws, instance, fn, { templates = false } = {}) {
    const { definition, dispose } = await openDefinition(instance.definition, { ...store(ws), version: instanceDefinitionVersion(instance), templates })
    try {
      return await fn(definition)
    } finally {
      await dispose()
    }
  }

  // The Instance's short numbers come from the container; the record handed to the response builders carries the same
  // number, so a number written into instance.yaml (or copied in with the folder) never overrides the container's.
  const numbersFor = (ws, slug) => ({ workspaceNumber: ws.number, instanceNumber: ws.instanceNumbers[slug] })

  async function readModulesOfStage(ws, definition, stage, slug) {
    const source = store(ws)
    return Promise.all(
      stage.modules.map(async (moduleId) => {
        let data = { status: 'draft', owner: '', fields: {} }
        try {
          data = await readModule(definition, slug, moduleId, source)
        } catch (err) {
          if (!/has no saved data/.test(err.message)) throw err
        }
        return data
      })
    )
  }

  async function exampleDataFor(definition, stage, moduleId) {
    if (!stage.example) return null
    const exampleInstancesDir = resolveLocalDataDir(stage.example, instancesDir)
    if (!existsSync(join(exampleInstancesDir, stage.example, 'modules', `${moduleId}.md`))) return null
    return readModule(definition, stage.example, moduleId, { instancesDir: exampleInstancesDir })
  }

  // ---------- listings ----------

  /** The workspaces for `GET /api/server-workspaces?include=blob`. Read fresh. */
  async function listWorkspaces() {
    const { workspaces } = await blobs.refresh()
    return workspaces.map(workspaceView)
  }

  /** One dashboard row for an Instance, as `GET /api/instances` lists a disk workspace's. */
  async function buildRow(ws, slug) {
    const source = store(ws)
    const instance = await readInstance(slug, source)
    return withInstanceDefinition(ws, instance, async (definition) => {
      const stage = definition.stages.find((s) => s.id === instance.stage)
      if (!stage) throw new Error(`Instance "${slug}" has no stage "${instance.stage}"`)
      const { complete } = await evaluateStage(definition, stage, slug, source)
      return {
        slug,
        definition: instance.definition,
        stage: instance.stage,
        status: complete ? 'complete' : 'incomplete',
        assignee: instance.assignee ?? '',
        name: instance.name ?? null,
        stageNumber: definition.stages.indexOf(stage) + 1,
        stageCount: definition.stages.length,
        stageTitle: stage.title,
        pullRequestId: null,
        pullRequestStatus: null,
        updatedAt: ws.updatedAt?.[slug] ?? new Date(0).toISOString(),
        ...(instance.workItem ? { workItem: instance.workItem } : {}),
        ...numbersFor(ws, slug),
        ref: `w${ws.number}i${ws.instanceNumbers[slug]}`,
        workspace: {
          kind: 'directory',
          id: ws.id,
          name: ws.name,
          ...(ws.description ? { description: ws.description } : {}),
          storage: 'blob',
          container: ws.container,
        },
      }
    })
  }

  /** The dashboard rows of every Instance in every available workspace; one that cannot be read is left out, not fatal. */
  async function listRows() {
    const { workspaces } = await blobs.refresh()
    const wanted = workspaces.filter((ws) => ws.available && !ws.placeholder).flatMap((ws) => ws.slugs.map((slug) => ({ ws, slug })))
    const rows = await Promise.all(
      wanted.map(({ ws, slug }) =>
        buildRow(ws, slug).catch((err) => {
          console.error(`lib/blobWorkspaceRoutes.js: omitting instance "${slug}" of "${ws.name}" from GET /api/instances — ${err.message}`)
          return null
        })
      )
    )
    return rows.filter(Boolean)
  }

  // ---------- creating ----------

  /** `POST /api/server-workspaces` with `storage: "blob"`. */
  async function createWorkspace(res, body) {
    if (!blobs.enabled) {
      return sendJSON(res, 400, { error: 'Storage "blob" needs a Blob container, and this server has none declared (GANTRY_BLOB_CONTAINERS).' })
    }
    try {
      const ws = await blobs.create({ container: body?.container, name: body?.name, description: body?.description })
      sendJSON(res, 201, { ...workspaceView(ws), description: ws.description })
    } catch (err) {
      if (err instanceof InvalidServerWorkspaceError) return sendJSON(res, 400, { error: err.message })
      if (err instanceof DuplicateServerWorkspaceError) return sendJSON(res, 409, { error: err.message })
      if (err instanceof BlobContainerUnavailableError) return sendJSON(res, 503, { error: err.message, code: 'workspace_unavailable', reason: err.reason ?? null })
      if (isStoreFailure(err)) return sendJSON(res, 503, { error: `The Blob container "${body?.container}" is unavailable: ${describeProbeFailure(err)}`, code: 'workspace_unavailable', reason: describeProbeFailure(err) })
      throw err
    }
  }

  /** Whether `id` names a workspace in a container (the cheap shape test; whether it exists is `createInstance`'s to answer). */
  const isBlobWorkspace = (id) => isBlobWorkspaceId(id)

  async function workspaceById(id) {
    await blobs.refresh({ maxAgeMs: refreshMs })
    let ws = blobs.get(id)
    if (!ws) {
      await blobs.refresh()
      ws = blobs.get(id)
    }
    return ws
  }

  /** `POST /api/instances` with `serverWorkspace` naming a workspace in a container. `body` is the parsed request. */
  async function createInstanceInWorkspace(res, body) {
    const ws = await workspaceById(body.serverWorkspace)
    if (!ws || ws.placeholder) return sendJSON(res, 404, { error: `Unknown server workspace "${body.serverWorkspace}"` })
    if (!ws.available) return sendRefusal(sendJSON, res, ws)
    const { definition: definitionId, slug, owner, assignee, definitionVersion: rawDefinitionVersion, version: rawVersion } = body
    if (!isValidSlug(slug)) return sendJSON(res, 400, { error: `Invalid instance slug "${slug}"` })
    const settings = chosenInstanceSettings(body)
    const logo = typeof body?.logoImageBase64 === 'string' && body.logoImageBase64 ? Buffer.from(body.logoImageBase64, 'base64') : undefined
    let requested = rawDefinitionVersion ?? rawVersion ?? null
    if (requested === 'latest') requested = null

    const source = store(ws)
    const workspaceRows = (await listDefinitionsInStorage(source.storage, source.workspaceDefinitionsDir)).map((row) => ({ ...row, own: true }))
    const rows = [...listLibraryDefinitions(), ...workspaceRows]
    const row = rows.find((d) => d.id === definitionId)
    if (!row) return sendJSON(res, 400, { error: `Unknown definition "${definitionId}"` })

    let definitionVersion
    if (requested !== null && requested !== undefined && requested !== '') {
      const parsed = Number(requested)
      if (!Number.isInteger(parsed) || parsed < 1) return sendJSON(res, 400, { error: `Invalid definitionVersion "${requested}"` })
      if (!row.versions.some((v) => v.version === parsed)) return sendJSON(res, 400, { error: `Definition "${definitionId}" has no version ${parsed}` })
      definitionVersion = parsed
    } else {
      definitionVersion = row.latestPublished ?? row.versions[row.versions.length - 1]?.version ?? 1
    }

    if (ws.slugs.includes(slug)) return sendJSON(res, 409, { error: `Instance "${slug}" already exists` })
    try {
      const number = await blobs.numberForNewInstance(ws, slug)
      await createInstance(definitionId, slug, { ...source, owner, assignee, ...settings, logo, definitionVersion, number })
    } catch (err) {
      if (isStoreFailure(err)) return sendUnavailable(res, ws, err)
      return sendJSON(res, /already exists/.test(err.message) ? 409 : 400, { error: err.message })
    }
    const fresh = (await blobs.refresh({ afterWrite: true })).workspaces.find((w) => w.id === ws.id)
    sendJSON(res, 201, await buildRow(fresh, slug))
  }

  // ---------- failures ----------

  // A failure of the store itself (not a mistake in the request): the container could not be reached, or refused us.
  function isStoreFailure(err) {
    return typeof err?.statusCode === 'number' || /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)$/.test(err?.code ?? '') || err?.name === 'AbortError' || err?.name === 'TimeoutError'
  }

  function sendUnavailable(res, ws, err) {
    const reason = describeProbeFailure(err)
    sendJSON(res, 503, { error: `Workspace "${ws.name}" is unavailable: ${reason}`, code: 'workspace_unavailable', reason })
  }

  // ---------- one Instance ----------

  async function getInstance(req, res, url, ws, slug, scopeId) {
    const source = store(ws)
    const instance = { ...(await readInstance(slug, source)), number: ws.instanceNumbers[slug] }
    return withInstanceDefinition(ws, instance, async (definition) => {
      const stageId = resolveStageIdParam(url, definition, instance.stage)
      const stage = definition.stages.find((s) => s.id === stageId)
      if (!stage) throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
      const datas = await readModulesOfStage(ws, definition, stage, slug)
      const modules = await Promise.all(stage.modules.map(async (moduleId, i) => buildModuleEntry(definition, stage, moduleId, datas[i], await exampleDataFor(definition, stage, moduleId))))
      sendJSON(res, 200, {
        ...buildInstanceResponse(slug, definitionsDir, definition, stage, instance, modules, false, null, null, instancesDir, scopeId, numbersFor(ws, slug)),
        archived: false,
        storage: 'blob',
        stageSync: { behind: false, behindFiles: [], ahead: false },
        changedSinceApproval: [],
        reapprovals: [],
        alsoReapproving: [],
        shared: false,
      })
    })
  }

  const readStage = async (ws, definition, stage, slug) => {
    const datas = await readModulesOfStage(ws, definition, stage, slug)
    return stage.modules.map((moduleId, i) => buildModuleEntry(definition, stage, moduleId, datas[i], null))
  }

  // The ETag of each Module file about to be written (null when there is none yet), read before the Save's write so the write is conditional on it.
  async function versionsOf(ws, slug, moduleIds) {
    const source = store(ws)
    const found = await Promise.all(moduleIds.map((id) => getTextVersionedOrNull(source.storage, modulePathOf(ws, slug, id))))
    return Object.fromEntries(moduleIds.map((id, i) => [id, found[i] ? found[i].version : null]))
  }

  async function saveModules(req, res, url, ws, slug) {
    const body = JSON.parse(await readBody(req))
    const modules = body?.modules && typeof body.modules === 'object' ? body.modules : {}
    const moduleIds = Object.keys(modules)
    const baseVersion = typeof body?.baseVersion === 'string' ? body.baseVersion : undefined
    const source = store(ws)

    return withLease(source.storage, instanceKey(ws, slug), async () => {
      const instance = await readInstance(slug, source)
      return withInstanceDefinition(ws, instance, async (definition) => {
        if (moduleIds.length === 0) return sendJSON(res, 400, { error: 'Nothing to save — "modules" is empty.' })
        const unknown = moduleIds.filter((id) => !definition.modules.has(id))
        if (unknown.length) return sendJSON(res, 400, { error: `Definition "${definition.id}" has no module(s): ${unknown.join(', ')}` })
        const stageId = url.searchParams.get('stage') ?? instance.stage
        const stage = definition.stages.find((s) => s.id === stageId)
        if (!stage) return sendJSON(res, 400, { error: `Definition "${definition.id}" has no stage "${stageId}"` })
        const refusal = moduleWriteRefusal(definition, stage, moduleIds)
        if (refusal) return sendJSON(res, 400, { error: refusal })

        // ADR-0068: the stage as it is saved now against the version the saver read. The lease means no other Gantry Save can change it from here to the write.
        let before = null
        try {
          before = await readStage(ws, definition, stage, slug)
        } catch (err) {
          if (baseVersion !== undefined || isStoreFailure(err)) throw err
        }
        const clash = before && stageClash(baseVersion, before, modules)
        if (clash) return sendJSON(res, 409, clash)

        const ifVersions = await versionsOf(ws, slug, moduleIds)
        const saved = await writeModules(definition, slug, modules, { ...source, ifVersions })
        sendJSON(res, 200, {
          ...(await getStatus(slug, { ...source, stageId })),
          saved: saved.modules,
          stageVersion: stageVersionOfPayloads(stagePayloads(await readStage(ws, definition, stage, slug))),
          ...overwriteNotes(baseVersion, before, modules),
          ...targetWordNotesFor(definition, modules, instance),
        })
      })
    }, { ttlMs: SAVE_LEASE_MS })
  }

  async function saveModule(req, res, url, ws, slug, moduleId) {
    const source = store(ws)
    const body = JSON.parse(await readBody(req))
    return withLease(source.storage, instanceKey(ws, slug), async () => {
      const instance = await readInstance(slug, source)
      return withInstanceDefinition(ws, instance, async (definition) => {
        const stageId = url.searchParams.get('stage') ?? instance.stage
        const stage = definition.stages.find((s) => s.id === stageId)
        if (!stage) return sendJSON(res, 400, { error: `Definition "${definition.id}" has no stage "${stageId}"` })
        const refusal = moduleWriteRefusal(definition, stage, [moduleId])
        if (refusal) return sendJSON(res, 400, { error: refusal })
        const ifVersions = await versionsOf(ws, slug, [moduleId])
        await writeModule(definition, slug, moduleId, body, { ...source, ifVersions })
        sendJSON(res, 200, await getStatus(slug, { ...source, stageId }))
      })
    }, { ttlMs: SAVE_LEASE_MS })
  }

  async function render(req, res, url, ws, slug, artefactId) {
    const source = store(ws)
    const instance = await readInstance(slug, source)
    const format = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
    const reviewSummary = await withInstanceDefinition(ws, instance, async (definition) => {
      const spec = definition.artefacts.find((a) => a.id === artefactId)
      return spec ? buildReviewSummaryForArtefact(definition, spec, instance, null) : undefined
    })
    // Delivered to the browser as a download, never written into the container.
    const result = await renderArtefact(slug, artefactId, { ...source, reviewSummary, format, deliverToClient: true })
    sendJSON(res, 200, {
      artefact: artefactId,
      format,
      basename: result.basename,
      markdown: format === 'md' ? result.markdown : null,
      docxBase64: format === 'docx' ? Buffer.from(result.docxBytes).toString('base64') : null,
    })
  }

  async function listInstanceAssets(res, ws, slug) {
    const source = store(ws)
    const instance = await readInstance(slug, source)
    sendJSON(res, 200, await withInstanceDefinition(ws, instance, (definition) => listAssets(definition, slug, source)))
  }

  async function uploadAsset(req, res, ws, slug) {
    const body = JSON.parse(await readBody(req))
    try {
      const asset = await createAsset(
        slug,
        { filename: body.filename, buffer: Buffer.from(body.dataBase64 ?? '', 'base64'), name: body.name, source: body.source, uploadedBy: body.uploadedBy },
        store(ws)
      )
      sendJSON(res, 201, asset)
    } catch (err) {
      if (isStoreFailure(err)) throw err
      sendJSON(res, 400, { error: err.message })
    }
  }

  async function serveAsset(res, ws, slug, assetId) {
    try {
      const { asset, bytes } = await readAssetFile(slug, assetId, store(ws))
      if (!bytes) return sendJSON(res, 404, { error: 'Asset file missing' })
      res.writeHead(200, { 'Content-Type': mimeTypes[extname(asset.filename)] ?? 'application/octet-stream' })
      res.end(bytes)
    } catch (err) {
      if (isStoreFailure(err)) throw err
      sendJSON(res, 404, { error: err.message })
    }
  }

  async function logo(req, res, ws, slug) {
    const source = store(ws)
    let image = null
    if (req.method === 'PUT') {
      let body
      try {
        const raw = await readBodyWithLimit(req, maxLogoBodyBytes)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null
      } catch (err) {
        return sendJSON(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? `Request body exceeds the ${maxLogoBodyBytes}-byte limit` : 'Invalid JSON body' })
      }
      if (typeof body?.imageBase64 !== 'string') return sendJSON(res, 400, { error: 'Body must include imageBase64' })
      image = new Uint8Array(Buffer.from(body.imageBase64, 'base64'))
      const problem = logoImageProblem(image)
      if (problem) return sendJSON(res, 422, { error: problem })
    }
    const current = await readInstance(slug, source)
    return withInstanceDefinition(ws, current, async (definition) => {
      if (!definitionOffersInstanceLogo(definition)) {
        return sendJSON(res, req.method === 'GET' ? 404 : 400, { error: instanceLogoNotOfferedMessage(definition) })
      }
      if (req.method === 'GET') {
        const own = await readInstanceLogoImage(slug, current, source)
        const ownInfo = own && logoImageInfo(own)
        const chosen = ownInfo ? { source: 'instance', bytes: own, ...ownInfo } : { source: 'definition', ...definitionHeaderLogo(definition) }
        return sendJSON(res, 200, { source: chosen.source, contentType: chosen.contentType, extension: chosen.extension, imageBase64: Buffer.from(chosen.bytes).toString('base64') })
      }
      const next = await withLease(source.storage, instanceKey(ws, slug), () => updateInstanceLogo(slug, image, source), { ttlMs: SAVE_LEASE_MS })
      sendJSON(res, 200, { slug, instanceLogo: instanceLogoStatus(next) })
    })
  }

  async function setAssignee(req, res, ws, slug) {
    const body = JSON.parse(await readBody(req))
    const assignee = typeof body?.assignee === 'string' ? body.assignee : ''
    const source = store(ws)
    const instance = await withLease(source.storage, instanceKey(ws, slug), () => updateInstanceAssignee(slug, assignee, source), { ttlMs: SAVE_LEASE_MS })
    sendJSON(res, 200, { slug, assignee: instance.assignee })
  }

  async function setSettings(req, res, url, ws, slug) {
    const which = url.pathname === '/api/instance/size' ? 'size' : 'settings'
    const body = JSON.parse((await readBody(req)) || '{}')
    const settings = which === 'size' ? { size: body?.size } : body?.settings
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length === 0) {
      return sendJSON(res, 400, { error: 'settings must be an object naming at least one Instance setting, e.g. { "settings": { "size": "large" } }' })
    }
    const source = store(ws)
    const current = await readInstance(slug, source)
    return withInstanceDefinition(ws, current, async (definition) => {
      const problem = which === 'size' ? instanceSettingProblem(definition, 'size', settings.size) : instanceSettingsProblem(definition, settings)
      if (problem) return sendJSON(res, 400, { error: problem })
      const next = await withLease(source.storage, instanceKey(ws, slug), () => updateInstanceSettings(slug, settings, source), { ttlMs: SAVE_LEASE_MS })
      sendJSON(res, 200, which === 'size' ? { slug, size: next.size } : { slug, settings: chosenInstanceSettings(next) })
    })
  }

  async function advance(res, ws, slug) {
    const source = store(ws)
    try {
      const result = await withLease(source.storage, instanceKey(ws, slug), () => advanceStage(slug, source), { ttlMs: SAVE_LEASE_MS })
      sendJSON(res, 200, result)
    } catch (err) {
      if (isStoreFailure(err) || err instanceof StorageLeaseHeldError || err instanceof StorageConflictError || err instanceof StorageLeaseLostError) throw err
      sendJSON(res, 400, { error: err.message })
    }
  }

  // ---------- dispatch ----------

  async function dispatch(req, res, url, ws, slug, scopeId) {
    const p = url.pathname
    const m = req.method
    const source = store(ws)
    if (p === '/api/instance/workspace' && m === 'GET') return sendJSON(res, 200, { workspaceId: ws.id, scope: ws.id })
    if (p === '/api/instance' && m === 'GET') return getInstance(req, res, url, ws, slug, scopeId)
    if (p === '/api/instance/check' && m === 'GET') return sendJSON(res, 200, await checkGate(slug, { ...source, gate: url.searchParams.get('gate') ?? undefined }))
    if (p === '/api/instance/advance-stage' && m === 'POST') return advance(res, ws, slug)
    if (p === '/api/instance/modules' && m === 'PUT') return saveModules(req, res, url, ws, slug)
    const moduleMatch = p.match(/^\/api\/instance\/modules\/([^/]+)$/)
    if (moduleMatch && m === 'PUT') return saveModule(req, res, url, ws, slug, moduleMatch[1])
    const renderMatch = p.match(/^\/api\/instance\/render\/([^/]+)$/)
    if (renderMatch && m === 'POST') return render(req, res, url, ws, slug, renderMatch[1])
    if (p === '/api/instance/assets' && m === 'GET') return listInstanceAssets(res, ws, slug)
    if (p === '/api/instance/assets' && m === 'POST') return uploadAsset(req, res, ws, slug)
    const assetMatch = p.match(/^\/api\/instance\/assets\/([^/]+)\/file$/)
    if (assetMatch && m === 'GET') return serveAsset(res, ws, slug, assetMatch[1])
    if (p === '/api/instance/logo' && ['GET', 'PUT', 'DELETE'].includes(m)) return logo(req, res, ws, slug)
    if (p === '/api/instance/assignee' && m === 'PUT') return setAssignee(req, res, ws, slug)
    if ((p === '/api/instance/settings' || p === '/api/instance/size') && m === 'PUT') return setSettings(req, res, url, ws, slug)
    return sendJSON(res, 400, {
      error: `"${ws.name}" is a server workspace kept in a Blob container: it has no branches, Pull Requests, reviews or work items, so ${p} does not apply to it.`,
    })
  }

  // The web client asks which workspace a bare slug belongs to before it sends any other request, and sends the
  // answer back as `?scope=`. A slug no disk or Provider workspace knows, and exactly one workspace in a container
  // does, belongs to that one; a slug in several is as ambiguous here as it is across disk workspaces.
  function scopeOfBareSlug(slug) {
    try {
      if (resolveInstanceWorkspaceId(slug, { instancesDir }) !== null) return undefined
    } catch {
      return undefined
    }
    const holders = blobs.current().workspaces.filter((w) => w.available && w.slugs.includes(slug))
    return holders.length === 1 ? holders[0].id : undefined
  }

  /**
   * Answers a request that names an Instance in a workspace kept in a Blob container; resolves `true` when it did,
   * `false` when the request is for anything else (and nothing has been read or written for it).
   */
  async function handle(req, res, url) {
    if (!blobs.enabled || !/^\/api\/instance(\/|$)/.test(url.pathname)) return false
    await blobs.refresh({ maxAgeMs: refreshMs })
    const resolved = resolveSlugParam(url, defaultSlug, instancesDir)
    if (resolved.error) return false
    const { slug } = resolved
    const scopeId = resolved.scopeId ?? scopeOfBareSlug(slug)
    if (!isBlobWorkspace(scopeId)) return false
    let ws = await workspaceById(scopeId)
    if (!ws || ws.placeholder) return false
    if (!ws.available) {
      sendRefusal(sendJSON, res, ws)
      return true
    }
    if (!ws.slugs.includes(slug)) {
      // Another server may have made it since the last read.
      ws = (await blobs.refresh()).workspaces.find((w) => w.id === scopeId) ?? ws
    }
    if (!ws.available) {
      sendRefusal(sendJSON, res, ws)
      return true
    }
    if (!ws.slugs.includes(slug)) {
      sendJSON(res, 404, { error: `No instance "${slug}" in workspace "${ws.name}"`, code: 'instance_not_found' })
      return true
    }
    try {
      await dispatch(req, res, url, ws, slug, scopeId)
    } catch (err) {
      if (err instanceof StorageLeaseHeldError) sendJSON(res, 409, { error: 'Another save of this Instance is still in progress — try again in a moment.', code: 'save_in_progress' })
      else if (err instanceof StorageLeaseLostError) sendJSON(res, 409, { error: 'This save took too long and its lock expired — nothing further was written. Try again.', code: 'save_in_progress' })
      else if (err instanceof StorageConflictError) sendJSON(res, 409, { error: `${err.message}. Someone changed it while you were saving — reload and try again.`, code: 'stage_changed' })
      else if (isStoreFailure(err)) sendUnavailable(res, ws, err)
      else throw err
    }
    return true
  }

  return { handle, listWorkspaces, listRows, createWorkspace, createInstanceInWorkspace, isBlobWorkspace }
}
