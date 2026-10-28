// #219 (spec #223, docs/adr/0058): an Instance's **Instance settings** — the per-Instance choices its
// Definition declares, each as its choices plus an optional default. This is the one description of
// them every surface reads: the "+ New Workspace" wizard, Instance Settings, the Definitions page
// (server and Local Workspace), Instance creation, the settings write path and `GET /api/instance`
// (and so MCP `get_instance`). None of those hard-codes a setting; adding one is a new entry in
// `MEMBERS` below plus whatever reads its value (such as the render).
//
// Target size (ADR-0054) is the first member and Classification (#220) the second. Assignee and
// Required reviewer are not members: they are about people, the Definition doesn't declare them, and
// they keep their own routes (ADR-0058 §9).
//
// A Definition declares its Instance settings under `instance-settings:` in definition.yaml
// (`instanceSettings` once loaded), keyed by setting id:
//
//   instance-settings:
//     size:
//       default: small           # optional; Size's choices are Gantry's own (#221)
//     classification:
//       choices: [UNCLASSIFIED, IN-CONFIDENCE, SENSITIVE, RESTRICTED]
//       default: IN-CONFIDENCE   # optional
//
// `instanceSettingsDeclarationProblems` below is the rule for a well-formed declaration, shared by
// both validators (lib/definition.js and web/lib/localStatus.js). A malformed one is reported, but it
// never stops a Definition loading: the readers here ignore it, as though it weren't declared.
//
// Pure and dependency-free, like web/lib/targetSize.js, so `lib/` imports it directly. A `definition`
// here is anything with `{ id, version, modules, instanceSettings }` — a loaded Definition (`modules`
// a `Map`) or a version projection (`modules` an array) — so the server and the browser describe it
// identically.

import { TARGET_SIZES, DEFAULT_TARGET_SIZE, isTargetSize, targetSizeLabel, targetWordsFieldCount } from './targetSize.js'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const quotedList = (values) => values.map((value) => JSON.stringify(value)).join(', ')
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A Definition's `instance-settings` declaration as it holds it — loaded (`instanceSettings`) or raw YAML (`instance-settings`) — or `undefined`. */
export function instanceSettingsDeclaration(definition) {
  return definition?.instanceSettings !== undefined ? definition.instanceSettings : definition?.['instance-settings']
}

// #221 (ADR-0058 §2): why `declaration` (the `size:` entry) isn't a well-formed Size declaration —
// one message each — or none. Small, Medium and Large are Gantry's, because every Field's
// `target-words` is keyed by them, so a Definition declares only which one is its default.
function sizeDeclarationProblems(declaration) {
  const where = 'Instance setting "size"'
  if (!isPlainObject(declaration)) {
    return [`${where} must declare its "default", the size an instance works to until one is chosen — e.g. "size: { default: small }"`]
  }
  const problems = []
  for (const key of Object.keys(declaration).filter((key) => key !== 'default')) {
    problems.push(
      key === 'choices'
        ? `${where} declares "choices", but Small, Medium and Large are fixed by Gantry, because every Field's word targets are written against them — declare only its "default"`
        : `${where} has an unknown key "${key}" — a Size declaration has only "default"`
    )
  }
  if (declaration.default !== undefined && declaration.default !== null && !isTargetSize(declaration.default)) {
    problems.push(`${where} has "default: ${declaration.default}", which is not one of its choices (${quotedList(TARGET_SIZES)})`)
  }
  return problems
}

// The `size:` entry when it is well-formed, else `null`, read as Classification's is below.
function sizeDeclaration(definition) {
  const declared = instanceSettingsDeclaration(definition)
  if (!isPlainObject(declared) || declared.size === undefined) return null
  return sizeDeclarationProblems(declared.size).length === 0 ? declared.size : null
}

