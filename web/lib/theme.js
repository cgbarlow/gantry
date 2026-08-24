import { signal, effect } from '@preact/signals'

// Cross-screen theme state — a `@preact/signals` signal (per docs/adr/0006-preact-frontend-framework.md, the standard cross-screen state primitive), not scoped to the module editor, so future screens (dashboard, wizard, asset library) read/drive the same signal.
export const THEMES = ['light', 'dark', 'hc']

const STORAGE_KEY = 'gantry:theme'

// `localStorage` can throw on access rather than just being absent — e.g. storage blocked by browser privacy settings, or a sandboxed iframe with no `allow-same-origin`. A throw here must never take down the rest of the app (theme choice would just stop persisting), so every access is guarded.
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

// Keep this fallback chain in sync with the inline bootstrap script in web/index.html, which resolves the same choice before first paint (and duplicates it rather than importing this module, so it can run synchronously ahead of Preact loading — see that script's own comment).
function preferredTheme() {
  if (typeof matchMedia !== 'function') return 'light'
  if (matchMedia('(prefers-contrast: more)').matches) return 'hc'
  if (matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

function initialTheme() {
  // index.html sets `data-theme` on <html> before this module loads (from localStorage or the OS preference), so there's no flash of the wrong theme — read that back as the starting value rather than recomputing it.
  const fromDom = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')
  if (fromDom && THEMES.includes(fromDom)) return fromDom
  const stored = safeGetItem(STORAGE_KEY)
  if (stored && THEMES.includes(stored)) return stored
  return preferredTheme()
}

export const theme = signal(initialTheme())

effect(() => {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme.value)
  safeSetItem(STORAGE_KEY, theme.value)
})

export function cycleTheme() {
  const i = THEMES.indexOf(theme.value)
  theme.value = THEMES[(i + 1) % THEMES.length]
}
