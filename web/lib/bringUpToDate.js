// #298 (parent #238, decided in #249; docs/adr/0063, 0064, 0066, 0069): **Bring up to date**. A round of question cards about exactly the Fields
// flagged Out of date (web/lib/outOfDate.js), asked at the start of a session or on its own from the editor's banner. This file is the pure
// part of it, with no DOM and no network:
//
//   * `planUpdateRound`  which flagged Fields the Interview page on a Stage can act on, and where each change would land: in place, on the
//                        Stage's own branch (a Stage awaiting approval), carried forward from an approved Stage to the current one, offered as
//                        a re-open (ADR-0026), or an open question naming the blocker. A Field on a drafted-ahead Stage is never touched.
//   * `stagesToUpdate`   the Stages that have something to bring up to date, in order, which "Bring up to date" works through stage by stage.
//   * `updateCards`      one card per Field: keep / redraft for a changed or replaced document, keep / re-cite / redraft without it for a
//                        removed one, and a card that says why for a Field that cannot be changed from here.
//   * `resolveUpdateCard`, `updateAnswersText`  what an answer means, and what the AI is told.
//   * `isStaleUpdateSession`, `checkingFlagsNote`  (#357) that the page always has something to do: a session left with nothing open or unsaved
//                        starts afresh, and while the flags are worked out the kickoff says so rather than that nothing is Out of date.
//   * `roundPlanRows`    (#358) the run plan in Bring up to date: the Stages it works through, each with its count, the one on screen marked
//                        current, in place of the normal run's target and the Stages struck through beyond it.
//
// Only answering a card clears a flag (a `source-update` entry in the decisions log, see web/lib/interviewLog.js `addSourceUpdate`). Redrafting
// saved content still goes through keep / use the AI's version / merge (web/lib/interviewSession.js), and an accepted change to an `agreed`
// Module returns it to `draft` with a note (`returnedToDraftNote`).
import { fieldsInScope } from './interviewScope.js'
import { normalizeSavedContent } from './interviewBrief.js'
import { citedSourceIds, recitedMarkdown } from './sourceCitations.js'
import { isRemovedSource, replacedByMap } from './sourceDocuments.js'
import { codeChangeReason } from './outOfDate.js'

/** The labels of the choices on a Bring up to date card. A re-cite choice is `Re-cite to <title>` and a re-open choice `Re-open <Stage>`. */
export const UPDATE_CHOICES = Object.freeze({
  keep: 'Keep',
  redraft: 'Redraft',
  without: 'Redraft without it',
  openQuestion: 'Log an open question',
  leave: 'Leave it flagged',
})

const RECITE_PREFIX = 'Re-cite to '
const REOPEN_PREFIX = 'Re-open '

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()
const unique = (list) => [...new Set(list.filter(Boolean))]

// ---------- where a change lands ----------

/**
 * Whether a signed-off Stage can be re-opened (ADR-0026), judged from what the page knows; the server has the last word and says so if it
 * refuses. Only the Stage just before the current one can be, and only while no Stage after it has a branch (`inProgress`: the ids of Stages
 * known to be started, such as one with a Pull Request open or a decisions log that has saved).
 *
 * @returns {{ allowed: boolean, blocker: string }}
 */
export function reopenOutlook({ stages = [], currentStageId, targetId, inProgress = [] }) {
  const at = stages.findIndex((s) => s.id === targetId)
  const current = stages.findIndex((s) => s.id === currentStageId)
  const title = (i) => stages[i]?.title ?? stages[i]?.id ?? ''
  if (at === -1 || current === -1 || at >= current) return { allowed: false, blocker: `${title(at) || targetId} cannot be re-opened.` }
  const started = new Set(inProgress)
  for (let i = at + 1; i < stages.length; i++) {
    if (started.has(stages[i].id)) return { allowed: false, blocker: `${title(i)} is already in progress, and a Stage cannot be re-opened while a later one is (ADR-0026).` }
  }
  if (current - at > 1) return { allowed: false, blocker: `${title(at + 1)} is already in progress, and only the Stage just before the current one can be re-opened (ADR-0026).` }
  return { allowed: true, blocker: '' }
}