// Why `declaration` (the `classification:` entry) isn't a well-formed list of markings — one message
// each — or none. Markings are stored verbatim (the Option rule, ADR-0044), so each must be text with
// something in it, and no two may be the same.
function classificationDeclarationProblems(declaration) {
  const where = 'Instance setting "classification"'
  if (!isPlainObject(declaration)) {
    return [`${where} must declare its "choices", the markings an instance chooses from — e.g. "choices: [UNCLASSIFIED, IN-CONFIDENCE]"`]
  }
  const problems = []
  for (const key of Object.keys(declaration).filter((key) => key !== 'choices' && key !== 'default')) {
    problems.push(`${where} has an unknown key "${key}" — a declaration has "choices" and, optionally, "default"`)
  }
  const { choices } = declaration
  if (!Array.isArray(choices) || choices.length === 0) {
    problems.push(`${where} declares no "choices" — list at least one marking`)
    return problems
  }
  const seen = new Set()
  for (const choice of choices) {
    if (typeof choice !== 'string' || choice.trim() === '') {
      problems.push(`${where} has a blank or non-text marking (${JSON.stringify(choice)}) — every choice must be the marking's text`)
    } else if (seen.has(choice)) {
      problems.push(`${where} lists the marking "${choice}" more than once`)
    }
    seen.add(choice)
  }
  if (declaration.default !== undefined && declaration.default !== null && !choices.includes(declaration.default)) {
    problems.push(`${where} has "default: ${declaration.default}", which is not one of its choices (${quotedList(choices)})`)
  }
  return problems
}

// The Classification declaration when it is well-formed, else `null`: a malformed one is a Definition
// problem, and every reader treats it as undeclared.
function classificationDeclaration(definition) {
  const declared = instanceSettingsDeclaration(definition)
  if (!isPlainObject(declared) || declared.classification === undefined) return null
  return classificationDeclarationProblems(declared.classification).length === 0 ? declared.classification : null
}

// Each member Gantry knows, in the order every surface shows them. `offeredBecause` is why the
// Definition offers it (shown on the Definitions page), or `null` when it doesn't, in which case the
// setting appears nowhere and storing it is refused. `fixedChoices` means Gantry, not the
// Definition, owns the choices, so a value outside them is refused even where it isn't offered.
// `optional` means blank is a real choice (no value, so the fallback applies). A member with
// `declarationProblems` is one a Definition declares under `instance-settings:`.
const MEMBERS = [
  {
    id: 'size',
    label: 'Size',
    name: 'Target size',
    guidance:
      'How much to write in each field. Every field with a word target shows it in the editor for this size, with a live word count. ' +
      'Medium is about half of Large, and Small about a fifth. It\'s a target, not a limit: nothing is blocked, and documents render exactly what was written.',
    fixedChoices: true,
    fallback: DEFAULT_TARGET_SIZE,
    choices: () => TARGET_SIZES.map((value) => ({ value, label: targetSizeLabel(value) })),
    // ADR-0054 §3: offered only where some Field declares `target-words`.
    offeredBecause(definition) {
      const count = targetWordsFieldCount(definition?.modules)
      return count > 0 ? `${plural(count, 'Field declares', 'Fields declare')} word targets` : null
    },
    // ADR-0058 §4 (#221): the Definition's declared default, else Medium, so a Definition that
    // declares none works exactly as before.
    defaultValue: (definition) => sizeDeclaration(definition)?.default ?? DEFAULT_TARGET_SIZE,
    declarationProblems: sizeDeclarationProblems,
    unknownValueMessage: (value) =>
      `Unknown size ${JSON.stringify(value)} — choose ${TARGET_SIZES.slice(0, -1).join(', ')} or ${TARGET_SIZES.at(-1)}`,
    notOfferedMessage: (definition) =>
      `Definition "${definition?.id}" v${definition?.version ?? 1} declares no target-words, so its instances have no size`,
  },
  {
    // #220 (ADR-0058 §2, §6): the marking every document of the Instance carries, printed on each
    // cover and in each page header (ADR-0052). Its choices are the Definition's own markings.
    id: 'classification',
    label: 'Classification',
    name: 'Classification',
    guidance:
      'How this instance\'s documents must be handled. The marking is printed on the cover and in the page header of every document rendered from it. ' +
      'Choose the one that fits the most sensitive content any of them carries. Left blank, no marking is printed.',
    fixedChoices: false,
    optional: true,
    fallback: '',
    choices: (definition) => (classificationDeclaration(definition)?.choices ?? []).map((value) => ({ value, label: value })),
    offeredBecause(definition) {
      const declaration = classificationDeclaration(definition)
      return declaration ? `the Definition declares ${plural(declaration.choices.length, 'marking', 'markings')}` : null
    },
    defaultValue: (definition) => classificationDeclaration(definition)?.default ?? null,
    declarationProblems: classificationDeclarationProblems,
    unknownValueMessage: (value, choices) =>
      `Unknown classification ${JSON.stringify(value)} — choose one of the Definition's markings: ${quotedList(choices.map((choice) => choice.value))}`,
    notOfferedMessage: (definition) =>
      `Definition "${definition?.id}" v${definition?.version ?? 1} declares no classification markings, so its instances have no classification`,
  },
]

