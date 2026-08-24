import { signal, effect } from '@preact/signals'

// The instance dashboard's (#77) chosen layout — master-detail (default) or stage swimlanes — persisted the same way theme.js persists theme choice: a `@preact/signals` signal backed by localStorage, guarded against localStorage throwing (blocked storage, sandboxed iframe, etc.) so a throw here can never take down the rest of the app, just stop the choice persisting. See web/lib/theme.js for the identical pattern this mirrors.
export const VIEW_MODES = ['master-detail', 'swimlanes']

const STORAGE_KEY = 'gantry:dashboard-view'

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

function initialViewMode() {
  const stored = safeGetItem(STORAGE_KEY)
  return stored && VIEW_MODES.includes(stored) ? stored : 'master-detail'
}

export const viewMode = signal(initialViewMode())

effect(() => {
  safeSetItem(STORAGE_KEY, viewMode.value)
})
