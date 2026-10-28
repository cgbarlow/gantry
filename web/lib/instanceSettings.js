// #219 (spec #223, docs/adr/0058): an Instance's **Instance settings** — the per-Instance choices its
// Definition declares, each as its choices plus an optional default. This is the one description of
// them every surface reads: the "+ New Workspace" wizard, Instance Settings, the Definitions page
// (server and Local Workspace), Instance creation, the settings write path and `GET /api/instance`
// (and so MCP `get_instance`). None of those hard-codes a setting; adding one is a new entry in
// `MEMBERS` below plus whatever reads its value (such as the render).
//
// Target size (ADR-0054) is the first member. Assignee and Required reviewer are not members: they
// are about people, the Definition doesn't declare them, and they keep their own routes (ADR-0058 §9).
//
// Pure and dependency-free, like web/lib/targetSize.js, so `lib/` imports it directly. A `definition`
// here is anything with `{ id, version, modules }` — a loaded Definition (`modules` a `Map`) or a
// version projection (`modules` an array) — so the server and the browser describe it identically.

import { TARGET_SIZES, DEFAULT_TARGET_SIZE, targetSizeLabel, targetWordsFieldCount } from './targetSize.js'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Each member Gantry knows, in the order every surface shows them. `offeredBecause` is why the
// Definition offers it (shown on the Definitions page), or `null` when it doesn't, in which case the
// setting appears nowhere and storing it is refused. `fixedChoices` means Gantry, not the
// Definition, owns the choices, so a value outside them is refused even where it isn't offered.
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
    // ADR-0058 §4: the Definition's default once it can declare one (#221); Medium until then.
    defaultValue: () => DEFAULT_TARGET_SIZE,
    unknownValueMessage: (value) =>
      `Unknown size ${JSON.stringify(value)} — choose ${TARGET_SIZES.slice(0, -1).join(', ')} or ${TARGET_SIZES.at(-1)}`,
    notOfferedMessage: (definition) =>
      `Definition "${definition?.id}" v${definition?.version ?? 1} declares no target-words, so its instances have no size`,
  },
]

/** The id of every Instance setting Gantry knows, whether or not a given Definition offers it. */
export const INSTANCE_SETTING_IDS = MEMBERS.map((member) => member.id)

const memberById = (id) => MEMBERS.find((member) => member.id === id)

function describe(member, definition) {
  const offeredBecause = member.offeredBecause(definition)
  if (!offeredBecause) return null
  return {
    id: member.id,
    label: member.label,
    name: member.name,
    guidance: member.guidance,
    choices: member.choices(definition),
    default: member.defaultValue(definition),
    fixedChoices: member.fixedChoices,
    offeredBecause,
  }
}

/**
 * The Instance settings `definition` offers, in display order: each `{ id, label, name, guidance,
 * choices: [{ value, label }], default, fixedChoices, offeredBecause }`. Empty for a Definition that
 * offers none (design v1/v2, recruitment-onboarding), which every surface then shows nothing for.
 */
export function definitionInstanceSettings(definition) {
  return MEMBERS.map((member) => describe(member, definition)).filter(Boolean)
}

const isBlank = (value) => value === undefined || value === null || value === ''

/** `setting`'s effective value for an Instance that stores `stored`: the stored value when it is one of the choices, else the default. */
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
  if (choices && !choices.some((choice) => choice.value === value)) return member.unknownValueMessage(value)
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