const stageIndexOf = (definition) => {
  const ids = (definition?.stages ?? []).map((s) => s.id)
  return (id) => ids.indexOf(id)
}

/** The Stages that mount `moduleId`, in order, with whether they can edit it. */
function mountsOf(definition, moduleId) {
  return (definition?.stages ?? [])
    .filter((s) => asList(s.modules).includes(moduleId))
    .map((s) => ({ stageId: s.id, editable: !asList(s.readOnlyModules).includes(moduleId) }))
}

/** The first Stage where `moduleId` can be edited, or null. */
const firstEditableStage = (definition, moduleId) => mountsOf(definition, moduleId).find((m) => m.editable)?.stageId ?? null

function groupFlags(flags) {
  const groups = new Map()
  for (const flag of asList(flags)) {
    const list = groups.get(flag.field) ?? []
    list.push(flag)
    groups.set(flag.field, list)
  }
  return groups
}

/** The Stages a flagged Field belongs to, earliest first: those that drafted it or cite it, else those that mount its Module. */
function homeStagesOf(flags, definition, moduleId) {
  const indexOf = stageIndexOf(definition)
  const named = unique(flags.flatMap((f) => asList(f.stages))).filter((id) => indexOf(id) !== -1)
  const homes = named.length ? named : mountsOf(definition, moduleId).map((m) => m.stageId)
  return homes.sort((a, b) => indexOf(a) - indexOf(b))
}

/**
 * Which flagged Fields the Interview page on `pageStageId` brings up to date, and where each change would land.
 *
 * @param {object} input
 * @param {object[]} input.flags  `findOutOfDateFields`' result for the Instance
 * @param {object} input.definition  the Definition as the Interview page holds it (`stages`, `modules`)
 * @param {string} input.pageStageId  the Stage the page is on (the current Stage, on a remote workspace)
 * @param {string} [input.currentStageId]  the Instance's current Stage
 * @param {boolean} [input.remote]  an Azure DevOps or GitHub workspace, where a Stage moves on only when its Pull Request merges
 * @param {string[]} [input.awaiting]  Stages with a Pull Request open
 * @param {string[]} [input.inProgress]  Stages known to be started (a branch exists), for the re-open check
 * @param {object[]|object} [input.saved]  the saved content of every Module
 * @param {boolean} [input.staleLater]  (#299) the flags are Fields of a drafted-ahead Stage drafted from content an earlier Stage's revision changed: the Fields no pending Stage holds are asked about, on the Stage's own branch
 * @returns {{
 *   items: { key: string, flags: object[], homes: string[], saved: string, landing: { kind: 'in-place'|'own-branch'|'carry-forward'|'reopen'|'open-question', stageId?: string, blocker?: string } }[],
 *   deferred: { key: string, stageId: string }[],
 *   elsewhere: { key: string, stageId: string|null }[]
 * }}
 *   `items` are the Fields to ask about, earliest Stage first. `deferred` are Fields of a drafted-ahead Stage: left flagged and never written.
 *   `elsewhere` (local and server workspaces) are Fields whose Module is edited on another Stage: they are asked about when the page is on it.
 */
