// Instance-setup wizard (Azure DevOps #78): the "progressive single page"
// variant (C) from web/prototypes/instance-setup-wizard.prototype.html —
// fields reveal one at a time as each is satisfied, an existing-instance
// result renders as a side-by-side "found in repo" vs. "you're about to
// use" comparison, and a connection error is a dismissible banner that
// never hides or clears the URL field. See that prototype's header comment
// for why this variant won out over the single-form and multi-step-wizard
// alternatives it was compared against.
import { html } from 'htm/preact'
import { useEffect } from 'preact/hooks'
import { signal, effect } from '@preact/signals'
import { validateRepo, repoSlug } from '../lib/validateRepo.js'
import { theme, cycleTheme } from '../lib/theme.js'

// Wizard state as `@preact/signals` — per docs/adr/0006-preact-frontend-framework.md,
// which names "in-progress wizard answers" as exactly this state model's
// use case — kept at module scope so a check/definition-pick in progress
// survives an internal route change and back, not just component-local
// state that'd reset on remount.
const repoUrl = signal('')
const checkStatus = signal('idle') // idle | checking | empty | existing | error
const checkErrorMessage = signal('')
const errorDismissed = signal(false)
const foundInstance = signal(null) // registry-shaped instance, once checkStatus === 'existing'
const selectedDefinitionId = signal('')
const createStatus = signal('idle') // idle | creating | done | failed
const createErrorMessage = signal('')
const createdSlug = signal('')
// Fetched once on mount (see SetupWizardPage's effect below); read from here
// rather than threaded through as a prop so `checkRepo` — a plain function,
// not a component — can default a fresh check's definition selection
// without needing a definitions argument passed in from the render tree.
const availableDefinitions = signal([])
// Bumped by resetCheck() every time the current check/create context is
// abandoned (the URL is edited). `createNewInstance()` captures this at
// the start of its POST and compares it once that resolves, so a create
// the user has since abandoned can't apply its (stale) success/failure
// state on top of whatever check the user has moved on to — the same
// class of stale-async-response bug checkRepo() itself guards against
// (there, by comparing the checked URL to the field's current value).
const sessionToken = signal(0)

// `checkRepo()` (an "empty repo" result) and the definitions fetch in
// SetupWizardPage's own effect are two independent in-flight requests with
// no ordering guarantee between them — if the check resolves first,
// `checkRepo()`'s own default (`availableDefinitions.value[0]?.id`) sees an
// still-empty list and picks `''`, and nothing would otherwise ever revisit
// that once the definitions do arrive. This closes that gap: once
// definitions are available, default the selection if an "empty repo"
// check is showing the picker with nothing chosen yet (the button itself
// stays disabled meanwhile — see SubmitAction's `noDefinitionSelected`).
effect(() => {
  if (checkStatus.value === 'empty' && selectedDefinitionId.value === '' && availableDefinitions.value.length > 0) {
    selectedDefinitionId.value = availableDefinitions.value[0].id
  }
})

function resetCheck() {
  checkStatus.value = 'idle'
  checkErrorMessage.value = ''
  errorDismissed.value = false
  foundInstance.value = null
  createStatus.value = 'idle'
  createErrorMessage.value = ''
  createdSlug.value = ''
  sessionToken.value++
}

function onRepoUrlInput(value) {
  repoUrl.value = value
  // Editing the URL abandons whatever check is currently displayed — the
  // definition picker and any result/error card are for the *previous*
  // URL, not this one, so they must disappear rather than linger stale.
  // This now also fires while a check is still in flight (`checkStatus.value
  // === 'checking'`): without it, the "Checking…" state would stay pinned
  // to a request the user has already moved on from, and checkRepo()'s own
  // stale-result guard below (comparing the field's value once the request
  // resolves) is what stops that in-flight request from re-applying a
  // result for this now-different URL once it does resolve.
  if (checkStatus.value !== 'idle') resetCheck()
}

