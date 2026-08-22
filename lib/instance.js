import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { loadDefinition } from './definition.js'
import { localFilesystemStorage as storage } from './storage.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError } from './azureDevOpsClient.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// Strips inline markdown formatting from a heading so it can be matched
// against a field's plain-text title (e.g. "## **Business driver**").
function normalizeHeadingText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim()
}

function instanceDir(instancesDir, slug) {
  return join(instancesDir, slug)
}

function modulePath(instancesDir, slug, moduleId) {
  return join(instanceDir(instancesDir, slug), 'modules', `${moduleId}.md`)
}

// Repo-relative paths for an Azure-DevOps-backed instance. Unlike the
// local-filesystem layout, there's no instancesDir/slug prefix to join —
// per docs/adr/0005-instance-data-in-external-ado-repo.md, the whole
// Azure DevOps repo *is* that one instance's data.
const AZURE_DEVOPS_INSTANCE_PATH = 'instance.yaml'

function azureDevOpsModulePath(moduleId) {
  return `modules/${moduleId}.md`
}

/**
 * Builds an Azure DevOps client from the caller-supplied
 * `options.azureDevOps` (`{ organization, project, repository, pat, baseUrl? }`)
 * — the credential/location "accepted as a plain parameter at this layer"
 * that #82's spec calls for (wiring it from a real HTTP request, or from a
 * lookup keyed on `slug`, is later work). Its *presence* on `options` —
 * never anything read off a fetched `instance.yaml` — is what routes a
 * call through Azure DevOps instead of the local filesystem: for a real
 * Azure-DevOps-backed instance, `instance.yaml` itself lives only in that
 * repo, so there is nothing to read locally first that could tell us where
 * to look.
 */
function azureDevOpsClientFor(options) {
  const { organization, project, repository, pat, baseUrl } = options.azureDevOps
  return createAzureDevOpsClient({ organization, project, repository, pat, baseUrl })
}

function renderModuleFile(moduleSpec, { status = 'draft', owner = '' } = {}) {
  const frontmatter = stringifyYAML({ module: moduleSpec.id, status, owner }).trimEnd()
  const sections = moduleSpec.fields
    .map((field) => `## ${field.title}\n\n`)
    .join('\n')
  return `---\n${frontmatter}\n---\n\n${sections}`
}

/**
 * `gantry new <definitionId> <slug>`: creates instances/<slug>/instance.yaml
 * plus one blank module file per module in the definition's first stage.
 *
 * With `options.azureDevOps` supplied (`{ organization, project,
 * repository, pat, baseUrl? }`), that data/credential is written to, and
 * that same location is recorded *in*, the created instance.yaml (as
 * `azureDevOps: { organization, project, repository }` — never the `pat`)
 * instead of the local filesystem — see createInstanceInAzureDevOps below.
 * Without it, behavior is byte-for-byte what it was before #85: the three
 * local instances (`examples`, `demo-cli`, `demo-web`) and every existing
 * caller of this function are unaffected, and this call stays synchronous.
 */