export function planUpdateRound({ flags = [], definition, pageStageId, currentStageId = pageStageId, remote = false, awaiting = [], inProgress = [], saved = [], staleLater = false } = {}) {
  const indexOf = stageIndexOf(definition)
  const stages = definition?.stages ?? []
  const pageAt = indexOf(pageStageId)
  const scope = fieldsInScope(definition, pageStageId)
  const content = normalizeSavedContent(saved)
  const items = []
  const deferred = []
  const elsewhere = []
  // A page on a drafted-ahead Stage (after the current one) never changes anything: its branch is never written (ADR-0063).
  if (remote && pageAt > indexOf(currentStageId)) {
    for (const [key, list] of groupFlags(flags)) {
      if (!scope.has(key)) continue
      // #299: a Field drafted from an earlier Field that has since changed is a Field of this Stage's own: it is asked about here, and any change
      // lands on this Stage's own branch. Anything else (a Source document's change) waits until the Stage is current.
      if (staleLater && list.every((f) => f.cause === 'field')) {
        const moduleId = key.split('.')[0]
        const fieldId = key.split('.').slice(1).join('.')
        items.push({ key, flags: list, homes: homeStagesOf(list, definition, moduleId), saved: asText(normalizeSavedContent(saved)[moduleId]?.fields?.[fieldId]), landing: { kind: 'in-place' } })
      } else deferred.push({ key, stageId: pageStageId })
    }
    items.sort((a, b) => a.key.localeCompare(b.key))
    return { items, deferred, elsewhere }
  }
  for (const [key, list] of groupFlags(flags)) {
    const moduleId = key.split('.')[0]
    const fieldId = key.split('.').slice(1).join('.')
    const homes = homeStagesOf(list, definition, moduleId)
    const savedText = asText(content[moduleId]?.fields?.[fieldId])
    if (scope.has(key)) {
      let landing = { kind: 'in-place' }
      if (remote) {
        const approvedHomes = homes.length > 0 && homes.every((h) => indexOf(h) < pageAt)
        if (approvedHomes) landing = { kind: 'carry-forward', stageId: homes[homes.length - 1], awaiting: awaiting.includes(pageStageId) }
        else if (awaiting.includes(pageStageId)) landing = { kind: 'own-branch', stageId: pageStageId }
      }
      items.push({ key, flags: list, homes, saved: savedText, landing })
      continue
    }
    if (!remote) {
      elsewhere.push({ key, stageId: firstEditableStage(definition, moduleId) ?? homes[0] ?? null })
      continue
    }
    if (homes.length > 0 && homes.every((h) => indexOf(h) > pageAt)) {
      deferred.push({ key, stageId: homes[0] })
      continue
    }
    const target = homes.filter((h) => indexOf(h) < pageAt).pop() ?? homes[0] ?? null
    const outlook = target
      ? reopenOutlook({ stages, currentStageId, targetId: target, inProgress })
      : { allowed: false, blocker: `${moduleId} cannot be edited on ${stages[pageAt]?.title ?? pageStageId}.` }
    items.push({ key, flags: list, homes, saved: savedText, landing: { kind: outlook.allowed ? 'reopen' : 'open-question', stageId: target, blocker: outlook.blocker } })
  }
  items.sort((a, b) => indexOf(a.homes[0] ?? '') - indexOf(b.homes[0] ?? '') || a.key.localeCompare(b.key))
  return { items, deferred, elsewhere }
}

/**
 * The Stages that have something to bring up to date, in Stage order: `[{ stageId, count }]`. "Bring up to date" works through them stage by
 * stage. On a local or server workspace each Field is asked about on the first Stage where its Module is edited. On a remote workspace only the
 * current Stage's branch can be written, so everything is asked on the current Stage (its card says where the change lands).
 */
export function stagesToUpdate({ flags = [], definition, remote = false, currentStageId }) {
  const indexOf = stageIndexOf(definition)
  const counts = new Map()
  for (const [key, list] of groupFlags(flags)) {
    const moduleId = key.split('.')[0]
    const homes = homeStagesOf(list, definition, moduleId)
    const stageId = remote ? currentStageId : firstEditableStage(definition, moduleId) ?? homes[0] ?? currentStageId
    if (!stageId) continue
    counts.set(stageId, (counts.get(stageId) ?? 0) + 1)
  }
  return [...counts].map(([stageId, count]) => ({ stageId, count })).sort((a, b) => indexOf(a.stageId) - indexOf(b.stageId))
}

// ---------- the cards ----------

