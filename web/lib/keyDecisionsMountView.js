// #284 (ADR-0065): the Preact piece both Definitions surfaces — the server Definitions page and the Local
// Workspace Definition editor — draw a Key decisions mount's two settings with, so the two can't drift: the
// prefix its numbers carry (AD01, AD02, …) and the decision style it is written in. The rules for what is
// valid live in web/lib/keyDecisions.js (and standardModuleProblems for the Definition as a whole).
import { html } from 'htm/preact'
import { DECISION_STYLES, STYLE_TITLES, DEFAULT_PREFIX, DEFAULT_STYLE, decisionReference } from './keyDecisions.js'

const STYLE_HINTS = {
  default: 'Title, context, decision, why, considered options, consequences.',
  why: 'A title, the "In the context of… facing… we decided for… and neglected… to achieve… accepting that…" statement, and links to other Key decisions.',
}

/**
 * @param {{ mount: { prefix?: unknown, style?: unknown }, editable: boolean, onChange: (change: { prefix?: string, style?: string }) => void }} props
 *   `onChange` gets the one setting that changed; the caller writes it onto the mount.
 */
export function KeyDecisionsMountSettings({ mount, editable, onChange }) {
  const prefix = typeof mount.prefix === 'string' ? mount.prefix : DEFAULT_PREFIX
  const style = DECISION_STYLES.includes(mount.style) ? mount.style : mount.style === undefined ? DEFAULT_STYLE : mount.style
  const shown = prefix || DEFAULT_PREFIX
  return html`
    <div class="defn-focus-section defn-key-decisions-settings" data-testid="key-decisions-settings">
      <span class="kicker">Numbering and style</span>
      <div class="defn-focus-row">
        <label class="field-label" for="key-decisions-prefix">Prefix</label>
        ${editable
          ? html`<input id="key-decisions-prefix" class="wizard-input" type="text" maxlength="6" style="max-width: 8em" value=${prefix} onInput=${(e) => onChange({ prefix: e.currentTarget.value.toUpperCase() })} />`
          : html`<span data-testid="key-decisions-prefix">${prefix}</span>`}
        <span class="muted">Decisions are numbered ${decisionReference(shown, 1)}, ${decisionReference(shown, 2)}, … and keep their numbers when reordered or removed.</span>
      </div>
      <div class="defn-focus-row">
        <label class="field-label" for="key-decisions-style">Decision style</label>
        ${editable
          ? html`<select id="key-decisions-style" class="wizard-input" onChange=${(e) => onChange({ style: e.currentTarget.value })}>
              ${DECISION_STYLES.includes(style) ? null : html`<option value=${String(style)} selected>${String(style)} (not a style)</option>`}
              ${DECISION_STYLES.map((s) => html`<option value=${s} selected=${s === style}>${STYLE_TITLES[s]}</option>`)}
            </select>`
          : html`<span data-testid="key-decisions-style">${STYLE_TITLES[style] ?? style}</span>`}
        <span class="muted">${STYLE_HINTS[style] ?? ''}</span>
      </div>
    </div>
  `
}
