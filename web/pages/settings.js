// Settings screen (#101): a new top-level `/settings` route with a tabbed
// shell. Only one tab exists yet — Global Defaults, holding the Azure
// DevOps PAT management moved off the per-instance editor header (see
// web/app.js's AppHeader — its "Replace Azure DevOps PAT"/"Clear Azure
// DevOps PAT" buttons are removed entirely, not just hidden) and a global
// ticketing-system default selector. A "Workspace overrides" tab is named
// in #101's own ticket as a follow-on (#104) — `TABS` below is a real
// array (not a single hard-coded panel) precisely so that tab can be added
// alongside this one without restructuring the shell.
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { theme, cycleTheme } from '../lib/theme.js'
import { pat, clearPat, requestPat } from '../lib/credential.js'
import { TICKETING_SYSTEMS, defaultTicketingSystem, setDefaultTicketingSystem } from '../lib/ticketingSystem.js'

const TABS = [{ id: 'global-defaults', label: 'Global Defaults' }]

function SettingsHeader() {
  return html`
    <header class="settings-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>Settings</h1>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
      </div>
      <a class="btn small ghost" href="/">← Instances</a>
    </header>
  `
}

function SettingsTabs({ activeTab, onSelect }) {
  return html`
    <div class="settings-tabs" role="tablist" aria-label="Settings">
      ${TABS.map(
        (tab) => html`
          <button
            type="button"
            key=${tab.id}
            role="tab"
            aria-selected=${activeTab === tab.id}
            class=${activeTab === tab.id ? 'active' : ''}
            onClick=${() => onSelect(tab.id)}
          >
            ${tab.label}
          </button>
        `
      )}
    </div>
  `
}

// The default PAT this section manages is the exact same one
// web/lib/credential.js already held (and web/app.js's per-instance editor
// header used to expose) — moved here wholesale, not reimplemented. A
// third state this section adds beyond "replace"/"clear" (which assumed a
// PAT already existed): a first-time "Set" action, since this is now the
// *only* place a PAT can be entered ahead of any 401 ever prompting for
// one.
function GlobalPatSection() {
  return html`
    <section class="settings-section">
      <h2>Azure DevOps Personal Access Token</h2>
      <p class="guidance">
        Used for every Azure-DevOps-backed instance this gantry server serves. Stored only in this browser and sent
        solely to your own gantry server — needs <strong>Code (Read &amp; write)</strong> and
        <strong>Work Items (Read &amp; write)</strong> scope.
      </p>
      <div class="settings-pat-status">
        ${pat.value ? html`<span class="stamp agreed">SET</span>` : html`<span class="stamp draft">NOT SET</span>`}
      </div>
      <div class="settings-actions">
        ${pat.value
          ? html`
              <button type="button" class="btn" onClick=${() => requestPat()}>Replace Azure DevOps PAT</button>
              <button type="button" class="btn ghost" onClick=${clearPat}>Clear Azure DevOps PAT</button>
            `
          : html`<button type="button" class="btn primary" onClick=${() => requestPat()}>Set Azure DevOps PAT</button>`}
      </div>
    </section>
  `
}

function TicketingSystemSection() {
  return html`
    <section class="settings-section">
      <h2>Default ticketing system</h2>
      <p class="guidance">
        Which ticketing system new workspaces default to, until a workspace-level override (a future "Workspace
        overrides" tab) says otherwise.
      </p>
      <div class="settings-radio-group" role="radiogroup" aria-label="Default ticketing system">
        ${TICKETING_SYSTEMS.map(
          (system) => html`
            <label key=${system.id} class=${'settings-radio' + (system.disabled ? ' disabled' : '')}>
              <input
                type="radio"
                name="default-ticketing-system"
                value=${system.id}
                checked=${defaultTicketingSystem.value === system.id}
                disabled=${system.disabled}
                onChange=${() => setDefaultTicketingSystem(system.id)}
              />
              ${system.label}
              ${system.disabled ? html`<span class="stamp review">${system.disabledReason}</span>` : null}
            </label>
          `
        )}
      </div>
    </section>
  `
}

function GlobalDefaultsTab() {
  return html`
    <${GlobalPatSection} />
    <${TicketingSystemSection} />
  `
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState(TABS[0].id)

  return html`
    <${SettingsHeader} />
    <main class="wizard-page settings-page">
      <${SettingsTabs} activeTab=${activeTab} onSelect=${setActiveTab} />
      ${activeTab === 'global-defaults' ? html`<${GlobalDefaultsTab} />` : null}
    </main>
  `
}