/** One flag as a short clause, e.g. `Client brief was replaced by Client brief v3`. */
export function flagReason(flag, fieldTitle = (key) => key) {
  if (flag.cause !== 'source') return `${fieldTitle(flag.inputField)} has changed since this was drafted`
  if (flag.change === 'removed') return `${flag.sourceTitle} was removed`
  if (flag.change === 'replaced') return `${flag.sourceTitle} was replaced${flag.replacedBy ? ` by ${flag.replacedBy.title}` : ''}`
  if (flag.change === 'code-changed') return codeChangeReason(flag)
  return `${flag.sourceTitle} was read again with different text`
}

/** The sentence under a card that says where the change would land (a remote workspace), or ''. */
export function landingNote(landing, { stageTitle = (id) => id, currentTitle = '' } = {}) {
  if (landing.kind === 'own-branch') return `${stageTitle(landing.stageId)} is awaiting approval. A change is saved on its own branch and updates its Pull Request.`
  if (landing.kind === 'carry-forward') {
    return `${stageTitle(landing.stageId)} is approved. A change is carried forward: it is made on ${currentTitle}, where this Module can be edited, and it changes approved content, so it is re-approved with ${currentTitle}.${landing.awaiting ? ` ${currentTitle} is awaiting approval, so the change is saved on its branch and updates its Pull Request.` : ''}`
  }
  return ''
}

/**
 * The Source documents that can stand behind a Field whose own document was removed, in the order to offer them: the document that replaced
 * it, then any other live document the Field already drew on or cites, then (up to `limit`) the rest. `supported` is true for those first two kinds: another
 * document backs the content, which is what pre-selects a re-cite.
 */
export function reciteCandidates({ item, sources = [], logs = {}, removedId, limit = 4 }) {
  const live = sources.filter((s) => !isRemovedSource(s) && s.id !== removedId)
  const byId = new Map(live.map((s) => [s.id, s]))
  const replaced = replacedByMap(sources)
  const successor = replaced.get(removedId)
  const drewOn = new Set()
  for (const log of Object.values(logs ?? {})) for (const input of asList(log?.fields?.[item.key]?.inputs)) if (typeof input?.source === 'string') drewOn.add(input.source)
  for (const id of citedSourceIds(item.saved)) drewOn.add(id)
  const supporting = unique([successor?.id, ...drewOn]).filter((id) => byId.has(id) && id !== removedId)
  // A document that a newer one has replaced is not offered as a stand-in unless the Field already stands on it.
  const rest = live.filter((s) => !supporting.includes(s.id) && !replaced.has(s.id)).sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)))
  const entry = (s, supported) => ({ id: s.id, title: s.title || s.filename || s.id, supported })
  return [...supporting.map((id) => entry(byId.get(id), true)), ...rest.map((s) => entry(s, false))].slice(0, Math.max(limit, supporting.length))
}

const sourceChip = (flag) => (flag?.cause === 'source' ? { document: flag.source, title: flag.sourceTitle, location: null } : null)

/**
 * The cards of the round, one per Field in `items` (from `planUpdateRound`), ready for the Interview page: `type: 'update'`, a recommendation
 * pre-selected, no "Other". Each card's `update` holds what answering it means.
 */
