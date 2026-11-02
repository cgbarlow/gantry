// #283 (ADR-0065): **Standard modules** — Modules Gantry itself provides, rather than a Definition: a
// fixed id, a fixed Field shape and a version. This is the one place they are described, and the one
// description every surface reads: the Definition loaders (disk and each Provider), the validators
// (lib/definition.js and the Local Workspace twin), the Definitions page and its Local Workspace
// editor, and the Local Workspace status twin.
//
// A Definition mounts a standard module in two steps, so everything downstream of the loader sees an
// ordinary Module and nothing else needs to know the difference:
//
//   standard-modules:            # in definition.yaml, beside `stages:`
//     - id: glossary
//       version: 1               # required: a Definition names the version it mounts
//       guidance: ...            # optional: added to every Field's own guidance
//       interview: ...           # optional: Interview instructions for this Module (ADR-0062)
//     - id: key-decisions
//       version: 1
//       prefix: AD               # Key decisions only: the numbers' prefix (AD01, AD02, …); default KD
//       style: why               # Key decisions only: `default` or `why` (WH(Y)); default `default`
//   stages:
//     - id: shape
//       modules: [background, glossary]   # mounted on a Stage like any other Module
//
// A Definition can add guidance and Interview instructions to a standard module and can do nothing
// else to it (Key decisions also takes its numbers' prefix and its decision style, which choose how it
// is written, not what Fields it has): no key of the mount changes the shape, and a Definition's own `modules/glossary.yaml`
// with the same id is refused. The shape is Gantry's, so the AI (and a reader) can rely on it being the
// same in every Definition.
//
// **Versions never change once released.** A published Definition renders the same forever because a
// version's entry below is frozen: a Gantry release adds a new version beside it (`2: {...}`) and a
// Definition moves to it by editing its `version:`. `tests/standardModules.test.js` pins version 1's
// exact shape, so changing it in place fails the build.
//
// Pure and dependency-free, like web/lib/instanceSettings.js, so `lib/` imports it directly. Fields
// are the camelCase in-memory shape (`targetWords`), the same as a loaded Module's.

import { KEY_DECISIONS_ID, DEFAULT_PREFIX, DEFAULT_STYLE, DECISION_STYLES, PREFIX_RE, keyDecisionProblems } from './keyDecisions.js'

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Gantry's standard modules, by id then version. Add a version; never edit one that has shipped.
 */
export const STANDARD_MODULES = deepFreeze({
  glossary: {
    title: 'Glossary',
    versions: {
      1: {
        title: 'Glossary',
        purpose: 'Define the terms, acronyms and abbreviations a reader needs to follow this document, so every other field uses one name for each.',
        fields: [
          {
            id: 'terms',
            title: 'Terms and definitions',
            type: 'markdown',
            targetWords: { small: 140, medium: 275, large: 460 },
            guidance:
              'A table with one row per term: Preferred term | Definition | Avoid. Give the preferred term for each thing the document names, a one-line definition, and the variants not to use (former names, informal names, other spellings; "—" where there are none). Other fields then use the preferred term in headings, tables, diagrams and prose.',
          },
        ],
      },
    },
  },
  'open-questions': {
    title: 'Open questions',
    versions: {
      1: {
        title: 'Open questions',
        purpose: 'List the questions that are still open, who needs to resolve each one and by when.',
        fields: [
          {
            id: 'questions',
            title: 'Open questions',
            type: 'markdown',
            targetWords: { small: 85, medium: 175, large: 290 },
            guidance:
              'A table with one row per question: Question | Who resolves | By when | Status. Say who can answer it and the date it has to be settled by, and keep Status current (open, answered, or dropped with the reason). A question that has been answered stays in the table rather than disappearing.',
          },
        ],
      },
    },
  },
  // #284 (ADR-0065): significant decisions only, numbered. The Field is Markdown to everything else;
  // web/lib/keyDecisions.js owns the text inside it. `styleGuidance` is added after `guidance`, by the
  // decision style the Definition mounts it with.
  'key-decisions': {
    title: 'Key decisions',
    versions: {
      1: {
        title: 'Key decisions',
        purpose: 'Record the significant design decisions: each one hard to reverse, surprising without its context, and the result of a real trade-off. Each has a number that stays the same when decisions are reordered or removed.',
        fields: [
          {
            id: 'decisions',
            title: 'Key decisions',
            type: 'markdown',
            targetWords: { small: 200, medium: 420, large: 720 },
            guidance:
              'Record only a decision that is hard to reverse, surprising without its context, and the result of a real trade-off; routine choices belong elsewhere. Add a decision with Add decision. Its number is given once and never changes, so other documents and decisions can refer to it by number.',
          },
        ],
        styleGuidance: {
          default:
            'Write each decision as: Context (the situation and forces), Decision (what was decided), Why (the reasons), Considered options (what else was weighed) and Consequences (what follows, good and bad).',
          why:
            'Write each decision as one statement: "In the context of …, facing …, we decided for … and neglected …, to achieve …, accepting that …." Then link it to the decisions it depends on, supersedes or relates to.',
        },
      },
    },
  },
})