export function createInstance(definitionId, slug, options = {}) {
  const definition = loadDefinition(definitionId, { definitionsDir: options.definitionsDir })
  const firstStage = definition.stages[0]
  if (!firstStage) {
    throw new Error(`Definition "${definitionId}" has no stages`)
  }

  if (options.azureDevOps) {
    return createInstanceInAzureDevOps(definitionId, slug, definition, firstStage, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const dir = instanceDir(instancesDir, slug)
  if (storage.exists(dir)) {
    throw new Error(`Instance "${slug}" already exists at ${dir}`)
  }
  storage.ensureDir(join(dir, 'modules'))

  storage.writeText(
    join(dir, 'instance.yaml'),
    stringifyYAML({ definition: definitionId, slug, stage: firstStage.id })
  )

  for (const moduleId of firstStage.modules) {
    const moduleSpec = definition.modules.get(moduleId)
    storage.writeText(
      modulePath(instancesDir, slug, moduleId),
      renderModuleFile(moduleSpec, { owner: options.owner ?? '' })
    )
  }

  return { slug, definitionId, stage: firstStage.id, modules: firstStage.modules }
}

/**
 * The Azure-DevOps-backed half of createInstance (#85): writes
 * instance.yaml and each first-stage module file to the Azure DevOps repo
 * named by `options.azureDevOps`, reusing `renderModuleFile`/`stringifyYAML`
 * unchanged from the local path above — only *where* the resulting text
 * lands differs. Returns a Promise (a real network call, unlike the local
 * path's plain object return), so callers that pass `options.azureDevOps`
 * must `await` this — callers that don't are untouched by this function
 * existing at all.
 *
 * Each file is a separate Azure DevOps push (there's no multi-file-commit
 * call on this client to batch them into one), so this is not atomic: a
 * failure partway through (a network blip, an expired PAT mid-flow) can
 * leave instance.yaml written with only some of its module files. Rather
 * than surfacing that failure as a bare network error — leaving a caller
 * with a repo in an unexplained partial state, and no way to tell from the
 * error alone what's already there — the module-writing loop below reports
 * exactly which modules were written and which weren't, with a next step
 * (finish the rest via writeModule, since instance.yaml already exists and
 * would make a second createInstance call reject as "already exists").
 */
async function createInstanceInAzureDevOps(definitionId, slug, definition, firstStage, options) {
  const client = azureDevOpsClientFor(options)
  const { organization, project, repository } = options.azureDevOps
  const location = `${organization}/${project}/${repository}`

  const alreadyExists = await client
    .getFileContent(AZURE_DEVOPS_INSTANCE_PATH)
    .then(() => true)
    .catch((err) => {
      if (err instanceof AzureDevOpsNotFoundError) return false
      throw err
    })
  if (alreadyExists) {
    throw new Error(`Instance "${slug}" already exists at Azure DevOps ${location}`)
  }

  await client.writeFile(
    AZURE_DEVOPS_INSTANCE_PATH,
    stringifyYAML({
      definition: definitionId,
      slug,
      stage: firstStage.id,
      azureDevOps: { organization, project, repository },
    }),
    { message: `Create instance "${slug}"` }
  )

  const writtenModules = []
  try {
    for (const moduleId of firstStage.modules) {
      const moduleSpec = definition.modules.get(moduleId)
      await client.writeFile(
        azureDevOpsModulePath(moduleId),
        renderModuleFile(moduleSpec, { owner: options.owner ?? '' }),
        { message: `Add module "${moduleId}"` }
      )
      writtenModules.push(moduleId)
    }
  } catch (err) {
    const remaining = firstStage.modules.filter((moduleId) => !writtenModules.includes(moduleId))
    throw new Error(
      `Instance "${slug}" was only partially created at Azure DevOps ${location}: instance.yaml and module(s) ` +
        `${writtenModules.join(', ') || '(none)'} were written, but module "${remaining[0]}" failed (${err.message}). ` +
        `instance.yaml now exists there, so re-running createInstance for this instance will reject as "already ` +
        `exists" — call writeModule directly for the remaining module(s) (${remaining.join(', ')}) to finish it.`
    )
  }

  return { slug, definitionId, stage: firstStage.id, modules: firstStage.modules }
}

function listInstanceSlugs(instancesDir) {
  return storage.listDir(instancesDir).filter((name) => storage.exists(join(instancesDir, name, 'instance.yaml')))
}

/**
 * With `options.azureDevOps` supplied, reads `instance.yaml` from that
 * Azure DevOps repo instead of the local filesystem (see
 * readInstanceFromAzureDevOps below) and returns a Promise the caller must
 * `await`. Without it — every existing caller — this stays exactly the
 * synchronous local-filesystem read it always was.
 */
export function readInstance(slug, options = {}) {
  if (options.azureDevOps) {
    return readInstanceFromAzureDevOps(slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = join(instanceDir(instancesDir, slug), 'instance.yaml')
  let text
  try {
    text = storage.readText(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      const available = listInstanceSlugs(instancesDir)
      const hint = available.length ? ` Available instances: ${available.join(', ')}.` : ''
      throw new Error(`No instance "${slug}" at ${path}.${hint}`)
    }
    throw new Error(`Cannot read instance "${slug}" at ${path}: ${err.message}`)
  }
  return parseYAML(text)
}

/**
 * The Azure-DevOps-backed half of readInstance (#85) — the exact same
 * `parseYAML` call as the local path, over content fetched from Azure
 * DevOps instead of read off disk. There's no "available instances" hint
 * on a miss the way the local path has: `listInstanceSlugs` is a directory
 * scan with no Azure DevOps equivalent in this ticket's scope.
 */
async function readInstanceFromAzureDevOps(slug, options) {
  const client = azureDevOpsClientFor(options)
  let text
  try {
    text = await client.getFileContent(AZURE_DEVOPS_INSTANCE_PATH)
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) {
      const { organization, project, repository } = options.azureDevOps
      throw new Error(`No instance "${slug}" at Azure DevOps ${organization}/${project}/${repository}.`)
    }
    throw err
  }
  return parseYAML(text)
}

/**
 * `gantry instances`: every instance in `instancesDir`, sorted by slug, with
 * its definition, current stage, and which stages actually have module data
 * on disk — `stage` alone can't tell you that, since it's just a pointer
 * that stays wherever the instance was created, not a claim about which
 * stages have been filled in (e.g. instances/examples/ has real content
 * for every stage, but its recorded `stage` is still "shape"). A lightweight
 * listing distinct from `readInstance`, which returns one instance's full
 * data.
 */
export function listInstances(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'
  return listInstanceSlugs(instancesDir)
    .sort()
    .map((slug) => {
      const instance = readInstance(slug, { instancesDir })
      const definition = loadDefinition(instance.definition, { definitionsDir })
      const stagesWithData = definition.stages
        .filter((stage) =>
          stage.modules.some((moduleId) => storage.exists(join(instancesDir, slug, 'modules', `${moduleId}.md`)))
        )
        .map((stage) => stage.id)
      return { slug, definition: instance.definition, stage: instance.stage, stagesWithData }
    })
}

/**
 * Parse a module instance file's frontmatter and field sections into
 * { module, status, owner, fields: { [fieldId]: string | string[] }, warnings },
 * keyed against `moduleSpec` (from loadDefinition) by matching each
 * `## <field.title>` heading (markdown formatting in the heading is
 * stripped before matching). Fields whose heading isn't found are left
 * out of the result (not defaulted), so callers can distinguish "absent"
 * from "empty".
 *
 * A heading that matches no field, or a duplicate heading (later occurrence
 * wins), is a warning in `warnings` by default. With `{ strict: true }` —
 * used by `gantry check`'s hard-error path — those same two conditions
 * throw instead, so a gate can't pass on data the parser wasn't confident
 * about.
 */
export function parseModuleFile(text, moduleSpec, options = {}) {
  const strict = options.strict ?? false
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    throw new Error(`Module file for "${moduleSpec.id}" is missing YAML frontmatter`)
  }
  const frontmatter = parseYAML(match[1]) ?? {}
  const body = text.slice(match[0].length)

  const fieldTitles = new Set(moduleSpec.fields.map((field) => field.title))
  const warnings = []
  const sections = new Map()
  const headingRe = /^##[ \t]+(.+?)\s*$/gm
  const headings = [...body.matchAll(headingRe)]
  for (let i = 0; i < headings.length; i++) {
    const rawTitle = headings[i][1]
    const title = normalizeHeadingText(rawTitle)
    const start = headings[i].index + headings[i][0].length
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length
    const value = body.slice(start, end).trim()

    if (!fieldTitles.has(title)) {
      const message = `Module "${moduleSpec.id}": heading "${rawTitle}" does not match any field`
      if (strict) throw new Error(message)
      warnings.push(message)
    }
    if (sections.has(title)) {
      const message = `Module "${moduleSpec.id}": duplicate heading "${rawTitle}" — later occurrence wins`
      if (strict) throw new Error(message)
      warnings.push(message)
    }

    sections.set(title, value)
  }

  const fields = {}
  for (const field of moduleSpec.fields) {
    const raw = sections.get(field.title)
    if (raw === undefined) continue
    if (field.type === 'list') {
      // A bullet's wrapped continuation lines (no leading "- ") fold onto
      // the item they follow, rather than being silently dropped.
      const items = []
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim()
        if (line === '') continue
        if (line.startsWith('- ')) {
          items.push(line.slice(2).trim())
        } else if (items.length > 0) {
          items[items.length - 1] += ` ${line}`
        }
      }
      fields[field.id] = items
    } else {
      fields[field.id] = raw
    }
  }

  return {
    module: frontmatter.module,
    status: frontmatter.status,
    owner: frontmatter.owner,
    fields,
    warnings,
  }
}

/**
 * Writes a module instance file in the same format `createInstance`/
 * `parseModuleFile` produce and read: frontmatter (`module`, `status`,
 * `owner`) followed by one `## <field.title>` section per field, in
 * `moduleSpec` order. `data.fields` is keyed by field id, as returned by
 * `parseModuleFile`/`readModule` — this is the exact inverse of those.
 *
 * With `options.azureDevOps` supplied, writes the module file to that
 * Azure DevOps repo instead of the local filesystem and returns a Promise
 * the caller must `await`. Without it — every existing caller — this
 * stays exactly the synchronous local-filesystem write it always was; the
 * frontmatter/section text itself is built by `renderModuleInstanceFile`
 * either way, so the two storage backends can never drift in what they
 * write.
 */
export function writeModule(definition, slug, moduleId, data, options = {}) {
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }

  const text = renderModuleInstanceFile(moduleId, moduleSpec, data)

  if (options.azureDevOps) {
    return writeModuleToAzureDevOps(moduleId, text, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = modulePath(instancesDir, slug, moduleId)
  storage.writeText(path, text)
  return { module: moduleId, path }
}

// The exact frontmatter+field-sections text writeModule writes and
// readModule/parseModuleFile read back — factored out of writeModule so
// both storage backends write the identical bytes, computed exactly once
// per call, rather than each backend recomputing (and risking drifting)
// its own copy.
function renderModuleInstanceFile(moduleId, moduleSpec, data) {
  const frontmatter = stringifyYAML({
    module: moduleId,
    status: data.status ?? 'draft',
    owner: data.owner ?? '',
  }).trimEnd()

  const sections = moduleSpec.fields
    .map((field) => {
      const value = data.fields?.[field.id]
      const body =
        field.type === 'list'
          ? (Array.isArray(value) ? value : [])
              .map((item) => item.trim())
              .filter((item) => item !== '')
              .map((item) => `- ${item}`)
              .join('\n')
          : value ?? ''
      return `## ${field.title}\n\n${body}\n`
    })
    .join('\n')

  return `---\n${frontmatter}\n---\n\n${sections}`
}

async function writeModuleToAzureDevOps(moduleId, text, options) {
  const client = azureDevOpsClientFor(options)
  const path = azureDevOpsModulePath(moduleId)
  await client.writeFile(path, text, { message: `Update module "${moduleId}"` })
  return { module: moduleId, path }
}

/**
 * With `options.azureDevOps` supplied, reads the module file from that
 * Azure DevOps repo instead of the local filesystem and returns a Promise
 * the caller must `await`. Without it — every existing caller — this
 * stays exactly the synchronous local-filesystem read it always was.
 */
export function readModule(definition, slug, moduleId, options = {}) {
  const moduleSpec = definition.modules.get(moduleId)
  if (!moduleSpec) {
    throw new Error(`Definition "${definition.id}" has no module "${moduleId}"`)
  }

  if (options.azureDevOps) {
    return readModuleFromAzureDevOps(moduleSpec, slug, moduleId, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const path = modulePath(instancesDir, slug, moduleId)
  let text
  try {
    text = storage.readText(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Module "${moduleId}" has no saved data for instance "${slug}" (expected ${path}) — fill in its fields and save before rendering`
      )
    }
    throw new Error(`Cannot read module "${moduleId}" for instance "${slug}" at ${path}: ${err.message}`)
  }
  return parseModuleFile(text, moduleSpec)
}

// The Azure-DevOps-backed half of readModule (#85) — the exact same
// parseModuleFile call as the local path, over content fetched from
// Azure DevOps instead of read off disk.
async function readModuleFromAzureDevOps(moduleSpec, slug, moduleId, options) {
  const client = azureDevOpsClientFor(options)
  const path = azureDevOpsModulePath(moduleId)
  let text
  try {
    text = await client.getFileContent(path)
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) {
      throw new Error(
        `Module "${moduleId}" has no saved data for instance "${slug}" (expected ${path} in Azure DevOps) — fill in its fields and save before rendering`
      )
    }
    throw err
  }
  return parseModuleFile(text, moduleSpec)
}