export function updateCards({ items = [], sources = [], logs = {}, fieldTitle = (key) => key, stageTitle = (id) => id, pageStageTitle = '' } = {}) {
  return items.map((item) => {
    const title = fieldTitle(item.key)
    const reasons = unique(item.flags.map((f) => flagReason(f, fieldTitle)))
    const removedFlag = item.flags.find((f) => f.cause === 'source' && f.change === 'removed')
    const blocked = item.landing.kind === 'reopen' || item.landing.kind === 'open-question'
    const fieldOnly = item.flags.every((f) => f.cause !== 'source')
    const kind = blocked ? 'blocked' : removedFlag ? 'removed' : 'changed'
    let options
    let recommended
    let why
    let recite = []
    if (kind === 'blocked') {
      const stage = stageTitle(item.landing.stageId)
      const open = { label: UPDATE_CHOICES.openQuestion, description: `Record it as an open question naming what stops the change: ${item.landing.blocker || 'nothing in this Stage can edit it'} The Field stays as it is.` }
      if (item.landing.kind === 'reopen') {
        options = [
          { label: `${REOPEN_PREFIX}${stage}`, description: `Re-open ${stage} (a new branch from main), so the change can be made there and approved again. You confirm at the end of the round; re-opening drops the round's other unsaved answers, and the Field stays flagged until then.` },
          open,
        ]
        recommended = [options[0].label]
        why = `${stage} is approved and ${title} cannot be edited on ${pageStageTitle}, but Gantry allows ${stage} to be re-opened.`
      } else {
        options = [open, { label: UPDATE_CHOICES.leave, description: 'Change nothing and write nothing. The Field stays flagged.' }]
        recommended = [open.label]
        why = item.landing.blocker || `${title} cannot be edited on ${pageStageTitle}.`
      }
    } else if (kind === 'removed') {
      recite = reciteCandidates({ item, sources, logs, removedId: removedFlag.source }).map((c) => ({ ...c, label: `${RECITE_PREFIX}${c.title}` }))
      const supported = recite.find((c) => c.supported)
      options = [
        { label: UPDATE_CHOICES.keep, description: `Leave the text as it is. The citation stays and shows "removed".` },
        ...recite.map((c) => ({
          label: c.label,
          description: c.supported ? `${c.title} supports this. Gantry points the citation at it instead of ${removedFlag.sourceTitle}.` : `Point the citation at ${c.title} instead of ${removedFlag.sourceTitle}. Only if it really says the same.`,
        })),
        { label: UPDATE_CHOICES.without, description: `The AI redrafts the Field without ${removedFlag.sourceTitle}. You see its version before anything is saved.` },
      ]
      recommended = [supported ? supported.label : UPDATE_CHOICES.without]
      why = supported ? `${supported.title} already supports this Field, so re-citing keeps the text and its backing.` : `No other document is known to support this Field, so redrafting without ${removedFlag.sourceTitle} is the honest default.`
    } else {
      options = [
        { label: UPDATE_CHOICES.keep, description: fieldOnly ? 'It still holds. Leave it exactly as it is.' : 'It still holds. Leave it exactly as it is, and note that you checked.' },
        { label: UPDATE_CHOICES.redraft, description: 'The AI redrafts it from the documents as they are now. You see its version before anything is saved, and choose to keep what is saved, use its version, or merge.' },
      ]
      recommended = [fieldOnly ? UPDATE_CHOICES.keep : UPDATE_CHOICES.redraft]
      why = fieldOnly ? 'Many changes to an earlier Field do not reach the Fields that read it, so keeping it is the safe default.' : 'The document it drew on is not the one the text was written from.'
    }
    const note = landingNote(item.landing, { stageTitle, currentTitle: pageStageTitle })
    return {
      id: `update:${item.key}`,
      type: 'update',
      kind: 'update',
      header: kind === 'blocked' ? 'Out of date · cannot change here' : 'Out of date',
      question: `${title}: ${reasons.join('; ')}. ${kind === 'blocked' ? 'It cannot be changed from here. What should happen?' : 'What should happen to it?'}`,
      options,
      multiSelect: false,
      recommended,
      why,
      source: sourceChip(removedFlag ?? item.flags.find((f) => f.cause === 'source')),
      field: item.key,
      allowOther: false,
      selected: [...recommended],
      otherOn: false,
      otherText: '',
      update: {
        field: item.key,
        kind,
        landing: item.landing,
        note,
        saved: item.saved,
        reasons,
        recite: recite.map(({ id, title: t, label }) => ({ id, title: t, label })),
        flags: item.flags.map((f) =>
          f.cause === 'source'
            ? { cause: 'source', source: f.source, sourceTitle: f.sourceTitle, change: f.change, since: f.since, replacedBy: f.replacedBy?.title ?? null, ...(f.paths ? { paths: f.paths, head: f.head } : {}) }
            : { cause: 'field', inputField: f.inputField, change: f.change }
        ),
      },
    }
  })
}

