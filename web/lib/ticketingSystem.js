import { signal, effect } from '@preact/signals'

// Client-side, cross-screen "which ticketing system is the default for new
// workspaces" setting (#101's Global Defaults tab) — a `@preact/signals`
// signal backed by localStorage, following the exact pattern
// web/lib/theme.js and web/lib/dashboardView.js already established for a
// persisted, cross-screen preference.
//
// This is a *global* default only: per-workspace overrides (the "Workspace
// overrides tab" #101's own ticket named as a follow-on, and the
// `ticketingSystem` field #96 added to the workspace registry/schema) are
// out of scope here and aren't read or written by this module at all.
//
// `azure-devops` is the only ticketing system gantry actually integrates
// with today; `jira` is modelled in the enum (matching #96's own schema,
// which already reserves the value) so the Settings UI can show it as a
// visible-but-disabled "coming soon" option, per #101's own acceptance
// criteria — not because anything downstream of this module understands
// how to act on it yet.
export const TICKETING_SYSTEMS = [
  { id: 'azure-devops', label: 'Azure DevOps', disabled: false },
  { id: 'jira', label: 'Jira', disabled: true, disabledReason: 'Coming soon' },
]

const ENABLED_IDS = TICKETING_SYSTEMS.filter((system) => !system.disabled).map((system) => system.id)

const STORAGE_KEY = 'gantry:default-ticketing-system'

// `localStorage` can throw on access rather than just being absent — e.g.
// storage blocked by browser privacy settings, or a sandboxed iframe with no
// `allow-same-origin`. Guarded the same way web/lib/theme.js guards its own
// access, for the same reason: a throw here must never take down the rest
// of the app, just stop the choice persisting.
function safeGetItem(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Ignore — see the comment above safeGetItem.
  }
}

function initialDefaultTicketingSystem() {
  const stored = safeGetItem(STORAGE_KEY)
  return stored && ENABLED_IDS.includes(stored) ? stored : ENABLED_IDS[0]
}

export const defaultTicketingSystem = signal(initialDefaultTicketingSystem())

effect(() => {
  safeSetItem(STORAGE_KEY, defaultTicketingSystem.value)
})

/**
 * Sets the global default ticketing system. Silently ignores any id that
 * isn't currently enabled (i.e. `jira`, today) rather than throwing — the
 * Settings UI already disables that option's control, so reaching here
 * with a disabled id would only ever be a defensive-programming bug, not a
 * real user action to surface an error for.
 */
export function setDefaultTicketingSystem(id) {
  if (!ENABLED_IDS.includes(id)) return
  defaultTicketingSystem.value = id
}