/** The only keys a Definition's mount of a standard module may carry. Anything else would change what Gantry provides. */
export const STANDARD_MODULE_MOUNT_KEYS = Object.freeze(['id', 'version', 'guidance', 'interview'])

/** Key decisions also takes how its numbers are written (`prefix`) and which decision style it uses (`style`). */
const KEY_DECISIONS_MOUNT_KEYS = Object.freeze([...STANDARD_MODULE_MOUNT_KEYS, 'prefix', 'style'])

/** The keys a mount of standard module `id` may carry. */
export const standardModuleMountKeys = (id) => (id === KEY_DECISIONS_ID ? KEY_DECISIONS_MOUNT_KEYS : STANDARD_MODULE_MOUNT_KEYS)

/** A Key decisions mount's prefix and style, with the defaults for either left out (`KD`, `default`). */
export function keyDecisionsSettings(mount) {
  return {
    prefix: typeof mount?.prefix === 'string' && PREFIX_RE.test(mount.prefix) ? mount.prefix : DEFAULT_PREFIX,
    style: DECISION_STYLES.includes(mount?.style) ? mount.style : DEFAULT_STYLE,
  }
}

/** A new mount's own settings: Key decisions is written out with its defaults (so the Definition says what it uses), nothing else has any. */
export const newMountSettings = (id) => (id === KEY_DECISIONS_ID ? { prefix: DEFAULT_PREFIX, style: DEFAULT_STYLE } : {})

/** The Key decisions settings a Module resolved from a mount carries (`standard.prefix`, `standard.style`), or `undefined` for any other Module. */
export function moduleKeyDecisions(module) {
  if (!module || module.id !== KEY_DECISIONS_ID || !module.standard) return undefined
  return keyDecisionsSettings(module.standard)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The version numbers `catalogue` holds for a standard module id, ascending; `[]` for an unknown id. */
export function standardModuleVersions(id, catalogue = STANDARD_MODULES) {
  const entry = Object.prototype.hasOwnProperty.call(catalogue, id) ? catalogue[id] : undefined
  return entry ? Object.keys(entry.versions).map(Number).sort((a, b) => a - b) : []
}

/** Whether `id` names a standard module in `catalogue`. */
export function isStandardModuleId(id, catalogue = STANDARD_MODULES) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(catalogue, id)
}

/**
 * What the Definitions page offers to mount: `[{ id, title, versions: [{ version, title, purpose, fields }] }]`
 * (newest version last). The shapes are included so the page can show a Module Gantry provides read-only.
 */
export function listStandardModules(catalogue = STANDARD_MODULES) {
  return Object.keys(catalogue).map((id) => ({
    id,
    title: catalogue[id].title,
    versions: standardModuleVersions(id, catalogue).map((version) => ({ version, ...catalogue[id].versions[version] })),
  }))
}

/** The shape of one standard module version, or `undefined` when `id` or `version` isn't in `catalogue`. */
export function standardModuleShape(id, version, catalogue = STANDARD_MODULES) {
  if (!isStandardModuleId(id, catalogue)) return undefined
  return catalogue[id].versions[version]
}

/**
 * #284: what is wrong with a Key decisions Module's saved decisions (a number used twice, a link to a
 * decision that isn't there, a loop), as the status warnings both twins (lib/status.js and
 * web/lib/localStatus.js) report. A content problem like an off-list select value: it warns, never
 * blocks the Gate. `[]` for any other Module, or one that isn't saved yet.
 */