// ---------- what an answer means ----------

/**
 * The outcome of one answered card: `{ key, outcome, reciteTo?, stageId?, card }`, where `outcome` is `keep`, `redraft`, `redraft-without`,
 * `re-cite`, `open-question`, `reopen` (re-open the Stage once the round is saved) or `leave` (nothing is written and the flag stays).
 */
export function resolveUpdateCard(card) {
  const chosen = card.selected[0]
  const base = { key: card.field, card }
  if (chosen === UPDATE_CHOICES.keep) return { ...base, outcome: 'keep' }
  if (chosen === UPDATE_CHOICES.redraft) return { ...base, outcome: 'redraft' }
  if (chosen === UPDATE_CHOICES.without) return { ...base, outcome: 'redraft-without' }
  if (chosen === UPDATE_CHOICES.openQuestion) return { ...base, outcome: 'open-question' }
  if (chosen === UPDATE_CHOICES.leave) return { ...base, outcome: 'leave' }
  const recite = card.update?.recite?.find((c) => c.label === chosen)
  if (recite) return { ...base, outcome: 're-cite', reciteTo: { id: recite.id, title: recite.title } }
  if (typeof chosen === 'string' && chosen.startsWith(REOPEN_PREFIX)) return { ...base, outcome: 'reopen', stageId: card.update?.landing?.stageId }
  return { ...base, outcome: 'leave' }
}

/** `value` (text, or a list of items) with every citation of `fromId` pointing at `to` (`{ id, title }`) instead. */
export function reciteValue(value, fromId, to) {
  if (Array.isArray(value)) return value.map((item) => recitedMarkdown(String(item), fromId, to))
  return recitedMarkdown(String(value ?? ''), fromId, to)
}

/** The Source documents whose removal a card's flags report: the ones a re-cite moves the citations away from. */
export const removedSourcesOf = (card) => unique(asList(card.update?.flags).filter((f) => f.cause === 'source' && f.change === 'removed').map((f) => f.source))

/**
 * What the AI is told after the round: the Fields to redraft (and from what), the ones kept, the ones re-cited by Gantry and the ones that
 * stay as they are. `results` are `resolveUpdateCard`'s.
 */
export function updateAnswersText(results, { fieldTitle = (key) => key } = {}) {
  const lines = []
  for (const r of results) {
    const title = fieldTitle(r.key)
    const why = unique(asList(r.card.update?.reasons)).join('; ')
    if (r.outcome === 'redraft') {
      lines.push(`- ${r.key} (${title}): REDRAFT. ${why}. Read the Source documents as they are now and redraft this Field with draft_field. It holds saved content, so Gantry shows the architect a keep / use your version / merge card; do not draft it again until they have answered.`)
    } else if (r.outcome === 'redraft-without') {
      const gone = removedSourcesOf(r.card)
      lines.push(`- ${r.key} (${title}): REDRAFT WITHOUT ${gone.map((id) => `source:${id}`).join(', ') || 'the removed document'}. ${why}. Redraft the Field so it does not cite or rely on ${gone.length > 1 ? 'them' : 'it'}; keep only what the other documents or the architect's own facts support. Gantry shows the architect a keep / use your version / merge card.`)
    } else if (r.outcome === 're-cite') {
      lines.push(`- ${r.key} (${title}): RE-CITED by Gantry to ${r.reciteTo.title}. Nothing for you to do.`)
    } else if (r.outcome === 'keep') {
      lines.push(`- ${r.key} (${title}): KEPT as it is. Do not propose a change to it.`)
    } else if (r.outcome === 'open-question' || r.outcome === 'reopen' || r.outcome === 'leave') {
      lines.push(`- ${r.key} (${title}): cannot be changed on this Stage. Leave it alone.`)
    }
  }
  return lines.join('\n')
}