/** The id of every Instance setting Gantry knows, whether or not a given Definition offers it. */
export const INSTANCE_SETTING_IDS = MEMBERS.map((member) => member.id)

const memberById = (id) => MEMBERS.find((member) => member.id === id)

/** The name an Instance setting is shown under (`Target size`, `Classification`), or `id` itself for one Gantry doesn't know. */
export function instanceSettingName(id) {
  return memberById(id)?.name ?? id
}

/**
 * Problems with a Definition's `instance-settings` declaration (ADR-0058 §5), each
 * `{ type: 'invalid-instance-settings', message }`, the message opening `Instance setting "<id>"`
 * where it is about one setting, which is how the Definitions page anchors its marker. A malformed
 * declaration is an authoring-time problem: Save and Publish refuse it, but a Definition carrying one
 * still loads, and every reader ignores the malformed setting. `declaration` is the raw value; a
 * Definition without one has no problem.
 */
export function instanceSettingsDeclarationProblems(declaration) {
  if (declaration === undefined || declaration === null) return []
  const problem = (message) => ({ type: 'invalid-instance-settings', message })
  if (!isPlainObject(declaration)) {
    return [problem(`"instance-settings" must map each Instance setting's id to its declaration — e.g. "classification: { choices: [...] }"`)]
  }
  const declarable = MEMBERS.filter((member) => member.declarationProblems).map((member) => member.id)
  const problems = []
  for (const [id, entry] of Object.entries(declaration)) {
    const member = memberById(id)
    if (!member?.declarationProblems) {
      problems.push(problem(`Instance setting "${id}" is not one a Definition can declare — Gantry knows ${quotedList(declarable)}`))
      continue
    }
    problems.push(...member.declarationProblems(entry).map(problem))
  }
  return problems
}

function describe(member, definition) {
  const offeredBecause = member.offeredBecause(definition)
  if (!offeredBecause) return null
  const byDefault = member.defaultValue(definition)
  return {
    id: member.id,
    label: member.label,
    name: member.name,
    guidance: member.guidance,
    choices: member.choices(definition),
    default: byDefault,
    fixedChoices: member.fixedChoices,
    // Blank is offered only where it means something: an optional setting with no default.
    optional: member.optional === true && !byDefault,
    offeredBecause,
  }
}

/**
 * The Instance settings `definition` offers, in display order: each `{ id, label, name, guidance,
 * choices: [{ value, label }], default, fixedChoices, optional, offeredBecause }`, where `optional`
 * means a blank choice ("None") is offered beside the others. Empty for a Definition that offers none
 * (design v1/v2, recruitment-onboarding), which every surface then shows nothing for.
 */
export function definitionInstanceSettings(definition) {
  return MEMBERS.map((member) => describe(member, definition)).filter(Boolean)
}

const isBlank = (value) => value === undefined || value === null || value === ''

/** `setting`'s effective value for an Instance that stores `stored`: the stored value when it is one of the choices, else the default, else the setting's fallback (Medium; a blank Classification). */
export function effectiveInstanceSetting(setting, stored) {
  return setting.choices.some((choice) => choice.value === stored) ? stored : setting.default ?? memberById(setting.id)?.fallback ?? ''
}

