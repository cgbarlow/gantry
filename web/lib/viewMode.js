import { signal } from '@preact/signals'

// Cross-screen "how is a markdown field displayed" state for the module editor — one `@preact/signals` signal for the *whole screen* (docs/adr/0006-preact-frontend-framework.md's standard cross-screen state primitive), not scoped per-module or per-field, per the #79 ticket. It holds steady as the author navigates fields/modules/stages within a visit because it lives outside the component tree that stage switches remount (see web/app.js's StageScreen), the same reason `viewedStage`/`instanceData` there survive stage switches.
//
// Three peers (#374, CONTEXT.md → View mode): Visual (the content drawn as it reads, edited in place), Split (source and Visual side by side over one document), and Markdown (the raw text). Visual comes first and is the default.
//
// Deliberately session-only — unlike web/lib/theme.js, this never reads from or writes to localStorage, so a fresh page load always starts back at `visual`; there is no "next visit" to carry it across.
export const VIEW_MODES = ['visual', 'split', 'markdown']

export const viewMode = signal('visual')

export function cycleViewMode() {
  const i = VIEW_MODES.indexOf(viewMode.value)
  viewMode.value = VIEW_MODES[(i + 1) % VIEW_MODES.length]
}
