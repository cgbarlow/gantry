// #288 (map #238, docs/adr/0064): how a Stage's **decisions log** is shown. `DecisionsLogPanel` is the read-only panel in the Instance
// editor: the latest answers, the open questions highlighted with "Resume to answer", and the whole history on request. The Interview
// rail uses `logSummary`'s count. The log never appears in a rendered Artefact and nothing here edits it.
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { logSummary } from './decisionsLog.js'

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const day = (iso) => String(iso ?? '').slice(0, 10)

const CHOICES = { keep: 'kept what was saved', replace: "replaced it with the AI's version", merge: 'merged the two' }

/** One entry as a sentence for a reader: the question and the answer, or what the architect said, or what was chosen. */
export function describeEntry(entry, { fieldTitle = (key) => key } = {}) {
  const fields = asList(entry.fields).map(fieldTitle)
  const feeds = fields.length ? ` (feeds ${fields.join(', ')})` : ''
  switch (entry.kind) {
    case 'answer': {
      const answer = asList(entry.answer).join(', ')
      const own = entry.words ? `${answer ? ' + ' : ''}in their own words: “${entry.words}”` : ''
      return `${entry.question ?? 'A question'} → ${answer}${own}${feeds}`
    }
    case 'fact':
      return `The architect said: “${entry.words}”${feeds}`
    case 'saved-content':
      return `Saved content in ${fieldTitle(entry.field)}: ${CHOICES[entry.choice] ?? entry.choice}`
    case 'open-question':
      return `${entry.question}${entry.why ? ` — ${entry.why}` : ''}${feeds}`
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

const KIND_LABELS = { answer: 'Answer', fact: 'Architect', 'saved-content': 'Saved content', 'open-question': 'Open question', artefact: 'Artefact', restart: 'Restart', 'model-change': 'Model' }

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