/**
 * The Instance settings `definition` offers, each with the effective `value` for an Instance whose
 * record is `record` (its `instance.yaml`, or anything holding the same keys) — what Instance
 * Settings shows and `GET /api/instance` returns.
 */
export function instanceSettingsWithValues(definition, record) {
  return definitionInstanceSettings(definition).map((setting) => ({ ...setting, value: effectiveInstanceSetting(setting, record?.[setting.id]) }))
}

/**
 * `response` (the `GET /api/instance` shape) with `instanceSettings` — the offered settings and their
 * values — added; the response itself, unchanged, for a Definition that offers none. Shared by the
 * server route and the Local Workspace's own loader so both Instance Settings screens read the same.
 */
export function withInstanceSettings(response, definition, record) {
  const settings = instanceSettingsWithValues(definition, record)
  return settings.length ? { ...response, instanceSettings: settings } : response
}

/**
 * The Target size an Instance works to (#221, ADR-0058 §4): its stored `size` when it is one, else
 * the Definition's default, else Medium. What the editor's word targets, `GET /api/instance` (and so
 * MCP `get_instance`) and a save's over-budget notes are worked out at. `record` is the instance
 * record.
 */
export function instanceTargetSize(definition, record) {
  return isTargetSize(record?.size) ? record.size : memberById('size').defaultValue(definition)
}

/**
 * The Classification an Instance's documents print (#220, ADR-0058 §6): its effective value — stored,
 * else the Definition's default, else blank — when `definition` declares markings; `null` when it
 * declares none, which is when the render falls back to an Artefact's `cover-classification` Field
 * (ADR-0052). `record` is the instance record.
 */
export function instanceClassification(definition, record) {
  const setting = definitionInstanceSettings(definition).find((candidate) => candidate.id === 'classification')
  return setting ? effectiveInstanceSetting(setting, record?.classification) : null
}

/**
 * Why `value` can't be stored as Instance setting `id` on an instance of `definition` — a setting
 * Gantry doesn't know, a value outside its choices, or a setting the Definition doesn't offer — or
 * `null` when it can. Shared by Instance creation (wizard, `gantry new`, MCP `create_instance`) and
 * the Instance Settings write, so every path refuses the same things the same way.
 */
export function instanceSettingProblem(definition, id, value) {
  const member = memberById(id)
  if (!member) return `Unknown Instance setting ${JSON.stringify(id)} — Gantry knows ${INSTANCE_SETTING_IDS.map((known) => `"${known}"`).join(', ')}`
  const setting = describe(member, definition)
  const choices = setting?.choices ?? (member.fixedChoices ? member.choices(definition) : null)
  if (choices && !choices.some((choice) => choice.value === value)) return member.unknownValueMessage(value, choices)
  if (!setting) return member.notOfferedMessage(definition)
  return null
}

/** The first `instanceSettingProblem` among `settings` (`{ [id]: value }`), skipping blank values (nothing chosen), or `null`. */
export function instanceSettingsProblem(definition, settings) {
  for (const [id, value] of Object.entries(settings ?? {})) {
    if (!memberById(id)) return instanceSettingProblem(definition, id, value)
    if (isBlank(value)) continue
    const problem = instanceSettingProblem(definition, id, value)
    if (problem) return problem
  }
  return null
}

/**
 * The Instance settings `source` chooses — `{ [id]: value }` for each known setting it holds a
 * non-blank value for, so a key is written only when a value was chosen (ADR-0058 §3). `source` is a
 * request body, a create call's options or an instance record.
 */
export function chosenInstanceSettings(source) {
  return Object.fromEntries(INSTANCE_SETTING_IDS.filter((id) => !isBlank(source?.[id])).map((id) => [id, source[id]]))
}

/**
 * `record` (an `instance.yaml`'s contents) after an Instance Settings save of `settings`: a chosen
 * value replaces the stored one, and a blank value removes the key, so the Instance works to the
 * Definition's default again. Every other key is kept.
 */
export function withChangedInstanceSettings(record, settings) {
  const next = { ...record }
  for (const [id, value] of Object.entries(settings ?? {})) {
    if (isBlank(value)) delete next[id]
    else next[id] = value
  }
  return next
}