/** True when an answered card needs the AI to write something. */
export const needsAi = (result) => result.outcome === 'redraft' || result.outcome === 'redraft-without'

/** What the AI is told to begin a session that is only bringing Fields up to date. */
export const UPDATE_OPENING =
  'Bring the Out of date Fields up to date. A Source document, or an earlier Field, that some Fields were drafted from has changed since, and Gantry flagged those Fields. ' +
  'The architect has been shown a card for each flagged Field, and their answers are below. Work only on the Fields they chose to redraft. ' +
  'Do not begin the interview, do not read the Source documents for anything else, and do not ask about anything else; when the redrafts are done, say so in one line.'

/** The line added to the start of a normal session when Source documents are New since last interview. */
export function newSinceNote(documents) {
  const list = asList(documents).filter(Boolean)
  if (!list.length) return ''
  const names = list.map((d) => `"${d.title || d.filename || d.id}"`).join(', ')
  return (
    `New since the last interview: ${names}. ${list.length === 1 ? 'This document was' : 'These documents were'} added after the last AI interview saved anything and ${list.length === 1 ? 'has' : 'have'} not been read against what is saved. ` +
    'Read them against the saved content and the decisions log. Ask a card only where a document adds to or contradicts something already saved; where it adds nothing new, say so in one line and carry on.'
  )
}

/** The note kept when a Module marked `agreed` goes back to `draft` because a change to it is saved. */
export function returnedToDraftNote({ moduleTitle, fieldTitles = [], cause = '' }) {
  const fields = fieldTitles.length ? ` The change is to ${fieldTitles.join(', ')}${cause ? `, ${cause}` : ''}.` : ''
  return `${moduleTitle} was agreed and is back to draft.${fields} Only a person marks a Module agreed, so it needs to be agreed again.`
}

/** The first Stage, in Stage order, that a flagged Field belongs to: where "Bring up to date" from the editor's banner begins. Null when nothing names one. */
export function firstFlaggedStage(flags, stageIds) {
  const order = asList(stageIds)
  return (
    asList(flags)
      .flatMap((f) => asList(f.stages))
      .filter((id) => order.includes(id))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? null
  )
}

/**
 * #357: whether a Bring up to date session the Interview page finds (still in this tab, or restored from the browser's working copy) is stale:
 * it has nothing open (no round of cards, no keep / use / merge card), the AI is not at work on it, and no answer or draft waits to be saved.
 * A stale session would leave the page with nothing to press, so the page drops it and starts afresh at the kickoff, from the flags as they
 * are now. One that is still at its kickoff is not stale: it is already fresh.
 */
export function isStaleUpdateSession(snapshot) {
  if (!snapshot || snapshot.phase === 'kickoff') return false
  if (snapshot.round || snapshot.clash) return false
  if (['working', 'testing', 'asking', 'error'].includes(snapshot.phase)) return false
  // Answers waiting for "Save the round?": that card is there to press. Without an answered round, the card isn't shown, so nothing is.
  const unsaved = (snapshot.decisions?.pending ?? 0) > 0 || Object.keys(snapshot.drafts ?? {}).length > 0
  return !(snapshot.update?.answered && unsaved)
}

/**
 * #357: what the Bring up to date kickoff says while the flags for its Stage are still being worked out, in place of a count (or of "Nothing
 * on <Stage> is Out of date", which isn't known yet). A code repository is compared by the Gantry server, which can take a while, so it is named.
 * `rereadingInstance`: the flags are in, and an Azure DevOps or GitHub workspace's Instance is being read again (whether its current Stage has
 * a branch decides where each change can be saved, ADR-0026), so that is what it says, not that a repository is being compared.
 */
