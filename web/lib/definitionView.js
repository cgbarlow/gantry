import { signal, effect } from '@preact/signals'

// Definition editor Outline / Map view switch (WI #381, Feature #380's grilling session): which of
// the two navigation views — over the same focus pane and docked Library panel — the definition
// editor shows. **Outline** (default) is a tree of three flat groups (Stages, Artefacts, Modules with
// fields); **Map** lays the pipeline out spatially (stages as columns of module chips, artefacts
// hanging off each gate). Both are first-class, neither is "advanced" — same posture as
// `web/lib/viewMode.js`'s Visual/Split/Markdown peers, which this is modelled on as a cross-screen
// `@preact/signals` signal (docs/adr/0006-preact-frontend-framework.md's standard primitive).
//
// Unlike `viewMode`, though, this choice *is* remembered per user — the decision record is explicit
// ("The choice is remembered per user") — so persistence follows `web/lib/theme.js`'s convention
// (a guarded localStorage read/write behind an `effect`) rather than `viewMode`'s deliberately
// session-only one.
export const DEFN_VIEWS = ['outline', 'map']

const STORAGE_KEY = 'gantry:defnView'

// See web/lib/theme.js's safeGetItem/safeSetItem for why every access is guarded: localStorage can
// throw on access (blocked by browser privacy settings, a sandboxed iframe), and a throw here must
// never take down the editor — the view choice would just stop persisting.
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

function initialDefnView() {
  const stored = safeGetItem(STORAGE_KEY)
  return DEFN_VIEWS.includes(stored) ? stored : 'outline'
}

export const defnView = signal(initialDefnView())

effect(() => {
  safeSetItem(STORAGE_KEY, defnView.value)
})

export function setDefnView(next) {
  if (DEFN_VIEWS.includes(next)) defnView.value = next
}
