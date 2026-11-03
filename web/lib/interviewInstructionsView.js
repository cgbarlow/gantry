// #282 (docs/adr/0062): the Preact piece every Definitions surface draws Interview instructions with
// — the server Definitions page and the Local Workspace Definition editor — so the two can't drift in
// how the text is edited or shown. The rule for what is valid lives in web/lib/interviewInstructions.js.
import { html } from 'htm/preact'
import { interviewText } from './interviewInstructions.js'

/**
 * Interview instructions at one level (`level` is the human name: "Definition", "Stage" or "Module").
 * On a draft (`editable`) a text box, always shown so an author can start writing; on a published
 * version a read-only block, shown only when the level has instructions. `onChange` gets the new
 * text, '' once cleared, for the draft to carry as `interview` (or drop).
 *
 * @param {{ value: unknown, editable: boolean, level: string, onChange?: (text: string) => void, problems?: { message: string }[] }} props
 */
export function InterviewInstructions({ value, editable, level, onChange, problems = [] }) {
  const text = typeof value === 'string' ? value : ''
  if (!editable && !interviewText(value)) return null
  return html`
    <div class="defn-focus-section defn-interview">
      <span class="kicker">Interview instructions</span>
      ${editable
        ? html`
            <p class="guidance defn-hint">
              Extra steer for the AI when it interviews an architect about this ${level.toLowerCase()}: what to ask early, what to
              probe, tone, spelling. They add to Gantry's own interview rules and never override them.
            </p>
            <textarea class="wizard-input defn-interview-text" rows="4" aria-label="Interview instructions" value=${text} onInput=${(e) => onChange?.(e.currentTarget.value)}></textarea>
          `
        : html`<p class="defn-interview-readonly" data-testid="interview-instructions">${text}</p>`}
      ${problems.length ? html`<ul class="defn-filename-problems">${problems.map((p) => html`<li class="inline-error">${p.message}</li>`)}</ul>` : null}
    </div>
  `
}