export function keyDecisionWarnings(moduleSpec, exists, parsedFields) {
  const settings = moduleKeyDecisions(moduleSpec)
  if (!exists || !settings) return []
  const warnings = []
  for (const field of moduleSpec.fields) {
    if (typeof parsedFields[field.id] !== 'string') continue
    for (const problem of keyDecisionProblems(parsedFields[field.id], settings)) {
      warnings.push(`Module "${moduleSpec.title}" field "${field.title}": ${problem}`)
    }
  }
  return warnings
}

/**
 * One mount, resolved to an ordinary Module (camelCase, as `moduleFromRaw` returns) marked
 * `standard: { version }`. The mount's `guidance` is added after Gantry's own on every Field, and its
 * `interview` rides on the Module. `undefined` when the mount names no such id or version, so a caller
 * that reaches here with a malformed mount ignores it (the validators report it).
 */
export function resolveStandardModule(mount, catalogue = STANDARD_MODULES) {
  if (!isPlainObject(mount)) return undefined
  const shape = standardModuleShape(mount.id, mount.version, catalogue)
  if (!shape) return undefined
  const added = typeof mount.guidance === 'string' && mount.guidance.trim() !== '' ? mount.guidance.trim() : null
  const keyDecisions = mount.id === KEY_DECISIONS_ID ? keyDecisionsSettings(mount) : undefined
  const styleGuidance = keyDecisions ? shape.styleGuidance?.[keyDecisions.style] : undefined
  const resolved = {
    id: mount.id,
    title: shape.title,
    purpose: shape.purpose,
    fields: shape.fields.map((field) => {
      const copy = { ...field, ...(field.targetWords ? { targetWords: { ...field.targetWords } } : {}) }
      if (styleGuidance) copy.guidance = copy.guidance ? `${copy.guidance}\n\n${styleGuidance}` : styleGuidance
      if (added) copy.guidance = copy.guidance ? `${copy.guidance}\n\n${added}` : added
      return copy
    }),
    standard: keyDecisions ? { version: mount.version, ...keyDecisions } : { version: mount.version },
  }
  if (typeof mount.interview === 'string' && mount.interview.trim() !== '') resolved.interview = mount.interview.trim()
  return resolved
}

/** Every well-formed mount in a Definition's `standard-modules` list, resolved; a malformed list or entry is skipped. */
export function resolveStandardModules(mounts, catalogue = STANDARD_MODULES) {
  if (!Array.isArray(mounts)) return []
  const seen = new Set()
  const resolved = []
  for (const mount of mounts) {
    const module = resolveStandardModule(mount, catalogue)
    if (!module || seen.has(module.id)) continue
    seen.add(module.id)
    resolved.push(module)
  }
  return resolved
}

/**
 * A raw (kebab-case, as read off disk) module record for one resolved standard module — `required-at`
 * and `target-words` spelled the way the YAML validators read them. Standard modules carry neither a
 * `required-at` nor a `required`, so this is the resolved Module with its budget key renamed.
 */
export function rawStandardModule(module) {
  return {
    id: module.id,
    title: module.title,
    purpose: module.purpose,
    fields: module.fields.map(({ targetWords, ...field }) => ({ ...field, ...(targetWords ? { 'target-words': targetWords } : {}) })),
  }
}

/**
 * `modules` (a Definition's own Modules, in a projection's array form) with its standard modules
 * resolved and appended — what the status twin and any other consumer of a projection reads, so a
 * mounted standard module is looked up like any other. Own Modules win an id clash (the validators
 * refuse that Definition; this just keeps a stale one readable).
 */
export function modulesWithStandard(modules, mounts, catalogue = STANDARD_MODULES) {
  const own = modules ?? []
  const ids = new Set(own.map((m) => m.id))
  return [...own, ...resolveStandardModules(mounts, catalogue).filter((m) => !ids.has(m.id))]
}

