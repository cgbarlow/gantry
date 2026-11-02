// #288 (map #238, docs/adr/0064): how a Stage's **decisions log** is shown. `DecisionsLogPanel` is the read-only panel in the Instance
// editor: the latest answers, the open questions highlighted with "Resume to answer", and the whole history on request. The Interview
// rail uses `logSummary`'s count. The log never appears in a rendered Artefact and nothing here edits it.
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { logSummary } from './decisionsLog.js'

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const day = (iso) => String(iso ?? '').slice(0, 10)

const CHOICES = { keep: 'kept what was saved', replace: "replaced it with the AI's version", merge: 'merged the two' }
const HAND_CHOICES = { keep: 'kept their own edit', replace: "took the AI's version in place of their edit", merge: 'merged their edit and the AI’s version' }

const CHANGE_WORDS = { removed: 'removed', replaced: 'replaced', 're-extracted': 'read again with different text', changed: 'changed' }

/** A `source-update` entry (#298) as a sentence: what the architect decided for a Field that was Out of date, naming what triggered it. */
function describeSourceUpdate(entry, fieldTitle) {
  const field = asList(entry.fields).map(fieldTitle).join(', ') || 'a Field'
  const trigger = entry.inputField
    ? `${fieldTitle(entry.inputField)} changed`
    : `${entry.sourceTitle || entry.source} was ${CHANGE_WORDS[entry.change] ?? 'changed'}${entry.replacedBy ? ` by ${entry.replacedBy}` : ''}`
  switch (entry.outcome) {
    case 'keep':
      return `${field} kept as it is: ${trigger}`
    case 'redraft':
      return `${field} to be redrafted: ${trigger}`
    case 'redraft-without':
      return `${field} to be redrafted without ${entry.sourceTitle || entry.source}: ${trigger}`
    case 're-cite':
      return `${field} re-cited to ${entry.reciteTo || 'another document'}: ${trigger}`
    case 'open-question':
      return `${field} could not be changed here and is an open question: ${trigger}`
    default:
      return `${field}: ${trigger}`
  }
}

/** One entry as a sentence for a reader: the question and the answer, or what the architect said, or what was chosen. */
export function describeEntry(entry, { fieldTitle = (key) => key } = {}) {
  const fields = asList(entry.fields).map(fieldTitle)
  const feeds = fields.length ? ` (feeds ${fields.join(', ')})` : ''
  switch (entry.kind) {
    case 'answer': {
      const answer = asList(entry.answer).join(', ')
      const own = entry.words ? `${answer ? ' + ' : ''}in their own words: “${entry.words}”` : ''
      return `${entry.keyDecision ? 'Key decision: ' : ''}${entry.question ?? 'A question'} → ${answer}${own}${feeds}`
    }
    case 'term': {
      const avoid = asList(entry.avoid)
      const own = entry.words ? ' (their own wording)' : ''
      return `Prefer “${entry.preferred}”${own}${avoid.length ? `, avoid ${avoid.map((a) => `“${a}”`).join(', ')}` : ''}${feeds}`
    }
    case 'fact':
      return `The architect said: “${entry.words}”${feeds}`
    case 'hand-edit':
      return `The architect edited ${fieldTitle(entry.field)} by hand: “${entry.words}”`
    case 'saved-content':
      if (asList(entry.reapproves).length) {
        // #300: approved content, which a change sends back for approval with the Stage it was made on.
        const names = asList(entry.reapproves).map((s) => s.title ?? s.stageId).join(', ')
        const outcome = entry.choice === 'keep' ? 'kept the approved wording' : entry.choice === 'merge' ? 'merged the two, needing re-approval' : "replaced it with the AI's version, needing re-approval"
        return `Approved content in ${fieldTitle(entry.field)} (printed by ${names}): ${outcome}${entry.choice === 'keep' ? '' : ` of ${names} with this Stage`}`
      }
      if (entry.handEdit) return `Their own edit of ${fieldTitle(entry.field)}: ${HAND_CHOICES[entry.choice] ?? entry.choice}`
      return `Saved content in ${fieldTitle(entry.field)}: ${CHOICES[entry.choice] ?? entry.choice}`
    case 'open-question':
      return `${entry.question}${entry.why ? ` — ${entry.why}` : ''}${feeds}`
    case 'source-update':
      return describeSourceUpdate(entry, fieldTitle)
    case 'returned-to-draft':
      return entry.note ?? `${entry.module ?? 'A Module'} returned to draft`
    case 'artefact':
      return `Aimed for the ${entry.title ?? entry.artefact} Artefact`
    case 'restart':
      return 'Started this stage over'
    case 'model-change':
      return `Switched from ${entry.from?.model ?? 'a model'} to ${entry.to?.model ?? 'another'}`
    default:
      return entry.question ?? entry.words ?? entry.kind
  }
}