export function checkingFlagsNote(stageTitle, repositories = [], { rereadingInstance = false } = {}) {
  if (rereadingInstance) return `Checking where the changes to the Out of date Fields on ${stageTitle} would be saved: reading the Instance again…`
  const names = asList(repositories).filter(Boolean)
  const base = `Checking which Fields on ${stageTitle} are Out of date`
  if (!names.length) return `${base}…`
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${base}: the Gantry server is comparing the files they drew on in ${list} with ${names.length === 1 ? 'its branch' : 'their branches'} now…`
}

// ---------- the run plan (#358) ----------

// What a row of the run plan says in a round: the Stage on screen, a Stage still to work through, and the Stage on screen with nothing to do.
// Review comments (#303) work through Stages the same way, so they have the same plan in their own words.
const ROUND_WORDS = Object.freeze({
  update: Object.freeze({ current: 'bringing up to date', toDo: 'to bring up to date', none: 'nothing Out of date' }),
  review: Object.freeze({ current: 'working through comments', toDo: 'comments to work through', none: 'no comments here' }),
})
// A Provider's word about a Stage (#295) is a fact whatever the page is doing, so a row that says it keeps it.
const PROVIDER_STATES = new Set(['awaiting-approval', 'approval-queued'])
const providerNote = (row) => row.note.replace(/ · target$/, '')

/**
 * #358: the run plan while the page brings Fields up to date. Bring up to date is not a run: it has no target, and it works through every
 * Stage with Out of date Fields in order, so the rows say that instead of the normal run's "target" and the Stages struck through after it.
 *
 * @param {object} input
 * @param {object[]} input.rows  the normal run plan (web/lib/interviewRun.js `planRows`), whose Pull Request links and Check status are kept.
 *   The page builds it aimed at the last Stage (a round has no target of its own), so a later Stage the Provider queued is not struck through.
 * @param {string} input.pageStageId  the Stage on screen, marked `current`
 * @param {{stageId: string, count: number}[]} [input.toDo]  `stagesToUpdate`, the page's own Stage included: each is `to-do` with its count
 * @param {boolean} [input.saved]  the page's round has been saved, so its Stage is `done` (a Field left flagged on purpose still counts)
 * @param {string[]} [input.done]  the Stages whose round was saved earlier in this round: `done`, unless flagged again since
 * @param {boolean} [input.checking]  what the page's Stage has to do is not known yet: the Definition, the Out of date check (#357) or the
 *   Reviewed copies are still loading. Its row says it is checking, never that it has nothing, and is not taken as done from an earlier save.
 * @param {'update'|'review'} [input.words]
 * @returns {object[]} the rows, each with `count` and `target: false`. A row in none of these is `plain` with no note, unless the Provider
 *   says it is awaiting approval or queued for it. The page's own row says that too, after what the page is doing.
 */
export function roundPlanRows({ rows, pageStageId, toDo = [], saved = false, done = [], checking = false, words = 'update' }) {
  const say = ROUND_WORDS[words] ?? ROUND_WORDS.update
  const counts = new Map(toDo.map((st) => [st.stageId, st.count]))
  const doneHere = new Set(done)
  return (rows ?? []).map((row) => {
    const count = counts.get(row.id) ?? 0
    let state
    let note
    if (row.id === pageStageId) {
      state = saved || (!checking && !count && doneHere.has(row.id)) ? 'done' : 'current'
      note = state === 'done' ? 'done' : checking ? 'checking…' : count ? say.current : say.none
      // The Stage on screen may be awaiting approval (an Azure DevOps or GitHub workspace): it still is, whatever the round does, and its row
      // keeps its Pull Request link and Check status, so it says so too.
      if (PROVIDER_STATES.has(row.state)) note = `${note} · ${providerNote(row)}`
    } else if (count) [state, note] = ['to-do', say.toDo]
    else if (doneHere.has(row.id)) [state, note] = ['done', 'done']
    else if (PROVIDER_STATES.has(row.state)) [state, note] = [row.state, providerNote(row)]
    else [state, note] = ['plain', '']
    return { ...row, state, note, count, target: false }
  })
}