async function checkRepo() {
  const url = repoUrl.value.trim()
  if (!url) return
  checkStatus.value = 'checking'
  errorDismissed.value = false
  const result = await validateRepo(url)
  // The URL field can change while this check is in flight (the user edits
  // it before this resolves — onRepoUrlInput resets checkStatus back to
  // 'idle' the moment that happens). Discard a stale result rather than
  // showing a found-instance/definition-picker/error state that no longer
  // corresponds to what's currently in the field.
  if (repoUrl.value.trim() !== url) return
  if (result.result === 'error') {
    checkStatus.value = 'error'
    checkErrorMessage.value = result.message
    return
  }
  if (result.result === 'existing') {
    foundInstance.value = result.instance
    selectedDefinitionId.value = result.instance.definition
  } else {
    foundInstance.value = null
    selectedDefinitionId.value = availableDefinitions.value[0]?.id ?? ''
  }
  checkStatus.value = result.result
}

async function createNewInstance() {
  const token = sessionToken.value
  createStatus.value = 'creating'
  createErrorMessage.value = ''
  const slug = repoSlug(repoUrl.value)
  try {
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: selectedDefinitionId.value, slug }),
    })
    const body = await res.json()
    // The user may have abandoned this create (edited the URL, moving on to
    // a different check) while the POST was in flight — resetCheck() bumps
    // sessionToken whenever that happens. Discard a stale response rather
    // than showing a success/failure card for a create the user has since
    // moved on from, superimposed on whatever repo they're now checking.
    if (sessionToken.value !== token) return
    if (!res.ok) {
      createStatus.value = 'failed'
      createErrorMessage.value = body.error ?? `Failed to create instance (${res.status})`
      return
    }
    createStatus.value = 'done'
    createdSlug.value = body.slug
  } catch (err) {
    if (sessionToken.value !== token) return
    createStatus.value = 'failed'
    createErrorMessage.value = err.message
  }
}

// A full navigation (not preact-iso client-side routing) to the module
// editor's real per-instance route. The module editor is reactive to its
// route-param `slug` prop now (#77), so a client-side route() would work
// too — a full navigation is kept anyway for a clean reload of this fresh
// instance's state, matching the "Open workspace" links elsewhere.
function openInstance(slug) {
  window.location.assign(`/instance/${encodeURIComponent(slug)}`)
}

function stampClass(status) {
  return status === 'complete' ? 'agreed' : 'draft'
}

function WizardHeader() {
  return html`
    <header class="wizard-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>gantry</h1>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
      </div>
      <a class="btn small ghost" href="/">← Instances</a>
    </header>
  `
}

function RepoUrlField() {
  return html`
    <div class="wizard-field">
      <label for="repo-url">Azure DevOps repo URL</label>
      <input
        class="wizard-input"
        id="repo-url"
        type="text"
        placeholder="https://dev.azure.com/org/project/_git/repo"
        value=${repoUrl.value}
        onInput=${(e) => onRepoUrlInput(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') checkRepo()
        }}
      />
      <div class="check-row">
        <button
          type="button"
          class="btn small"
          disabled=${checkStatus.value === 'checking' || repoUrl.value.trim() === ''}
          onClick=${checkRepo}
        >
          ${checkStatus.value === 'checking' ? 'Checking…' : 'Check repo'}
        </button>
      </div>
      ${checkStatus.value === 'error' && !errorDismissed.value
        ? html`
            <div class="dismiss-banner">
              <span><span class="stamp error">Error</span> ${checkErrorMessage.value}</span>
              <button type="button" aria-label="Dismiss" onClick=${() => (errorDismissed.value = true)}>×</button>
            </div>
          `
        : null}
    </div>
  `
}

function FoundResultCard() {
  const status = checkStatus.value
  if (status !== 'empty' && status !== 'existing') return null

  if (status === 'empty') {
    return html`
      <div class="result-card">
        <h3><span class="stamp agreed">Empty repo</span></h3>
        <p class="result-note">Nothing found at this location — gantry will initialize a fresh instance here on the selected definition.</p>
      </div>
    `
  }

  const found = foundInstance.value
  return html`
    <div class="result-card">
      <h3><span class="stamp review">Existing instance found</span></h3>
      <div class="result-row"><span class="k">Instance name</span><span class="v">${found.slug}</span></div>
      <div class="result-row"><span class="k">Definition</span><span class="v">${found.definition}</span></div>
      <div class="result-row"><span class="k">Current stage</span><span class="v">${found.stage}</span></div>
      <div class="result-row"><span class="k">Status</span><span class="v"><span class="stamp ${stampClass(found.status)}">${found.status}</span></span></div>
      <div class="result-row"><span class="k">Owner</span><span class="v">${found.owner || '—'}</span></div>
    </div>
  `
}