// ------------------------------------------------------------ Editing a declaration (#221)
// ADR-0058 §7: what the Definitions page (server and Local Workspace) does to a draft's
// `instance-settings` as its author edits each setting's choices and default. Each takes the
// declaration as the draft holds it (`instanceSettingsDeclaration`) and returns a new one, leaving
// the old untouched. Nothing here refuses an edit: a blank or repeated marking, or an emptied list,
// is kept as typed and reported by `instanceSettingsDeclarationProblems`, so the author sees the
// problem where they made it and Save and Publish refuse it. An empty map (`{}`) declares nothing;
// the Definition writers leave it out of definition.yaml.

const declarationMap = (declaration) => (isPlainObject(declaration) ? declaration : {})

function withEntry(declaration, id, entry) {
  const next = { ...declarationMap(declaration) }
  if (entry === null) delete next[id]
  else next[id] = entry
  return next
}

/**
 * `declaration` with Instance setting `id`'s default set to `value`, or removed when `value` is blank
 * (no default: Size works to Medium, Classification to no marking). A Size declaration left with no
 * default declares nothing, so it goes rather than linger as `size: {}`.
 */
export function withInstanceSettingDefault(declaration, id, value) {
  const current = declarationMap(declaration)[id]
  const entry = isPlainObject(current) ? { ...current } : {}
  if (isBlank(value)) delete entry.default
  else entry.default = value
  return withEntry(declaration, id, id === 'size' && Object.keys(entry).length === 0 ? null : entry)
}

/** `declaration` without Instance setting `id`, so the Definition stops offering it (Size stays offered while any Field has word targets, at Medium). */
export function withoutInstanceSetting(declaration, id) {
  return withEntry(declaration, id, null)
}

/** The markings `declaration` lists for Classification, as typed — blanks and repeats included — or `null` when it doesn't declare Classification. */
export function classificationMarkings(declaration) {
  const entry = declarationMap(declaration).classification
  if (entry === undefined) return null
  return Array.isArray(entry?.choices) ? entry.choices : []
}

// `declaration` with Classification's markings replaced by `next(choices, entry)` — which returns the
// new list and, optionally, the new default — declaring Classification if it wasn't.
function withMarkings(declaration, next) {
  const current = declarationMap(declaration).classification
  const entry = isPlainObject(current) ? { ...current } : {}
  const result = next(Array.isArray(entry.choices) ? [...entry.choices] : [], entry)
  entry.choices = result.choices
  if ('default' in result) {
    if (isBlank(result.default)) delete entry.default
    else entry.default = result.default
  }
  return withEntry(declaration, 'classification', entry)
}

/** `declaration` with `marking` added at the end of Classification's markings, declaring Classification if it wasn't. */
export function withClassificationMarkingAdded(declaration, marking) {
  return withMarkings(declaration, (choices) => ({ choices: [...choices, marking] }))
}

/** `declaration` with the marking at `index` renamed to `marking`; a default that named the old marking follows it. */
export function withClassificationMarkingRenamed(declaration, index, marking) {
  return withMarkings(declaration, (choices, entry) => {
    const old = choices[index]
    choices[index] = marking
    return entry.default !== undefined && entry.default === old ? { choices, default: marking } : { choices }
  })
}

/** `declaration` without the marking at `index`; a default that named it goes too, leaving no default. */
export function withClassificationMarkingRemoved(declaration, index) {
  return withMarkings(declaration, (choices, entry) => {
    const [removed] = choices.splice(index, 1)
    return entry.default !== undefined && entry.default === removed && !choices.includes(removed) ? { choices, default: null } : { choices }
  })
}

/** `declaration` with the marking at `index` moved `offset` places (−1 up, +1 down), the order every surface offers them in; unchanged at either end. */
export function withClassificationMarkingMoved(declaration, index, offset) {
  return withMarkings(declaration, (choices) => {
    const to = index + offset
    if (to < 0 || to >= choices.length) return { choices }
    const [moved] = choices.splice(index, 1)
    choices.splice(to, 0, moved)
    return { choices }
  })
}