const KIND_LABELS = { term: 'Term', answer: 'Answer', fact: 'Architect', 'saved-content': 'Saved content', 'hand-edit': 'Hand edit', 'open-question': 'Open question', artefact: 'Artefact', restart: 'Restart', 'model-change': 'Model', 'source-update': 'Brought up to date', 'returned-to-draft': 'Returned to draft' }

function EntryRow({ entry, fieldTitle, state }) {
  return html`<li class=${'dl-entry' + (entry.kind === 'open-question' && state !== 'old' ? ' open' : '') + (state === 'old' ? ' old' : '')} data-testid="decisions-entry" data-entry-id=${entry.id} data-kind=${entry.kind} data-state=${state ?? 'current'}>
    <span class="dl-kind">${KIND_LABELS[entry.kind] ?? entry.kind}</span>
    <span class="dl-text">${describeEntry(entry, { fieldTitle })}</span>
    <span class="dl-meta">${[entry.who, day(entry.at)].filter(Boolean).join(' · ')}${entry.replaces ? ' · replaces an earlier entry' : ''}${entry.resolves ? ' · closes an open question' : ''}</span>
  </li>`
}

/**
 * Props: `log` (the Stage's committed log, or null while it loads), `stageTitle`, `resumeHref` (where "Resume to answer" goes, or
 * '' when the Interview cannot be opened), `fieldTitle(key)`.
 */
export function DecisionsLogPanel({ log, stageTitle = '', resumeHref = '', fieldTitle = (key) => key }) {
  const [history, setHistory] = useState(false)
  if (!log) return null
  const summary = logSummary(log)
  if (summary.total === 0) return null
  const standing = new Set([...summary.latest, ...summary.open].map((e) => e.id))
  return html`<section class="decisions-log-panel" data-testid="decisions-log-panel" aria-label="Decisions log">
    <h2>Decisions log${stageTitle ? html` <span class="dl-stage">· ${stageTitle}</span>` : null} <span class="dl-count" data-testid="decisions-log-count">${summary.count}</span></h2>
    <p class="dl-note">What was decided in the AI interview, kept with this Stage. It is read-only and never printed in a document.</p>
    ${summary.open.length
      ? html`<div class="dl-open" data-testid="decisions-open">
          <h3>Open questions (${summary.open.length})</h3>
          <ul>${summary.open.map((e) => html`<${EntryRow} key=${e.id} entry=${e} fieldTitle=${fieldTitle} />`)}</ul>
          ${resumeHref ? html`<a class="btn small" href=${resumeHref} data-testid="decisions-resume">Resume to answer</a>` : null}
        </div>`
      : null}
    <h3>Latest answers</h3>
    ${summary.latest.length ? html`<ul class="dl-list" data-testid="decisions-latest">${summary.latest.map((e) => html`<${EntryRow} key=${e.id} entry=${e} fieldTitle=${fieldTitle} />`)}</ul>` : html`<p class="dl-note">Nothing answered yet.</p>`}
    <button type="button" class="btn small ghost" data-testid="decisions-history-toggle" aria-expanded=${history} onClick=${() => setHistory(!history)}>
      ${history ? 'Hide history' : `Show history (${summary.total} entr${summary.total === 1 ? 'y' : 'ies'})`}
    </button>
    ${history
      ? html`<ul class="dl-list dl-history" data-testid="decisions-history">${summary.history.map((e) => html`<${EntryRow} key=${e.id} entry=${e} fieldTitle=${fieldTitle} state=${standing.has(e.id) ? 'current' : 'old'} />`)}</ul>`
      : null}
  </section>`
}