/**
 * The problems with a Definition's `standard-modules` declaration, as `{ type, message }` (every message
 * starts `Standard module "<id>"` so the Definitions page anchors its marker on the mount). `declared`
 * is the value as the Definition holds it (`undefined` for none) and `ownModuleIds` the ids of the
 * Definition's own Modules.
 *
 * - `invalid-standard-modules`: the declaration isn't a list of mounts.
 * - `unknown-standard-module`: Gantry provides no such module.
 * - `unknown-standard-module-version`: no version named, or one Gantry does not provide.
 * - `standard-module-shape-changed`: the mount carries a key beyond guidance and interview (it would
 *   change the shape), or the Definition has its own Module with the same id.
 * - `duplicate-standard-module`: mounted twice (a Definition mounts one version of each).
 * - `invalid-standard-module-text`: guidance or interview isn't text.
 * - `invalid-key-decisions-prefix` / `invalid-key-decisions-style` (#284): Key decisions' prefix isn't 1 to 6
 *   capital letters, or its style isn't `default` or `why`.
 */
export function standardModuleProblems(declared, ownModuleIds = [], catalogue = STANDARD_MODULES) {
  if (declared === undefined) return []
  if (!Array.isArray(declared)) {
    return [{ type: 'invalid-standard-modules', message: `Standard modules are declared as a list ("standard-modules: [{ id, version }]"), not ${JSON.stringify(declared)}` }]
  }
  const problems = []
  const own = new Set(ownModuleIds)
  const seen = new Set()
  const provided = Object.keys(catalogue).join(', ')
  for (const mount of declared) {
    if (!isPlainObject(mount) || typeof mount.id !== 'string' || mount.id === '') {
      problems.push({ type: 'invalid-standard-modules', message: `Standard modules must each be written as { id, version }, not ${JSON.stringify(mount)}` })
      continue
    }
    const where = `Standard module "${mount.id}"`
    if (!isStandardModuleId(mount.id, catalogue)) {
      problems.push({ type: 'unknown-standard-module', message: `${where} is not provided by Gantry (Gantry provides: ${provided})` })
      continue
    }
    if (seen.has(mount.id)) {
      problems.push({ type: 'duplicate-standard-module', message: `${where} is mounted more than once — a Definition mounts one version of each` })
      continue
    }
    seen.add(mount.id)
    const available = standardModuleVersions(mount.id, catalogue)
    if (mount.version === undefined || mount.version === null) {
      problems.push({ type: 'unknown-standard-module-version', message: `${where} names no version — name the one this Definition mounts (available: ${available.join(', ')})` })
    } else if (!Number.isInteger(mount.version) || !available.includes(mount.version)) {
      problems.push({ type: 'unknown-standard-module-version', message: `${where} names version ${JSON.stringify(mount.version)}, which Gantry does not provide (available: ${available.join(', ')})` })
    }
    const allowed = standardModuleMountKeys(mount.id)
    for (const key of Object.keys(mount)) {
      if (allowed.includes(key)) continue
      problems.push({
        type: 'standard-module-shape-changed',
        message: `${where} sets "${key}", which would change its shape — Gantry owns that; a Definition can only add guidance and interview instructions`,
      })
    }
    if (mount.id === KEY_DECISIONS_ID) {
      if (mount.prefix !== undefined && !(typeof mount.prefix === 'string' && PREFIX_RE.test(mount.prefix))) {
        problems.push({ type: 'invalid-key-decisions-prefix', message: `${where} sets prefix ${JSON.stringify(mount.prefix)} — a prefix is 1 to 6 capital letters, such as "AD"` })
      }
      if (mount.style !== undefined && !DECISION_STYLES.includes(mount.style)) {
        problems.push({ type: 'invalid-key-decisions-style', message: `${where} sets style ${JSON.stringify(mount.style)} — a decision style is "default" or "why" (WH(Y))` })
      }
    }
    for (const key of ['guidance', 'interview']) {
      if (mount[key] !== undefined && typeof mount[key] !== 'string') {
        problems.push({ type: 'invalid-standard-module-text', message: `${where} sets "${key}" to ${JSON.stringify(mount[key])} — it must be text` })
      }
    }
    if (own.has(mount.id)) {
      problems.push({
        type: 'standard-module-shape-changed',
        message: `${where} is also defined as one of this Definition's own modules — a Definition cannot redefine a standard module's shape (remove its own "${mount.id}" module)`,
      })
    }
  }
  return problems
}