function DefinitionPicker() {
  const status = checkStatus.value
  if (status !== 'empty' && status !== 'existing') return null

  const found = foundInstance.value
  const mismatch = status === 'existing' && found && selectedDefinitionId.value !== found.definition

  return html`
    <div class="wizard-field">
      <label for="definition-picker">Definition</label>
      <div id="definition-picker">
        ${availableDefinitions.value.map(
          (d) => html`
            <div
              key=${d.id}
              class=${'definition-card' + (selectedDefinitionId.value === d.id ? ' selected' : '')}
              onClick=${() => (selectedDefinitionId.value = d.id)}
            >
              <div class="name">${d.title} (${d.id})</div>
              <div class="stages">${d.stages.map((s) => s.title).join(' → ')}</div>
            </div>
          `
        )}
      </div>

      ${status === 'existing'
        ? html`
            <div class="compare">
              <div class="col">
                <h4>Found in repo</h4>
                <div class="mono">${found.definition}<br />${found.stage}</div>
              </div>
              <div class="col">
                <h4>You're about to use</h4>
                <div class="mono">${selectedDefinitionId.value}</div>
              </div>
            </div>
            ${mismatch
              ? html`<div class="mismatch-flag">
                  These don't match — the repo's own definition (${found.definition}) will be used, not your selection.
                </div>`
              : null}
          `
        : null}
    </div>
  `
}

function SubmitAction() {
  const status = checkStatus.value
  if (status !== 'empty' && status !== 'existing') return null

  if (status === 'existing') {
    return html`
      <div class="wizard-field">
        <button type="button" class="btn primary" onClick=${() => openInstance(foundInstance.value.slug)}>
          Open instance
        </button>
      </div>
    `
  }

  if (createStatus.value === 'done') {
    return html`
      <div class="result-card">
        <h3><span class="stamp agreed">Instance created</span></h3>
        <p class="result-note">"${createdSlug.value}" is registered and appears in gantry's instance listing.</p>
        <button type="button" class="btn primary" onClick=${() => openInstance(createdSlug.value)}>Open instance</button>
      </div>
    `
  }

  // Disabled while no definition is selected yet — reachable right after an
  // "empty repo" check completes if `GET /api/definitions` (fetched
  // separately, see SetupWizardPage's effect) hasn't resolved yet, or if it
  // ever comes back empty. Without this, clicking through in that window
  // would submit `definition: ''`, rejected server-side but a confusing
  // dead end rather than a plainly-disabled button.
  const noDefinitionSelected = selectedDefinitionId.value === ''

  return html`
    <div class="wizard-field">
      <button
        type="button"
        class="btn primary"
        disabled=${createStatus.value === 'creating' || noDefinitionSelected}
        onClick=${createNewInstance}
      >
        ${createStatus.value === 'creating' ? 'Creating…' : 'Create instance'}
      </button>
      ${noDefinitionSelected ? html`<p class="wizard-field-hint">Loading definitions…</p>` : null}
      ${createStatus.value === 'failed' ? html`<div class="inline-error">${createErrorMessage.value}</div>` : null}
    </div>
  `
}

export function SetupWizardPage() {
  useEffect(() => {
    fetch('/api/definitions')
      .then((res) => res.json())
      .then((body) => (availableDefinitions.value = body))
      .catch(() => (availableDefinitions.value = []))
  }, [])

  return html`
    <${WizardHeader} />
    <main class="wizard-page">
      <h2>New instance</h2>
      <p class="lede">
        Point gantry at an Azure DevOps repo to hold this instance's data, and pick which definition it follows. If the
        repo already has an instance in it, gantry will show what it found instead of starting fresh.
      </p>

      <${RepoUrlField} />
      <${FoundResultCard} />
      <${DefinitionPicker} />
      <${SubmitAction} />
    </main>
  `
}
