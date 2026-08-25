// gantry's production UI entry point — Preact, delivered via HTM tagged templates with no build step, per docs/adr/0006-preact-frontend-framework.md. `preact-iso` provides the routing shell — the instance dashboard (#77) at `/`, the module editor at `/instance/:slug`, the "+ New Workspace" wizard at `/new-workspace` (see web/pages/new-workspace-wizard.js, #110/#126, which replaced the old URL-first instance-setup wizard entirely) — and `@preact/signals` holds the instance-scoped state (the viewed slug and stage, the fetched instance data) that's shared across the module editor screen's header, nav, and module list, exactly as today's DOM version threaded a `stageId` through a single re-render function.
import { html, render } from 'htm/preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect, batch } from '@preact/signals'
import { LocationProvider, Router, Route } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
// `keymap` lives in @codemirror/view (the same module 'codemirror' re-exports
// EditorView from); imported directly so the toolbar's shortcut layer sits in
// one obvious place next to the command transforms it drives.
import { keymap } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { promptOpen, resolvePromptWith } from './lib/credential.js'
import { apiFetch, apiFetchForInstance } from './lib/apiFetch.js'
import { Dropdown } from './lib/dropdown.js'
import { apply as applyMarkdownCommand, HEADING_LEVELS, findTable } from './lib/markdownCommands.js'
import { NewWorkspaceWizardPage } from './pages/new-workspace-wizard.js'
import { GlobalSettingsPage, WorkspaceSettingsPage, InstanceSettingsPage } from './pages/settings.js'
// Two distinct "view mode" concepts collide on the same export names — the dashboard's (#77) master-detail/swimlanes toggle and the module editor's (#79) markdown/split/rendered toggle are unrelated signals that happen to share a shape. The dashboard's is aliased here; the module editor's keeps the bare names since it's used throughout the rest of this file.
import { VIEW_MODES as DASHBOARD_VIEW_MODES, viewMode as dashboardViewMode } from './lib/dashboardView.js'
import { VIEW_MODES, viewMode, cycleViewMode } from './lib/viewMode.js'
import { assetReference, resolveAssetRefs } from './lib/assetRefs.js'

const md = new MarkdownIt()

function assetFileUrl(assetId, slug) {
  const base = `/api/instance/assets/${encodeURIComponent(assetId)}/file`
  return slug ? `${base}?slug=${encodeURIComponent(slug)}` : base
}

// `image` tokens whose src resolves to gantry's own asset-file route get an `asset-thumb` class, so the Gate Ledger stylesheet can size/border an inserted asset as a real thumbnail rather than an arbitrary inline image (#80's "renders as an actual thumbnail" acceptance criterion).
const defaultImageRenderer = md.renderer.rules.image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src') ?? ''
  if (src.startsWith('/api/instance/assets/')) tokens[idx].attrJoin('class', 'asset-thumb')
  return defaultImageRenderer(tokens, idx, options, env, self)
}

async function loadInstance(slug, stageId) {
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  const qs = params.toString()
  // `apiFetchForInstance` (not plain `apiFetch`) — this request may target a workspace with its own PAT override (#104), which must be resolved and attached before the first attempt, not just on a 401 retry.
  const res = await apiFetchForInstance(slug, qs ? `/api/instance?${qs}` : '/api/instance')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instance (${res.status})`)
  }
  return res.json()
}

async function fetchAssets(slug) {
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : ''
  const res = await apiFetchForInstance(slug, `/api/instance/assets${qs}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load images (${res.status})`)
  }
  return res.json()
}

async function uploadAsset({ slug, filename, dataBase64, name, source, uploadedBy }) {
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : ''
  const res = await apiFetchForInstance(slug, `/api/instance/assets${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, dataBase64, name, source, uploadedBy }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to upload image (${res.status})`)
  }
  return body
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// `asset:<id>` references are resolved to the real, fetchable asset-file URL before markdown-it ever sees the text — the *stored* markdown source keeps the portable `asset:<id>` convention (see web/lib/assetRefs.js), only the live preview's rendered HTML points at a real URL.
function renderPreview(node, text) {
  if (!node) return
  const slug = currentSlug.value
  node.innerHTML = DOMPurify.sanitize(md.render(resolveAssetRefs(text ?? '', (id) => assetFileUrl(id, slug))))
}

// ---------- Identity picker (#145 Part 2) ----------
// A combobox-style input that searches Azure DevOps identities as the user
// types, presenting matches in a pick-list. Used in place of every plain
// text input for people fields (workspace Owner, per-instance required-
// reviewer override, instance Assignee). The underlying value is a
// `uniqueName`; the display is the `displayName`. A clear button (×) lets
// the user blank the field. Debounced to avoid hammering the server on
// every keystroke.
function IdentityPicker({ value, onChange, placeholder, slug, className }) {
  const [query, setQuery] = useState(value ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const wrapperRef = useRef(null)

  // Sync display value when the external value changes (e.g. on load from server)
  useEffect(() => {
    setQuery(value ?? '')
  }, [value])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function search(q) {
    if (!q.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    setLoading(true)
    try {
      const params = new URLSearchParams({ q })
      if (slug) params.set('slug', slug)
      const res = await apiFetchForInstance(slug, `/api/identities?${params}`)
      const data = await res.json().catch(() => [])
      setResults(Array.isArray(data) ? data : [])
      setOpen(true)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  function handleInput(e) {
    const val = e.currentTarget.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(val), 250)
  }

  function handleSelect(identity) {
    setQuery(identity.displayName)
    setOpen(false)
    onChange?.(identity.uniqueName, identity)
  }

  function handleClear() {
    setQuery('')
    setResults([])
    setOpen(false)
    onChange?.('', null)
    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Enter') {
      // Commit the currently typed value as-is (without requiring a dropdown
      // selection) — allows keyboard-only workflows and preserves backwards
      // compatibility with Playwright tests that type + Enter.
      e.preventDefault()
      const trimmed = query.trim()
      setOpen(false)
      onChange?.(trimmed, trimmed ? { uniqueName: trimmed, displayName: trimmed } : null)
    }
  }

  const hasValue = Boolean(query.trim())

  return html`
    <div class=${'identity-picker' + (className ? ' ' + className : '')} ref=${wrapperRef}>
      <input
        ref=${inputRef}
        type="text"
        value=${query}
        placeholder=${placeholder ?? 'Search by name\u2026'}
        onInput=${handleInput}
        onFocus=${() => { if (query.trim() && results.length) setOpen(true) }}
        onBlur=${() => {
          // Commit the current typed value on blur (matches the old text input's
          // save-on-blur behaviour). Playwright's `.fill()` + `.blur()` pattern
          // relies on this — `.fill()` bypasses Preact's onInput, so the draft
          // state doesn't update until blur fires.
          const trimmed = query.trim()
          if (trimmed !== (value ?? '').trim()) {
            onChange?.(trimmed, trimmed ? { uniqueName: trimmed, displayName: trimmed } : null)
          }
          setOpen(false)
        }}
        onKeyDown=${handleKeyDown}
      />
      ${hasValue
        ? html`<button type="button" class="clear-btn" onClick=${handleClear} aria-label="Clear">x</button>`
        : null}
      <div class=${'identity-dropdown' + (open ? ' open' : '')}>
        ${loading ? html`<div class="no-results">Searching…</div>` : null}
        ${!loading && results.length === 0 && query.trim()
          ? html`<div class="no-results">No identities found for "${query}".</div>`
          : null}
        ${results.map(
          (identity) => html`
            <button
              type="button"
              class="identity-option"
              key=${identity.uniqueName}
              onClick=${() => handleSelect(identity)}
            >
              <span class="name">${identity.displayName}</span>
              ${identity.emailAddress
                ? html`<span class="email">${identity.emailAddress}</span>`
                : null}
            </button>
          `
        )}
      </div>
    </div>
  `
}

// ---------- Instance-scoped state ----------
// `currentSlug` is the instance the module editor route (`/instance/:slug`) is currently mounted for. `viewedStage` mirrors the free-browse stage switcher: the stage the form is currently displaying, distinct from the instance's own persisted current stage until the user picks a different one. `viewedStage` of `null` means "let the server default to the instance's current stage" (the bootstrap case, on first load of a slug).
const currentSlug = signal(null)
const viewedStage = signal(null)
const instanceData = signal(null)
const loadError = signal(null)

// Fires only while a slug is actually pinned — i.e. while ModuleEditorPage is mounted (see its own useEffect below) — not on every page load regardless of route, so landing on a sibling route with no instance pinned (e.g. /new-workspace, the "+ New Workspace" wizard, #110, or the dashboard) never fires this fetch or surfaces a spurious "no instance slug given" failure.
effect(() => {
  const slug = currentSlug.value
  if (!slug) return
  const stageId = viewedStage.value
  loadInstance(slug, stageId)
    .then((data) => {
      instanceData.value = data
      loadError.value = null
    })
    .catch((err) => {
      loadError.value = err.message
    })
})

// A Rendered-mode editor must be genuinely read-only (#79's acceptance criteria: "no edits possible, none saved"), not just visually hidden by CSS — `EditorState.readOnly` rejects direct-edit transactions and `EditorView.editable` drops `contenteditable`, so neither typing nor paste nor drag-drop can land a change while Rendered is active.
function editableExtension(mode) {
  const editable = mode !== 'rendered'
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

// ---------- Formatting toolbar (#133) ----------
//
// One slim toolbar per markdown field, mounted only while that field has
// focus and never in Rendered mode. Every button (and every shortcut) funnels
// through `runMarkdownCommand`, which reads doc/selection/lezer-tree off the
// live EditorView, hands them to web/lib/markdownCommands.js's deterministic
// transforms (docs/adr/0017), and dispatches the returned (text, selection)
// back as a single CodeMirror transaction — so buttons and shortcuts are the
// same code path by construction, and each command is exactly one undo step.
const markdownToolbarKeymap = keymap.of([
  { key: 'Mod-b', run: (view) => runMarkdownCommand(view, 'bold') },
  { key: 'Mod-i', run: (view) => runMarkdownCommand(view, 'italic') },
  { key: 'Mod-Shift-x', run: (view) => runMarkdownCommand(view, 'strikethrough') },
  { key: 'Mod-e', run: (view) => runMarkdownCommand(view, 'inlineCode') },
  { key: 'Mod-k', run: (view) => runMarkdownCommand(view, 'link') },
  { key: 'Mod-Shift-8', run: (view) => runMarkdownCommand(view, 'bulletList') },
  { key: 'Mod-Shift-7', run: (view) => runMarkdownCommand(view, 'numberedList') },
  { key: 'Mod-Shift-9', run: (view) => runMarkdownCommand(view, 'taskList') },
  // Inside a table Tab walks the cells and Enter appends a row from the last
  // one (#134); this layer sits before basicSetup so it wins over the default
  // indent/newline bindings wherever it chooses to consume the keystroke.
  { key: 'Tab', run: (view) => runTableKey(view, 'tableNextCell') },
  { key: 'Shift-Tab', run: (view) => runTableKey(view, 'tablePrevCell') },
  { key: 'Enter', run: (view) => runTableEnter(view) },
])

function runMarkdownCommand(view, name, extra = {}) {
  // Belt-and-braces against Rendered mode: the keymap can't fire there (no
  // contenteditable), but a toolbar click racing a mode switch still could.
  if (!view.state.facet(EditorView.editable)) return false
  const range = view.state.selection.main
  const result = applyMarkdownCommand(name, {
    tree: syntaxTree(view.state),
    text: view.state.doc.toString(),
    from: range.from,
    to: range.to,
    ...extra,
  })
  // A null result is the transform's way of saying "not my table" — swallow
  // the keystroke's claim on it and let whatever's underneath have a go.
  if (!result) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    selection: { anchor: result.from, head: result.to },
    scrollIntoView: true,
  })
  return true
}

// Table keys are contextual (#134): they consume the keystroke only while the
// cursor sits inside a well-formed table. Everywhere else they report false,
// so Tab still indents and Enter still splits lines — graceful degradation,
// not a modal trap.
function runTableKey(view, command) {
  if (!view.state.facet(EditorView.editable)) return false
  const head = view.state.selection.main.head
  if (!findTable(view.state.doc.toString(), head)) return false
  return runMarkdownCommand(view, command)
}

// Enter only hijacks the caret when there is no "next cell" to hand it to:
// from the last cell of the last row it appends a fresh row instead.
function runTableEnter(view) {
  if (!view.state.facet(EditorView.editable)) return false
  const t = findTable(view.state.doc.toString(), view.state.selection.main.head)
  if (!t || t.rowIndex !== t.lines.length - 1 || t.colIndex !== t.colCount - 1) return false
  return runMarkdownCommand(view, 'tableAddRowBelow')
}

// Stroke icons inherit `currentColor`, so one path set works across light,
// dark and high-contrast themes without per-theme assets. The B/I/S letters
// stay plain text on purpose — they're the design language's signature
// self-demonstrating buttons, styled by CSS to show their own effect.
const ToolbarIcon = ({ children }) => html`
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${children}
  </svg>
`
const ICONS = {
  link: html`
    <${ToolbarIcon}>
      <path d="M6.9 8.6a3 3 0 0 0 4.5.3l1.9-1.9a3 3 0 0 0-4.2-4.2L7.9 4" />
      <path d="M9.1 7.4a3 3 0 0 0-4.5-.3l-1.9 1.9a3 3 0 0 0 4.2 4.2l1.2-1.2" />
    <//>
  `,
  bulletList: html`
    <${ToolbarIcon}>
      <circle cx="2.9" cy="3.8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="12.2" r="0.5" fill="currentColor" stroke="none" />
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  numberedList: html`
    <${ToolbarIcon}>
      <text x="1.1" y="5.8" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">1</text>
      <text x="1.1" y="10.6" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">2</text>
      <text x="1.1" y="15.2" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">3</text>
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  taskList: html`
    <${ToolbarIcon}>
      <rect x="1.6" y="2.2" width="3.1" height="3.1" rx="0.6" />
      <rect x="1.6" y="6.4" width="3.1" height="3.1" rx="0.6" />
      <path d="M2.4 12.7l1 1 1.6-1.8" />
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  horizontalRule: html`
    <${ToolbarIcon}>
      <path d="M2 8h12" />
    <//>
  `,
  codeBlock: html`
    <${ToolbarIcon}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" />
      <path d="M5.8 6.3L4.1 8l1.7 1.7M10.2 6.3L11.9 8l-1.7 1.7" />
    <//>
  `,
  // The full-screen pair (#135) — arrows out to the corners to expand, back
  // in towards the centre to exit, so the same slot demonstrates its own
  // current action the way the B/I/S letters do.
  expand: html`
    <${ToolbarIcon}>
      <path d="M10 2h4v4M14 2L9.33 6.67M6 14H2v-4M2 14l4.67-4.67" />
    <//>
  `,
  collapse: html`
    <${ToolbarIcon}>
      <path d="M13.33 6.67h-4v-4M9.33 6.67L14 2M2.67 9.33h4v4M6.67 9.33L2 14" />
    <//>
  `,
}

function MarkdownToolbar({ run, refocus, headingsOpen, setHeadingsOpen, expanded, onToggleFullscreen }) {
  const keepEditorFocus = (e) => e.preventDefault()
  // Buttons are shortcut-only by design (tabindex="-1" below): keyboard users
  // reach every command via its Ctrl/Cmd chord, so Tab skips straight past
  // these twelve buttons instead of parking on each one between the field and
  // the page.
  const button = (name, label, shortcut, content, onClick) =>
    html`
      <button
        type="button"
        class="md-btn"
        data-command=${name}
        aria-label=${label}
        title=${shortcut ? `${label} (${shortcut})` : label}
        onMouseDown=${keepEditorFocus}
        onClick=${onClick ?? (() => run(name))}
        tabindex="-1"
      >
        ${content}
      </button>
    `

  // role="group", not "toolbar": the ARIA toolbar pattern promises arrow-key
  // traversal between controls, which these shortcut-only buttons deliberately
  // don't implement — a labelled group makes no such contract.
  return html`
    <div class="md-toolbar" role="group" aria-label="Formatting">
      ${button('bold', 'Bold', 'Ctrl/Cmd+B', html`<span class="md-letter md-letter-bold">B</span>`)}
      ${button('italic', 'Italic', 'Ctrl/Cmd+I', html`<span class="md-letter md-letter-italic">I</span>`)}
      ${button(
        'strikethrough',
        'Strikethrough',
        'Ctrl/Cmd+Shift+X',
        html`<span class="md-letter md-letter-strike">S</span>`
      )}
      <span class="md-sep" />
      ${button(
        'inlineCode',
        'Inline code',
        'Ctrl/Cmd+E',
        html`<span class="md-glyph">${'</>'}</span>`
      )}
      ${button('link', 'Link', 'Ctrl/Cmd+K', ICONS.link)}
      <span class="md-sep" />
      ${button('bulletList', 'Bullet list', 'Ctrl/Cmd+Shift+8', ICONS.bulletList)}
      ${button('numberedList', 'Numbered list', 'Ctrl/Cmd+Shift+7', ICONS.numberedList)}
      ${button('taskList', 'Task list', 'Ctrl/Cmd+Shift+9', ICONS.taskList)}
      <span class="md-sep" />
      ${button(
        'blockquote',
        'Blockquote',
        null,
        html`<span class="md-glyph md-quote-glyph">${'\u201C'}</span>`
      )}
      ${button('horizontalRule', 'Horizontal rule', null, ICONS.horizontalRule)}
      ${button('codeBlock', 'Code block', null, ICONS.codeBlock)}
      <div class="md-headings">
        <${Dropdown}
          triggerLabel=${html`<span class="md-glyph">Headings ▾</span>`}
          triggerClass="md-btn"
          triggerAriaLabel="Headings"
          open=${headingsOpen}
          onOpenChange=${(open) => {
            setHeadingsOpen(open)
            // Only a keyboard-driven close (Escape with the trigger or menu
            // holding focus) hands focus back to the editor. An outside click
            // close means the user aimed somewhere else on purpose — refocusing
            // there would yank them back mid-action.
            if (!open && document.activeElement?.closest?.('.md-headings')) refocus()
          }}
        >
          ${HEADING_LEVELS.map(
            (level) => html`
              <button
                type="button"
                class="md-menu-item"
                onMouseDown=${keepEditorFocus}
                onClick=${() => {
                  setHeadingsOpen(false)
                  run(`heading${level}`)
                }}
              >
                Heading ${level}
              </button>
            `
          )}
        <//>
      </div>
      <span class="md-sep" />
      ${button(
        'fullscreen',
        expanded ? 'Exit full screen' : 'Full screen',
        'Esc',
        expanded ? ICONS.collapse : ICONS.expand,
        onToggleFullscreen
      )}
    </div>
  `
}

// ---------- Markdown field ----------
// EditorView.updateListener -> markdown-it -> DOMPurify -> sibling preview pane, per docs/adr/0004-markdown-editor-codemirror.md. The CodeMirror instance is the source of truth for the field's value, so getValue/setValue read and write it directly rather than duplicating it into component state.
//
// Every markdown field carries its own generic **Insert ▾** dropdown (#132) — Image (opens the shared image-insert modal), Table (opens a Loop-style hover-grid size picker, #134), Section (a new custom field appended below this one) — replacing the single per-module "+ Insert asset" button that preceded it. Hidden in Rendered view along with every other editing affordance, since that view is read-only.

// The three-item menu behind every field's Insert ▾ (#132). Openness is controlled (the shared Dropdown's contract); each item closes the menu before acting, matching how SwimlaneChip's items dismiss through their parent.
function InsertDropdown({ onImage, onTable, onSection }) {
  const [open, setOpen] = useState(false)

  function pick(action) {
    setOpen(false)
    action()
  }

  return html`
    <${Dropdown}
      className="insert-dropdown"
      triggerLabel="Insert ▾"
      triggerClass="insert-trigger"
      menuRole="menu"
      open=${open}
      onOpenChange=${setOpen}
    >
      <button type="button" role="menuitem" onClick=${() => pick(onImage)}>Image</button>
      <button type="button" role="menuitem" onClick=${() => pick(onTable)}>Table</button>
      <button type="button" role="menuitem" onClick=${() => pick(onSection)}>Section</button>
    <//>
  `
}

// The Loop-style size grid behind Insert ▾ ▸ Table (#134): hovering or
// focusing a cell lights up the R×C rectangle it corners, the caption reads
// out the current size, and clicking inserts. Eight is a deliberate ceiling —
// bigger tables are one Tab-away from growing once they exist. The picker has
// no trigger of its own: InsertDropdown's Table item owns that moment, so the
// Dropdown renders only its menu via the body-function seam.
const TABLE_GRID_SIZE = 8

function TableGridPicker({ open, onOpenChange, onPick }) {
  const [hover, setHover] = useState(null)

  // A fresh open starts with no preview lit; without this the grid would
  // resurrect whatever corner the mouse last crossed.
  useEffect(() => {
    if (!open) setHover(null)
  }, [open])

  const cells = []
  for (let r = 1; r <= TABLE_GRID_SIZE; r++) {
    for (let c = 1; c <= TABLE_GRID_SIZE; c++) {
      cells.push(html`
        <button
          type="button"
          class="table-picker-cell${hover && r <= hover.r && c <= hover.c ? ' lit' : ''}"
          data-row=${r}
          data-col=${c}
          aria-label="${c} by ${r} table"
          onMouseEnter=${() => setHover({ r, c })}
          onFocus=${() => setHover({ r, c })}
          onClick=${() => {
            onOpenChange(false)
            onPick(r, c)
          }}
        />
      `)
    }
  }

  return html`
    <${Dropdown} className="table-picker" open=${open} onOpenChange=${onOpenChange} body=${({ menu }) => menu}>
      <div class="table-picker-grid" onMouseLeave=${() => setHover(null)}>${cells}</div>
      <div class="table-picker-caption" aria-live="polite">
        ${hover ? `${hover.c} × ${hover.r}` : 'Rows × Columns'}
      </div>
    <//>
  `
}

// Contextual table controls (#134): a strip above the formatting toolbar,
// present only while the caret sits inside a well-formed table. Every button
// funnels through the same run() seam as the toolbar — pure transform in,
// one transaction back — so each click is exactly one undo step, and on a
// malformed table every button is a silent no-op by construction.
function TableControlStrip({ run }) {
  const keepEditorFocus = (e) => e.preventDefault()
  const btn = (name, label, glyph) =>
    html`
      <button
        type="button"
        class="md-btn"
        data-command=${name}
        aria-label=${label}
        title=${label}
        tabindex="-1"
        onMouseDown=${keepEditorFocus}
        onClick=${() => run(name)}
      >
        <span class="md-glyph">${glyph}</span>
      </button>
    `
  return html`
    <div class="md-toolbar table-toolbar" role="group" aria-label="Table">
      ${btn('tableAddRowAbove', 'Add row above', '+↑')}
      ${btn('tableAddRowBelow', 'Add row below', '+↓')}
      ${btn('tableDeleteRow', 'Delete row', '−↓')}
      <span class="md-sep" />
      ${btn('tableAddColumnLeft', 'Add column left', '+←')}
      ${btn('tableAddColumnRight', 'Add column right', '+→')}
      ${btn('tableDeleteColumn', 'Delete column', '−→')}
      <span class="md-sep" />
      ${btn('tableCycleAlignment', 'Cycle column alignment', '⇄')}
    </div>
  `
}

function MarkdownField({ field, onRegister, onRequestImage, onRequestSection }) {
  const hostRef = useRef(null)
  const previewRef = useRef(null)
  // The editor-control methods registered up to ModuleCard (getValue/setValue/insertAtCursor) are captured here too, so this field's own Insert ▾ items act on its own cursor without round-tripping through the module.
  const controlRef = useRef(null)
  // The toolbar lives inside this wrapper, so focus never actually leaves the
  // field when a button is pressed — see the focusin/focusout pair below.
  const wrapperRef = useRef(null)
  const viewRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const [headingsOpen, setHeadingsOpen] = useState(false)
  // True while THIS field's wrapper is the document's full-screen element (#135). State follows the native `fullscreenchange` event — not the toggling click alone — so a browser-driven exit (Esc, F11-ish browser chrome, or the element leaving the DOM) un-expands us exactly when the platform does.
  const [expanded, setExpanded] = useState(false)

  // Full-screen expansion (#135): the wrapper (label + guidance + split panes
  // + Insert ▾) is what requests full-screen, so everything the field owns
  // travels into it together and CSS re-flows it to fill the viewport. While
  // any field is expanded we also stamp `data-field-fullscreen` on <html> —
  // the view-mode bar reads that to unstick itself for the duration.
  useEffect(() => {
    // Captured once: Preact detaches refs synchronously during unmount, but
    // runs this cleanup in a deferred flush afterwards — by then
    // wrapperRef.current is null, so the captured node is the only way the
    // cleanup can still recognise our own wrapper.
    const el = wrapperRef.current
    function handleFullscreenChange() {
      setExpanded(document.fullscreenElement === el)
      // Keyed to *whether anything* holds full-screen, not to this field's
      // own match: every mounted field's listener fires for the same
      // transition, so a bystander field must not erase the stamp the
      // expanded field just wrote. (Only one element can be full-screen at a
      // time, so all handlers converge on the same answer.)
      if (document.fullscreenElement) document.documentElement.setAttribute('data-field-fullscreen', '')
      else document.documentElement.removeAttribute('data-field-fullscreen')
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      // Unmounted while holding full-screen (e.g. a future interaction tears
      // down the screen mid-expansion): leave full-screen AND clear the stamp
      // here — our change listener is already gone by the time the exit
      // fires, so nobody else would remove it.
      if (el && document.fullscreenElement === el) {
        document.documentElement.removeAttribute('data-field-fullscreen')
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  function toggleFullscreen() {
    if (!wrapperRef.current) return
    if (document.fullscreenElement === wrapperRef.current) {
      document.exitFullscreen().catch(() => {})
    } else {
      wrapperRef.current.requestFullscreen().catch(() => {})
    }
  }
  // Table awareness (#134): the control strip and its gating ride on this
  // flag, refreshed from every selection/doc update below.
  const [inTable, setInTable] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    const editableCompartment = new Compartment()
    const state = EditorState.create({
      doc: field.value ?? '',
      extensions: [
        // The shortcut layer goes before basicSetup so Mod-b/Mod-i and friends
        // win over anything the default keymaps would claim first.
        markdownToolbarKeymap,
        basicSetup,
        markdown(),
        editableCompartment.of(editableExtension(viewMode.value)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) renderPreview(previewRef.current, update.state.doc.toString())
          // Selection moves count too — Tab-walking cells must flip the strip
          // on/off as the caret crosses the table's edge.
          if (update.docChanged || update.selectionSet) {
            setInTable(!!findTable(update.state.doc.toString(), update.state.selection.main.head))
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    renderPreview(previewRef.current, field.value ?? '')

    // Track the global view-mode signal for as long as this editor is mounted, so switching into/out of Rendered toggles read-only live — the ticket requires it enforced immediately, not just on next mount.
    const stopViewModeSync = effect(() => {
      view.dispatch({ effects: editableCompartment.reconfigure(editableExtension(viewMode.value)) })
    })

    // Inserts a snippet at the current cursor position (or over the current selection), on its own line — "clicking one inserts its reference at the trigger point" (#80). The preview updates via the same updateListener/docChanged path a normal edit takes.
    function insertAtCursor(snippet) {
      const { from, to } = view.state.selection.main
      const needsLeadingNewline = from > 0 && view.state.doc.sliceString(from - 1, from) !== '\n'
      const insertText = `${needsLeadingNewline ? '\n' : ''}${snippet}\n`
      view.dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length },
      })
      view.focus()
    }
    controlRef.current = { insertAtCursor }

    let hideToolbarTimer = null
    function handleFocusIn() {
      clearTimeout(hideToolbarTimer)
      setFocused(true)
    }
    // Toolbar visibility follows real focus, but moving focus *within* the
    // field (to a toolbar button or the headings menu) must not flash the
    // bar away — hence checking where focus is headed rather than hiding
    // unconditionally. Rendered mode hides the bar regardless via the render.
    //
    // The hide itself must also wait out the mouse sequence that caused the
    // blur: focus moves during *mousedown*, and unmounting the bar right then
    // shifts layout before *mouseup* lands, so the click that blurred us never
    // dispatches at all (observed as a silently swallowed "Save Context"
    // press). Deferring the unmount a tick lets that first click complete —
    // the same grace period every dismiss-on-outside-click popover needs.
    function handleFocusOut(e) {
      if (wrapperRef.current?.contains(e.relatedTarget)) return
      clearTimeout(hideToolbarTimer)
      hideToolbarTimer = setTimeout(() => setFocused(false), 150)
    }
    view.dom.addEventListener('focusin', handleFocusIn)
    view.dom.addEventListener('focusout', handleFocusOut)

    onRegister({
      getValue: () => view.state.doc.toString(),
      setValue: (text) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
        renderPreview(previewRef.current, text ?? '')
      },
      insertAtCursor,
    })

    return () => {
      view.dom.removeEventListener('focusin', handleFocusIn)
      view.dom.removeEventListener('focusout', handleFocusOut)
      clearTimeout(hideToolbarTimer)
      viewRef.current = null
      stopViewModeSync()
      view.destroy()
    }
    // One editor per mount — the enclosing stage screen remounts wholesale (keyed by stage id) on stage switch, matching the old full-rebuild behaviour, so this never needs to react to `field` changing in place.
    // eslint-disable-next-line
  }, [])

  const runCommand = useCallback((name, extra) => runMarkdownCommand(viewRef.current, name, extra), [])
  const refocusEditor = useCallback(() => viewRef.current?.focus(), [])
  // Visible while the field holds focus, and stays up while the headings
  // menu is open (the menu click moves focus to the trigger button). While
  // the field is full-screen the bar is unconditional (#135): the expanded
  // panel must keep its toolbar even if focus wanders into the preview.
  const showToolbar = focused || headingsOpen || expanded
  const showTableStrip = showToolbar && inTable
  // The grid picker inserts straight through the command dispatcher, so the
  // new table arrives with blank-line hygiene and a parked caret for free.
  // The grid's rectangle counts the header row, the engine's `rows` counts
  // body rows — hence the -1 (and a floor of one body row, since a header
  // alone can't take the caret).
  const pickTable = useCallback(
    (rows, cols) => {
      runMarkdownCommand(viewRef.current, 'insertTable', { rows: Math.max(rows - 1, 1), cols })
      viewRef.current?.focus()
    },
    []
  )

  return html`
    <div class="field field-markdown" ref=${wrapperRef}>
      <label>${field.title}${field.required ? ' *' : ''}</label>
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="split">
        <div class="editor-pane">
          ${viewMode.value !== 'rendered' && showToolbar
            ? html`
                ${showTableStrip ? html`<${TableControlStrip} run=${runCommand} />` : null}
                <${MarkdownToolbar}
                  run=${runCommand}
                  refocus=${refocusEditor}
                  headingsOpen=${headingsOpen}
                  setHeadingsOpen=${setHeadingsOpen}
                  expanded=${expanded}
                  onToggleFullscreen=${toggleFullscreen}
                />
              `
            : null}
          <div class="editor-host" ref=${hostRef}></div>
        </div>
        <div class="preview" ref=${previewRef}></div>
      </div>
      ${viewMode.value !== 'rendered'
        ? html`
            <div class="insert-area">
              <${InsertDropdown}
                onImage=${() => onRequestImage?.()}
                onTable=${() => setPickerOpen(true)}
                onSection=${() => onRequestSection?.()}
              />
              <${TableGridPicker} open=${pickerOpen} onOpenChange=${setPickerOpen} onPick=${pickTable} />
            </div>
          `
        : null}
    </div>
  `
}

// ---------- List field ----------
function ListField({ field, onRegister }) {
  const rowsRef = useRef(field.value?.length ? [...field.value] : [''])
  const [, bump] = useState(0)
  const rerender = () => bump((n) => n + 1)

  useEffect(() => {
    onRegister({
      getValue: () => rowsRef.current.filter((v) => v.trim() !== ''),
      setValue: (values) => {
        rowsRef.current = values?.length ? [...values] : ['']
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  function updateRow(i, value) {
    rowsRef.current = rowsRef.current.map((v, idx) => (idx === i ? value : v))
    rerender()
  }
  function removeRow(i) {
    rowsRef.current = rowsRef.current.filter((_, idx) => idx !== i)
    rerender()
  }
  function addRow() {
    rowsRef.current = [...rowsRef.current, '']
    rerender()
  }

  return html`
    <div class="field field-list">
      <label>${field.title}${field.required ? ' *' : ''}</label>
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="list-rows">
        ${rowsRef.current.map(
          (value, i) => html`
            <div class="list-row" key=${i}>
              <input type="text" value=${value} onInput=${(e) => updateRow(i, e.currentTarget.value)} />
              <button type="button" class="btn small" onClick=${() => removeRow(i)}>Remove</button>
            </div>
          `
        )}
      </div>
      <button type="button" class="btn small" onClick=${addRow}>Add</button>
    </div>
  `
}

// ---------- One module's card: fields + its own Save button/status ----------
function ModuleCard({ mod, stageId, onFieldRegistered }) {
  const [status, setStatus] = useState('')
  // Which markdown field the image-insert modal targets: the one whose own Insert ▾ → Image was clicked (each field owns its dropdown now, #132 — no more module-level affordance guessing from focus). Null = closed.
  const [imageFieldId, setImageFieldId] = useState(null)
  // Which field the new Section goes below: the one whose Insert ▾ → Section was clicked. Null = dialog closed.
  const [sectionAfterId, setSectionAfterId] = useState(null)
  // Editor controls keyed by FIELD ID (not array index): inserting a Section shifts every later field's display index without remounting it (components are keyed by field id), so index-keyed lookups would go stale mid-session. Ids never shift.
  const controlsRef = useRef({})

  async function handleSave() {
    const fields = {}
    // The document's section sequence, replayed for the writer (#132): defined fields and custom fields in exactly the displayed order, so a Section inserted below its neighbour stays there across save/reload.
    const layout = []
    mod.fields.forEach((field) => {
      const value = controlsRef.current[field.id]?.getValue()
      fields[field.id] = value
      layout.push(field.custom ? { custom: { id: field.id, title: field.title, value } } : { field: field.id })
    })
    setStatus('Saving…')
    // `slug` is required here (not just `stage`) now that a server can host any number of instances at once with no fixed default (#88/#92) — without it, this PUT only ever resolved against whichever slug (if any) the server happened to be started with, silently 400ing for every other instance a multi-instance deployment serves. Surfaced by #94's own "Open instance ... allows editing end-to-end" acceptance criterion once a freshly adopted/created instance had no such server-pinned default to fall back on.
    const params = new URLSearchParams({ stage: stageId, slug: currentSlug.value })
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/modules/${mod.id}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: mod.status, owner: mod.owner, fields, layout }),
    })
    if (!res.ok) {
      setStatus('Save failed.')
      return
    }
    const instanceStatus = await res.json()
    const thisModule = instanceStatus.modules.find((m) => m.id === mod.id)
    setStatus(
      thisModule?.complete ? 'Saved — complete.' : `Saved — outstanding: ${thisModule?.outstanding.join(', ') || 'none'}`
    )
  }

  function handleInsertImage(asset) {
    controlsRef.current[imageFieldId]?.insertAtCursor?.(assetReference(asset))
    setImageFieldId(null)
  }

  // Insert ▾ → Section (#132): appends a new custom markdown field immediately below the requesting field. Client-side only until the next Save — the custom field joins the module's field list (and hence the save payload's layout), and the parser preserves its `## <title>` block from then on.
  function handleInsertSection(title) {
    const afterIndex = mod.fields.findIndex((f) => f.id === sectionAfterId)
    const newField = {
      id: uniqueCustomFieldClientId(),
      title: title.trim() ? title.trim() : 'Untitled section',
      type: 'markdown',
      required: false,
      guidance: null,
      value: '',
      example: null,
      custom: true,
    }
    const fields = [...mod.fields]
    fields.splice(afterIndex + 1, 0, newField)
    instanceData.value = {
      ...instanceData.value,
      modules: instanceData.value.modules.map((m) => (m.id === mod.id ? { ...m, fields } : m)),
    }
    setSectionAfterId(null)
  }

  return html`
    <section class="module">
      <h2>${mod.title}</h2>
      ${mod.purpose ? html`<p class="purpose">${mod.purpose}</p>` : null}
      ${mod.fields.map((field) => {
        const onRegister = (control) => {
          controlsRef.current[field.id] = control
          onFieldRegistered(field, control)
        }
        return field.type === 'list'
          ? html`<${ListField} key=${field.id} field=${field} onRegister=${onRegister} />`
          : html`<${MarkdownField}
              key=${field.id}
              field=${field}
              onRegister=${onRegister}
              onRequestImage=${() => setImageFieldId(field.id)}
              onRequestSection=${() => setSectionAfterId(field.id)}
            />`
      })}
      <div class="save-status">${status}</div>
      <button type="button" class="btn primary" onClick=${handleSave}>Save ${mod.title}</button>
      ${imageFieldId !== null
        ? html`<${AssetInsertModal} onInsert=${handleInsertImage} onClose=${() => setImageFieldId(null)} />`
        : null}
      ${sectionAfterId !== null
        ? html`<${SectionDialog} onConfirm=${handleInsertSection} onClose=${() => setSectionAfterId(null)} />`
        : null}
    </section>
  `
}

// A client-side-unique id for a just-inserted custom field (#132) — only ever a handle for component keys and the in-flight save payload; the server re-derives deterministic ids from the stored headings on every read.
function uniqueCustomFieldClientId() {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// The Insert ▾ → Section prompt (#132): asks for the optional one-line title (rendered as the block's ## heading; blank becomes "Untitled section") and inserts the new block below the requesting field on confirm. Same modal shape as AssetInsertModal and the confirm dialogs above.
function SectionDialog({ onConfirm, onClose }) {
  const [title, setTitle] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="New section">
        <h3>New section</h3>
        <div class="upload-field">
          <label class="field-label">Title (optional)</label>
          <input
            ref=${inputRef}
            class="text-field"
            type="text"
            placeholder="e.g. Risks we're carrying forward"
            value=${title}
            onInput=${(e) => setTitle(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && onConfirm(title)}
          />
        </div>
        <p class="guidance">Adds an editable block below this field. Its title renders as a "##" heading and is preserved across saves.</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
          <button type="button" class="btn primary" onClick=${() => onConfirm(title)}>Insert section</button>
        </div>
      </div>
    </div>
  `
}

// ---------- Insert-image modal: Upload new / Choose existing ----------
// Opened by any markdown field's Insert ▾ → Image item (#132, which renamed the wording Asset → Image throughout the UI while leaving `asset:<id>` storage and the /api routes untouched). Hidden in Rendered view along with every other editing affordance (see MarkdownField/ModuleCard). Ported from Variant A of web/prototypes/asset-insertion.prototype.html (#73), the variant #74 locked in: a modal with two tabs, the "Upload new" tab blocked by an inline error until both the file and the mandatory source-location field are valid.
function AssetInsertModal({ onInsert, onClose }) {
  const [tab, setTab] = useState('upload')
  const [file, setFile] = useState(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [existing, setExisting] = useState(null)
  const [existingError, setExistingError] = useState('')

  useEffect(() => {
    if (tab !== 'existing' || existing !== null) return
    fetchAssets(currentSlug.value)
      .then(setExisting)
      .catch((err) => setExistingError(err.message))
  }, [tab, existing])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function handleSubmitUpload() {
    if (!source.trim()) {
      setSourceError('Source location is required — link to the originating file (e.g. a Draw.io diagram).')
      return
    }
    if (!file) {
      setSourceError('An image file is required.')
      return
    }
    setSourceError('')
    setSubmitting(true)
    try {
      const dataBase64 = await readFileAsBase64(file)
      const asset = await uploadAsset({ slug: currentSlug.value, filename: file.name, dataBase64, name, source })
      onInsert(asset)
    } catch (err) {
      setSourceError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Insert image">
        <h3>Insert image</h3>
        <div class="modal-tabs">
          <button
            type="button"
            class=${tab === 'upload' ? 'active' : ''}
            aria-pressed=${tab === 'upload'}
            onClick=${() => setTab('upload')}
          >
            Upload new
          </button>
          <button
            type="button"
            class=${tab === 'existing' ? 'active' : ''}
            aria-pressed=${tab === 'existing'}
            onClick=${() => setTab('existing')}
          >
            Choose existing
          </button>
        </div>

        ${tab === 'upload'
          ? html`
              <div class="upload-field">
                <label class="field-label">Image file</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange=${(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Name (optional)</label>
                <input
                  class="text-field"
                  type="text"
                  value=${name}
                  placeholder=${file?.name ?? 'Defaults to the file name'}
                  onInput=${(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Source location (required)</label>
                <input
                  class=${'text-field' + (sourceError ? ' has-error' : '')}
                  type="text"
                  value=${source}
                  placeholder="https://draw.io/diagrams/…"
                  onInput=${(e) => {
                    setSource(e.currentTarget.value)
                    if (sourceError) setSourceError('')
                  }}
                />
                ${sourceError ? html`<div class="inline-error">${sourceError}</div>` : null}
              </div>
              <div class="modal-actions">
                <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
                <button type="button" class="btn primary" disabled=${submitting} onClick=${handleSubmitUpload}>
                  ${submitting ? 'Inserting…' : 'Insert'}
                </button>
              </div>
            `
          : html`
              ${existingError ? html`<p class="load-error">${existingError}</p>` : null}
              ${existing === null && !existingError ? html`<p class="loading">Loading…</p>` : null}
              ${existing !== null
                ? html`
                    <div class="grid-library">
                      ${existing.length === 0
                        ? html`<p class="empty">No images yet — switch to "Upload new" to add the first one.</p>`
                        : existing.map(
                            (asset) => html`
                              <button type="button" class="card" key=${asset.id} onClick=${() => onInsert(asset)}>
                                <img src=${assetFileUrl(asset.id, currentSlug.value)} alt=${asset.name} />
                                <div class="name">${asset.name}</div>
                              </button>
                            `
                          )}
                    </div>
                  `
                : null}
            `}
      </div>
    </div>
  `
}

// ---------- Image library screen ----------
// The instance-level screen (#80, wording renamed Asset → Image by #132): every asset registered against this instance as a thumbnail-grid card, each flagged USED IN N / UNUSED so orphaned images are visible without opening every module. The route stays /assets and the storage/API naming stays "asset" (#132's own constraint) — only the visible words changed.
function AssetLibraryPage() {
  const [assets, setAssets] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const slug = currentSlug.value
    if (!slug) return
    fetchAssets(slug)
      .then(setAssets)
      .catch((err) => setError(err.message))
  }, [])

  return html`
    <main class="asset-library">
      <a class="back-link" href="/">← Back to module editor</a>
      <h1>Image library</h1>
      ${error ? html`<p class="load-error">${error}</p>` : null}
      ${assets === null && !error ? html`<p class="loading">Loading…</p>` : null}
      ${assets !== null
        ? html`
            <div class="lib-grid">
              ${assets.length === 0
                ? html`<p class="empty">No images registered yet.</p>`
                : assets.map(
                    (asset) => html`
                      <div class="card" key=${asset.id}>
                        <img src=${assetFileUrl(asset.id, currentSlug.value)} alt=${asset.name} />
                        <div class="name">${asset.name}</div>
                        <div class="meta">
                          ${asset.uploadedBy ? html`${asset.uploadedBy} · ` : null}
                          <a href=${asset.source} target="_blank" rel="noreferrer">${asset.source}</a>
                        </div>
                        <span class=${'stamp used-badge ' + (asset.usedIn.length ? 'agreed' : 'review')}>
                          ${asset.usedIn.length ? `USED IN ${asset.usedIn.length}` : 'UNUSED'}
                        </span>
                      </div>
                    `
                  )}
            </div>
          `
        : null}
    </main>
  `
}

// ---------- Render dialog (#114) ----------
// A single "Render" button, in the view-toggle bar (see ViewModeToolbar),
// opens this dialog rather than the old one-button-per-artefact layout —
// same dialog whether the current stage produces one artefact (e.g. `soap`)
// or several sharing a gate (e.g. `sad`/`ssad`), per the ticket's "not a
// special case" acceptance criterion. Follows the same
// modal-backdrop/modal/modal-actions shape as AssetInsertModal and the
// work-item sync confirm modal above.
function RenderDialog({ instance, onClose }) {
  const [status, setStatus] = useState('')
  const [renderingId, setRenderingId] = useState(null)

  async function handleRender(artefact) {
    setRenderingId(artefact.id)
    setStatus('Rendering…')
    // See ModuleCard's handleSave for why `?slug=` is required here now — the same gap, for the module editor's own "Render" action.
    const slug = currentSlug.value
    const res = await apiFetchForInstance(slug, `/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, {
      method: 'POST',
    })
    const body = await res.json()
    // Azure-DevOps-backed instances report `azureDevOpsPath` (where the pandoc-rendered .docx was pushed back to, in the same repo the rest of the instance's data lives in); local instances report `docxPath` (a path on the machine running `gantry serve`).
    setStatus(
      res.ok
        ? `Rendered to ${body.azureDevOpsPath ?? body.docxPath}`
        : `Render failed: ${body.message ?? body.error}`
    )
    setRenderingId(null)
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Render an artefact">
        <h3>Render</h3>
        ${instance.artefacts.length
          ? html`
              <ul class="render-artefact-list">
                ${instance.artefacts.map(
                  (artefact) => html`
                    <li key=${artefact.id}>
                      <button
                        type="button"
                        class="btn"
                        disabled=${renderingId === artefact.id}
                        onClick=${() => handleRender(artefact)}
                      >
                        ${renderingId === artefact.id ? 'Rendering…' : artefact.title}
                      </button>
                    </li>
                  `
                )}
              </ul>
            `
          : html`<p class="guidance">This stage has no artefacts to render yet.</p>`}
        <div class="save-status">${status}</div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>
  `
}

// ---------- Synced-fields panel (#111) ----------
// A new panel at the top of the instance screen (above the modules — see
// StageScreen) showing the current stage's synced fields, each its own
// distinct field rather than collapsed together: the work item type
// (defaulting to "Task"), a title auto-populated as "{instance name} —
// {stage title}" but overridable per stage, the linked work item's own
// current Status (read straight from Azure DevOps via #121's getWorkItem),
// the stage's Pull Request state (#120/#125's read), and the Assignee —
// inherited from the instance's own stored assignee but overridable per
// stage. Backed by GET/PUT /api/instance/synced-fields; title/assignee
// edits save on blur or Enter (the same affordance the dashboard's own
// assignee field uses), and an emptied field clears that override so the
// default/inherited value comes back. An instance with no parent work item
// linked at all shows a "Link to a work item" prompt in this panel's place
// instead of any fields.
function SyncedFieldsPanel({ instance }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  // Null means "not editing" — the input then shows the server's current value. Mirrors the dashboard assignee drafts' pattern without clobbering the loaded value on every unrelated rerender.
  const [titleDraft, setTitleDraft] = useState(null)
  const [assigneeDraft, setAssigneeDraft] = useState(null)
  // A ref (not state): save() reads it synchronously to debounce itself, and no render ever depends on it — the status line already reports the in-flight save.
  const savingRef = useRef(false)

  const stageId = instance.stage.id

  useEffect(() => {
    let cancelled = false
    async function load() {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      try {
        // `apiFetchForInstance` (not plain `apiFetch`) — same reason loadInstance uses it: this request may target a workspace with its own PAT override (#104).
        const res = await apiFetchForInstance(currentSlug.value, `/api/instance/synced-fields?${params}`)
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message ?? body.error ?? `Failed to load synced fields (${res.status})`)
        if (cancelled) return
        setData(body)
        setTitleDraft(null)
        setAssigneeDraft(null)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // StageScreen remounts this panel wholesale on stage switch (keyed by stage id), so this only ever fires once per mount.
    // eslint-disable-next-line
  }, [])

  async function save(updates) {
    // One save in flight at a time — a rapid double-Enter (or blur-then-Enter) must not fire two PUTs.
    if (savingRef.current) return
    savingRef.current = true
    setStatus('Saving…')
    try {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      const res = await apiFetchForInstance(currentSlug.value, `/api/instance/synced-fields?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Save failed (${res.status})`)
      setData(body)
      setTitleDraft(null)
      setAssigneeDraft(null)
      setStatus('Saved.')
    } catch (err) {
      setStatus(`Save failed: ${err.message}`)
    } finally {
      savingRef.current = false
    }
  }

  function commitTitle() {
    if (!data || titleDraft === null || titleDraft === data.title) return
    // An emptied (or whitespace-only) field clears the override — the auto-populated default comes back. Saved trimmed, matching the assignee field below.
    const trimmed = titleDraft.trim()
    save({ title: trimmed ? trimmed : '' })
  }

  function commitAssignee() {
    if (!data || assigneeDraft === null || assigneeDraft === data.assignee) return
    // Same rule: emptying the field reverts to the inherited instance assignee.
    save({ assignee: assigneeDraft.trim() ? assigneeDraft.trim() : '' })
  }

  if (error) {
    return html`
      <section class="synced-fields-panel">
        <h2>Synced fields</h2>
        <p class="load-error">${error}</p>
      </section>
    `
  }

  if (!data) {
    return html`
      <section class="synced-fields-panel">
        <h2>Synced fields</h2>
        <p class="loading">Loading…</p>
      </section>
    `
  }

  // Unlinked at all: the prompt takes this panel's place — no fields shown.
  // (#127 removed the instance screen's own freetext link form, so this is
  // the only linking surface left for a pre-existing unlinked instance to
  // discover — pointing at where linking actually happens now.)
  if (!data.linked) {
    return html`
      <section class="synced-fields-panel">
        <h2>Synced fields</h2>
        <p class="guidance">
          <strong>Link to a work item</strong> to see this stage's synced fields (type, title, status, Pull Request
          state and assignee). Linking happens when the instance is created, via the "+ New Workspace" wizard's
          work-item step.
        </p>
      </section>
    `
  }

  const pr = data.pullRequest

  return html`
    <section class="synced-fields-panel">
      <h2>Synced fields</h2>
      <div class="synced-fields-grid">
        <div class="synced-field">
          <span class="field-label">Type</span>
          <span class="synced-value">${data.type}</span>
        </div>
        <div class="synced-field synced-field-wide">
          <label class="field-label" for="synced-title">Title${data.titleOverridden ? ' · overridden' : ''}</label>
          <input
            id="synced-title"
            class="text-field"
            type="text"
            placeholder=${`${instance.slug} — ${instance.stage.title}`}
            value=${titleDraft ?? data.title}
            onInput=${(e) => setTitleDraft(e.currentTarget.value)}
            onBlur=${commitTitle}
            onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
        <div class="synced-field">
          <span class="field-label">Status</span>
          <span class="synced-value">${data.workItemId ? html`#${data.workItemId} · ${data.workItemState ?? '—'}` : '—'}</span>
        </div>
        <div class="synced-field synced-field-wide">
          <span class="field-label">Pull request</span>
          <span class="synced-value">
            ${pr
              ? html`#${pr.id} — ${pr.status}${pr.reviewState !== 'pending' ? ` (${pr.reviewState})` : ''}`
              : 'No pull request open'}
          </span>
        </div>
        <div class="synced-field">
          <label class="field-label" for="synced-assignee">Assignee${data.assigneeInherited ? '' : ' · overridden'}</label>
          <${IdentityPicker}
            value=${assigneeDraft ?? data.assignee}
            onChange=${(uniqueName) => {
              setAssigneeDraft(uniqueName)
              // Commit immediately on select (no blur-based commit needed — the picker's selection is already definitive)
              if (!data || uniqueName === data.assignee) return
              save({ assignee: uniqueName.trim() ? uniqueName.trim() : '' })
            }}
            placeholder=${instance.assignee ? `${instance.assignee} (inherited)` : 'Inherited from the instance'}
            slug=${currentSlug.value}
          />
        </div>
      </div>
      <div class="save-status">${status}</div>
    </section>
  `
}

// ---------- Azure DevOps work-item link + confirmed gate-pass sync (#103) ----------
// One instance-level panel, shown once per stage screen (below the modules — see StageScreen; Render itself moved to the view-toggle bar, #114) rather than in AppHeader, since "which stage's work item" is stage-scoped even though the *link* itself is instance-level. Unlinked: renders nothing at all — #127 removed this panel's freetext link form (organization/project/parent id/type) entirely, since linking now happens at instance creation (the "+ New Workspace" wizard's link step) and an unlinked instance's "Link to a work item" prompt already takes the synced-fields panel's place above (see SyncedFieldsPanel). Linked: shows the parent id and this stage's own child work item id, plus a "Check gate & sync" action that runs the existing check first and only opens the confirm-before-push modal (mirroring PatPromptModal's shape) if the gate genuinely passes — declining it (or the gate failing) never calls POST /api/instance/work-items/sync at all, so the work item's state is left exactly as it was (#103's "declining leaves the work item's state unchanged" acceptance criterion).
function WorkItemPanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)

  const stageId = instance.stage.id
  const workItem = instance.workItem
  const stageWorkItemId = workItem?.stages?.[stageId]

  if (!workItem) return null

  // "Check gate & sync": runs the same check the dashboard's own Check action does — only once it genuinely PASSes does this open the confirm modal; a FAIL (or a check-request failure) reports status and stops there, exactly as if no linked work item existed at all.
  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    const res = await apiFetch(`/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
      setStatus(`FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`)
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  async function handleConfirmSync() {
    setConfirming(false)
    setStatus('Pushing state to work item…')
    const res = await apiFetch(`/api/instance/work-items/sync?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json().catch(() => ({}))
    setStatus(
      res.ok
        ? `Pushed state "${body.state}" to work item #${body.workItemId}.`
        : `Sync failed: ${body.message ?? body.error}`
    )
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — work item state left unchanged.')
  }

  return html`
    <section class="work-item-panel">
      <h2>Azure DevOps work item</h2>
      <p>
        Linked to parent work item #${workItem.parentId} (${workItem.organization}/${workItem.project}, type "${workItem.workItemType}").
      </p>
      <p>This stage's work item: ${stageWorkItemId ? html`#${stageWorkItemId}` : '—'}</p>
      <button type="button" class="btn" onClick=${handleCheckAndMaybeConfirm}>Check gate & sync work item</button>
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm work item state update">
                <h3>Push a state update?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to push a new state — drawn from
                  work item #${stageWorkItemId}'s own configured type — to Azure DevOps. Declining leaves that work
                  item's state unchanged.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmSync}>Confirm & push</button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- Stage advancement (local instances only; #115, ADR-0012) ----------
// The self-serve "Advance to next stage" action: never rendered at all for
// a Workspace-backed instance (`instance.workspaceBacked` — that one always
// advances via its own Pull Request flow instead, ADR-0014/#122-#125), and
// only while viewing the instance's own *current* stage (`instance.stage.id
// === instance.currentStageId`) — advancing moves this instance's own
// persisted stage pointer forward from wherever it currently sits, so it
// never makes sense to offer it while browsing an earlier or later stage
// via the stage switcher. Mirrors WorkItemPanel's own check-then-confirm
// shape: "Advance to next stage" runs the same gate check every other
// gated action in this app runs, and only a genuine PASS opens the confirm
// dialog — declining it (or a FAIL) leaves the instance's stage genuinely
// unchanged.
function AdvanceStagePanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)

  const isFinalStage = instance.stages[instance.stages.length - 1]?.id === instance.stage.id
  if (instance.workspaceBacked || instance.stage.id !== instance.currentStageId || isFinalStage) return null

  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    const res = await apiFetch(`/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
      setStatus(`FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`)
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  async function handleConfirmAdvance() {
    setConfirming(false)
    setStatus('Advancing…')
    const res = await apiFetch(`/api/instance/advance-stage?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Advance failed: ${body.message ?? body.error}`)
      return
    }
    setStatus(`Advanced to "${body.toStage.title}".`)
    // Reset to no explicit stage so the form now shows the instance's new
    // current stage — otherwise `viewedStage` would still hold this
    // (now-completed) stage's id and the screen would appear unchanged.
    //
    // Assigning `viewedStage.value` here already re-triggers the shared
    // instance-loading effect (near the top of this file) *whenever it's
    // a genuine change* — e.g. the user had at some point explicitly
    // clicked this (the current) stage's own nav button, leaving
    // `viewedStage.value` set to its id rather than `null`. Also calling
    // `loadInstance` directly below in that case would race that effect's
    // own fetch (mirrors the exact hazard `ModuleEditorPage`'s own
    // `batch()` comment describes) — so this only fetches directly when
    // `viewedStage.value` was already `null`, the one case where setting
    // it to `null` again is a no-op the effect will never react to.
    const effectWillReload = viewedStage.value !== null
    viewedStage.value = null
    if (!effectWillReload) {
      instanceData.value = await loadInstance(currentSlug.value, null)
    }
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — stage left unchanged.')
  }

  return html`
    <section class="advance-stage-panel">
      <h2>Stage advancement</h2>
      <button type="button" class="btn" onClick=${handleCheckAndMaybeConfirm}>Advance to next stage</button>
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm stage advancement">
                <h3>Advance to the next stage?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to move this instance on to its
                  next stage. Declining leaves it at "${instance.stage.title}".
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmAdvance}>Confirm & advance</button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- Request approval (Workspace-backed instances only; #124, ADR-0014) ----------
// The Workspace-backed counterpart to AdvanceStagePanel above: opens this
// stage's own real approval gate — a Pull Request from its branch into
// "main" — once the gate has genuinely passed, rather than moving a local
// instance's own stage pointer directly. Mirrors AdvanceStagePanel's/
// WorkItemPanel's check-then-confirm shape exactly: "Request approval" runs
// the same gate check every other gated action in this app runs, and only a
// genuine PASS opens the confirm dialog — declining it (or a FAIL) opens no
// Pull Request. Never rendered for a local instance (the opposite condition
// from AdvanceStagePanel), and — like AdvanceStagePanel — only while viewing
// the instance's own *current* stage, since that's the only stage a save
// can ever actually be landing commits on today (a later stage only starts
// once #125's own "advance the stage" moves the current-stage pointer
// forward, which happens when its Check-status action merges this stage's
// own Pull Request). Once a Pull Request is open, the panel offers #125's
// "Check status" action in place of "Request approval" — reading the PR's
// reviewer votes, auto-merging on approval (advancing the stage), and
// reporting an explicit rejection/changes-requested distinctly from a
// still-pending review.
function RequestApprovalPanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [justOpened, setJustOpened] = useState(null)

  if (!instance.workspaceBacked || instance.stage.id !== instance.currentStageId) return null

  const stageId = instance.stage.id
  const openPullRequestId = justOpened?.pullRequestId ?? instance.pullRequests?.[stageId]

  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
      setStatus(`FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`)
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  async function handleConfirmRequest() {
    setConfirming(false)
    setStatus('Opening Pull Request…')
    const res = await apiFetchForInstance(
      currentSlug.value,
      `/api/instance/request-approval?slug=${encodeURIComponent(currentSlug.value)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Request approval failed: ${body.message ?? body.error}`)
      return
    }
    setJustOpened(body)
    setStatus(`Pull Request #${body.pullRequestId} opened — awaiting the Owner's review.`)
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — no Pull Request opened.')
  }

  // "Check status" (#125, ADR-0014): the explicitly-triggered read of the
  // open Pull Request's reviewer votes. On approval the server merges the
  // PR itself and advances the stage pointer, so a merged result reloads
  // the instance (reset to the new current stage, mirroring
  // AdvanceStagePanel's own post-advance reload) rather than leaving the
  // screen on the now-completed stage.
  async function handleCheckStatus() {
    setStatus('Checking Pull Request status…')
    const res = await apiFetchForInstance(
      currentSlug.value,
      `/api/instance/check-status?slug=${encodeURIComponent(currentSlug.value)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check status failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.merged) {
      if (body.review?.state === 'rejected') {
        setStatus(
          `Rejected — the Owner voted to reject Pull Request #${body.pullRequestId}. Address the feedback, then re-request approval.`
        )
      } else if (body.review?.state === 'changes-requested') {
        setStatus(
          `Changes requested — the Owner sent Pull Request #${body.pullRequestId} back for more work before approving.`
        )
      } else {
        setStatus(`Still pending — the Owner hasn't reviewed Pull Request #${body.pullRequestId} yet.`)
      }
      return
    }
    setStatus(
      body.advancedTo
        ? `Approved — Pull Request #${body.pullRequestId} merged; stage advanced to "${body.advancedTo.title}".`
        : `Approved — Pull Request #${body.pullRequestId} merged. This was the final stage; the instance is complete.`
    )
    const effectWillReload = viewedStage.value !== null
    viewedStage.value = null
    if (!effectWillReload) {
      instanceData.value = await loadInstance(currentSlug.value, null)
    }
  }

  return html`
    <section class="request-approval-panel">
      <h2>Request approval</h2>
      ${openPullRequestId
        ? html`
            <p>
              Pull Request #${openPullRequestId} is open, requesting approval for stage "${instance.stage.title}".
              ${justOpened?.webUrl
                ? html`<a href=${justOpened.webUrl} target="_blank" rel="noreferrer">Open in Azure DevOps</a>`
                : null}
            </p>
            <button type="button" class="btn" onClick=${handleCheckStatus}>Check status</button>
          `
        : html`<button type="button" class="btn" onClick=${handleCheckAndMaybeConfirm}>Request approval</button>`}
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm request approval">
                <h3>Open a Pull Request for review?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to open a Pull Request from this
                  stage's own branch into "main", requesting the Owner's approval. Declining opens nothing.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmRequest}>
                    Confirm & request approval
                  </button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- The viewed stage's whole screen: modules + work-item panel ----------
// Keyed by stage id from the parent (see ModuleEditorPage) so switching stages remounts this wholesale — fresh CodeMirror instances, matching the old full-DOM-rebuild behaviour. "Clear all fields" and "Render" now live in the view-toggle bar (see ViewModeToolbar, ModuleEditorPage) rather than here, so the field registry they depend on is owned by ModuleEditorPage instead — `onFieldRegistered` is threaded straight through.
function StageScreen({ instance, onFieldRegistered }) {
  return html`
    <main id="modules" data-view-mode=${viewMode.value}>
      <${SyncedFieldsPanel} key=${instance.workItem ? 'linked' : 'unlinked'} instance=${instance} />
      ${instance.modules.map(
        (mod) => html`
          <${ModuleCard}
            key=${mod.id}
            mod=${mod}
            stageId=${instance.stage.id}
            onFieldRegistered=${onFieldRegistered}
          />
        `
      )}
      <${AdvanceStagePanel} instance=${instance} />
      <${RequestApprovalPanel} instance=${instance} />
      <${WorkItemPanel} instance=${instance} />
    </main>
  `
}

// ---------- View-mode toolbar: Markdown/Split/Rendered segmented control ----------
// One toolbar for the whole editor screen (see web/lib/viewMode.js) — sits below AppHeader, above the viewed stage's screen, and (like AppHeader) is never remounted by a stage switch, so `viewMode` reads back the same value the author left it in after navigating fields/modules/stages.
const VIEW_MODE_LABELS = { markdown: 'Markdown', split: 'Split', rendered: 'Rendered' }
const VIEW_MODE_HOTKEY = { ctrlKey: true, shiftKey: true, key: 'v' }

// `instance` and `onClearAllFields` back the "Clear all fields" + "Render"
// pair moved here from the stage screen (#114) — both now sit on the right
// of this same bar, "Clear all fields" immediately left of "Render".
// `requestApprovalSlug` signals a "Request Approval" shortcut button —
// (#145 Part 1) clicking it scrolls to the RequestApprovalPanel and
// briefly highlights it so the author's eye is drawn down.
function ViewModeToolbar({ instance, onClearAllFields, requestApprovalSlug }) {
  const [renderOpen, setRenderOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key.toLowerCase() !== VIEW_MODE_HOTKEY.key) return
      if (e.ctrlKey !== VIEW_MODE_HOTKEY.ctrlKey || e.shiftKey !== VIEW_MODE_HOTKEY.shiftKey) return
      // Fires even while a CodeMirror editor or other field has focus — it's a distinctive combo unlikely to collide with normal editing, and the ticket asks for a hotkey that cycles the whole screen's view regardless of what the author was just doing.
      e.preventDefault()
      cycleViewMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function scrollToApprovalPanel() {
    const panel = document.querySelector('.request-approval-panel')
    if (!panel) return
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // Flash the panel with a brief background highlight so the user's eye is drawn down
    panel.classList.remove('flash')
    // Force a reflow so removing then adding the class triggers a fresh animation
    void panel.offsetHeight
    panel.classList.add('flash')
    // Remove the class after the animation completes so re-clicking re-triggers
    const onEnd = () => {
      panel.classList.remove('flash')
      panel.removeEventListener('animationend', onEnd)
    }
    panel.addEventListener('animationend', onEnd)
  }

  return html`
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="View mode">
        ${VIEW_MODES.map(
          (mode) => html`
            <button
              type="button"
              key=${mode}
              class=${'btn small' + (viewMode.value === mode ? ' active' : '')}
              aria-pressed=${viewMode.value === mode}
              onClick=${() => (viewMode.value = mode)}
            >
              ${VIEW_MODE_LABELS[mode]}
            </button>
          `
        )}
      </div>
      <div class="toolbar-actions">
        <button type="button" class="btn" onClick=${onClearAllFields}>Clear all fields</button>
        <button type="button" class="btn primary" onClick=${() => setRenderOpen(true)}>Render</button>
        ${requestApprovalSlug
          ? html`<button type="button" class="btn request-approval-btn" onClick=${scrollToApprovalPanel}>Request Approval</button>`
          : null}
      </div>
    </div>
    ${renderOpen ? html`<${RenderDialog} instance=${instance} onClose=${() => setRenderOpen(false)} />` : null}
  `
}

// ---------- Settings dropdown (#107) ----------
// From an instance screen, "Settings" is no longer a single link straight
// to the (now tab-free) Global Settings screen — it opens a small dropdown
// offering Global Settings, Workspace Settings (scoped to this instance's
// own workspace — never a picker across every registered workspace), and
// Instance Settings (assignee, read-only instance info, read-only
// work-item link details). Every link carries an explicit `from` back to
// this exact instance screen (`/instance/<slug>`) — not browser history —
// so each Settings screen's own back control returns here. Its open/close
// behaviour is the shared Dropdown's (web/lib/dropdown.js) — one open at a
// time per dropdown, closed by any click outside it or by Escape.
function SettingsMenu({ instance }) {
  const [open, setOpen] = useState(false)

  const from = encodeURIComponent(`/instance/${instance.slug}`)
  const slug = encodeURIComponent(instance.slug)

  return html`
    <${Dropdown}
      className="settings-menu"
      triggerLabel="Settings"
      menuRole="menu"
      open=${open}
      onOpenChange=${setOpen}
    >
      <a role="menuitem" href=${`/settings?from=${from}`}>Global Settings</a>
      <a role="menuitem" href=${`/settings/workspace?slug=${slug}&from=${from}`}>Workspace Settings</a>
      <a role="menuitem" href=${`/settings/instance?slug=${slug}&from=${from}`}>Instance Settings</a>
    <//>
  `
}

// ---------- Instance switcher (#112) ----------
// A workspace-scoped switcher living in AppHeader: defaults to the viewed
// instance's own workspace's *other* instances (so jumping to a sibling
// instance never requires returning to the Workspaces landing page — #112's
// own acceptance criteria), with an explicit escape hatch to cross into a
// different workspace's instances instead. Reuses the same unified
// `GET /api/instances` listing and `groupInstancesByWorkspace` grouping the
// dashboard (#102) already relies on, rather than adding a second
// server-side listing route — the client already has everything this
// needs, since every row already carries its own `workspace` (or none, for
// a local instance).
//
// The escape hatch's own UI copy deliberately avoids the word "workspace"
// ("Browse other instances" / "← Back", not "Switch workspace" / "← This
// workspace") — `groupInstancesByWorkspace` groups a local instance onto
// its own single-instance "group" exactly like a real Azure-DevOps-backed
// one (#102's own convention), so the escape hatch's *other groups* can
// just as easily be another unrelated local instance as a genuine
// Workspace. Workspace is a specific, reserved entity in this codebase (an
// Azure DevOps organization/project/repository, docs/adr/0009) — this file
// already renamed "Open workspace" to "Open editor" once (#96 vs #102) to
// avoid exactly this kind of collision, so new copy here must not
// re-introduce it by implying every escape-hatch destination is a
// Workspace when it may just be another local instance.
//
// Navigating a sibling instance is a plain `<a href="/instance/:slug">` —
// exactly the link ModuleEditorPage's own doc comment already documents as
// re-pinning every instance-scoped signal on slug change, so this needs no
// extra plumbing of its own.
function isWorkspaceGroup(group) {
  return Boolean(group?.instances[0]?.workspace)
}

function InstanceSwitcher({ slug }) {
  const [open, setOpen] = useState(false)
  const [instances, setInstances] = useState(null)
  const [error, setError] = useState('')
  // Resets to the default (own-workspace) view every time the menu is
  // freshly opened — a stale "cross-workspace" view left open from a
  // previous visit would otherwise greet the user with the wrong list.
  const [crossWorkspace, setCrossWorkspace] = useState(false)

  useEffect(() => {
    if (!open || instances !== null || error) return
    // Passes `slug` so this attaches *this* instance's own workspace PAT
    // override (#104), not just the global default — see loadInstances's
    // own doc comment for why that matters here specifically.
    loadInstances(slug)
      .then(setInstances)
      .catch((err) => setError(err.message))
  }, [open, instances, error, slug])

  // Its dismissal is the shared Dropdown's (web/lib/dropdown.js) — Escape or
  // any click outside the switcher closes it, same as the hand-rolled
  // window-listener version this replaced (there's no natural ancestor to
  // hang a click-outside-to-close on — the header isn't otherwise a click
  // target — so the Dropdown listens on the window directly).
  function handleOpenChange(next) {
    if (next) setCrossWorkspace(false)
    setOpen(next)
  }

  const groups = instances ? groupInstancesByWorkspace(instances) : []
  const currentGroup = groups.find((group) => group.instances.some((inst) => inst.slug === slug)) ?? null
  const siblings = currentGroup ? currentGroup.instances.filter((inst) => inst.slug !== slug) : []
  const otherGroups = groups.filter((group) => group.key !== currentGroup?.key)

  function renderInstanceLink(inst) {
    return html`
      <a key=${inst.slug} class="switcher-item" href="/instance/${inst.slug}" onClick=${() => setOpen(false)}>
        <span class="name">${inst.slug}</span>
        <span class="def">${inst.definition}</span>
      </a>
    `
  }

  return html`
    <${Dropdown}
      className="instance-switcher"
      triggerLabel="Switch instance ▾"
      open=${open}
      onOpenChange=${handleOpenChange}
    >
      ${error ? html`<p class="load-error">${error}</p>` : null}
      ${!error && instances === null ? html`<p class="loading">Loading…</p>` : null}
      ${instances !== null && !crossWorkspace
        ? html`
            <div class="switcher-section">
              <div class="switcher-heading">${isWorkspaceGroup(currentGroup) ? currentGroup.title : 'Local instance'}</div>
              ${siblings.length > 0
                ? siblings.map(renderInstanceLink)
                : isWorkspaceGroup(currentGroup)
                  ? html`<p class="switcher-empty">No other instances in this workspace.</p>`
                  : html`<p class="switcher-empty">No other instances — not part of a workspace.</p>`}
              ${otherGroups.length > 0
                ? html`
                    <button
                      type="button"
                      class="switcher-escape"
                      onClick=${() => setCrossWorkspace(true)}
                    >
                      Browse other instances →
                    </button>
                  `
                : null}
            </div>
          `
        : null}
      ${instances !== null && crossWorkspace
        ? html`
            <div class="switcher-section">
              <button type="button" class="switcher-back" onClick=${() => setCrossWorkspace(false)}>
                ← Back
              </button>
              ${otherGroups.map(
                (group) => html`
                  <div class="switcher-group" key=${group.key}>
                    <div class="switcher-heading">${group.title}</div>
                    ${group.instances.map(renderInstanceLink)}
                  </div>
                `
              )}
            </div>
          `
        : null}
    <//>
  `
}

// ---------- Header: title, stage line, free-browse stage nav ----------
// The theme toggle used to live here too, duplicated across this header,
// the Workspaces landing header, the setup wizard header, and Settings'
// header (#113) — now lives solely in Settings (web/pages/settings.js's
// SettingsHeader).
function AppHeader({ instance }) {
  return html`
    <header>
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <a class="btn small ghost" href="/">← Workspaces</a>
        <h1>${instance.slug} — ${instance.definition}</h1>
        <${InstanceSwitcher} slug=${instance.slug} />
        <a class="btn small ghost" href="/new-workspace">+ New Workspace</a>
        <${SettingsMenu} instance=${instance} />
      </div>
      <p id="stage-line">${instance.stage.title} (gate: ${instance.stage.gate})</p>
      <nav id="stage-nav">
        ${instance.stages.map((stage) => {
          const isCurrent = stage.id === instance.currentStageId
          const isViewed = stage.id === instance.stage.id
          return html`
            <button
              type="button"
              key=${stage.id}
              class=${'btn small' + (isViewed ? ' active' : '') + (isCurrent ? ' stage-current' : '')}
              onClick=${() => (viewedStage.value = stage.id)}
            >
              ${stage.title}${isCurrent ? ' (current)' : ''}
            </button>
          `
        })}
      </nav>
    </header>
  `
}

// ---------- Page: composes header + the viewed stage's screen ----------
// `slug` arrives as a route param from `/instance/:slug` (preact-iso passes matched params as top-level props). Re-pins the shared instance-scoped signals to this slug on mount and whenever the route's slug changes — e.g. following an "Open editor" link (#102 — this screen used to call that link "Open workspace", renamed to avoid colliding with the Workspace entity, #96) from one instance straight to another without an intervening full page load — clearing the previous instance's stale data first so it's never shown against the new slug. `batch()` matters here: without it, `currentSlug.value = slug` alone fires the instance-loading effect below (it's already subscribed to `currentSlug`) using whatever `viewedStage` was still left over from the instance just navigated away from — a stage that may not even be this new instance's current one — before the very next line resets it. That fires a real, wasted request for the wrong stage, whose response can race the correct one. Batching applies all four writes as one update, so the effect runs exactly once, with the new slug and `viewedStage: null` together.
function ModuleEditorPage({ slug }) {
  useEffect(() => {
    batch(() => {
      currentSlug.value = slug
      viewedStage.value = null
      instanceData.value = null
      loadError.value = null
    })
  }, [slug])

  const instance = instanceData.value
  const error = loadError.value

  // The field registry backing "Clear all fields" (#114 moved this button,
  // and hence this registry, up from StageScreen into this parent — the
  // toolbar it now lives in sits above StageScreen and outlives any single
  // stage's mount, so it's no longer freed-and-refreshed just by
  // StageScreen's own key-driven remount). Rather than resetting it in a
  // separate effect keyed on the stage id — which would race the freshly
  // mounted stage's own ModuleCard/MarkdownField registration effects
  // (child effects commit before an ancestor's, so a parent-level reset
  // effect could fire *after* the new stage's fields already registered,
  // wiping them out) — registerField itself detects a stage change and
  // resets synchronously before recording the new field, so there's no
  // window where a genuinely-current registration can be discarded.
  const registryRef = useRef({ stageId: null, entries: [] })

  function registerField(field, control) {
    if (registryRef.current.stageId !== instance.stage.id) {
      registryRef.current = { stageId: instance.stage.id, entries: [] }
    }
    registryRef.current.entries.push({ field, control })
  }

  function clearAllFields() {
    registryRef.current.entries.forEach(({ field, control }) => control.setValue(field.type === 'list' ? [] : ''))
  }

  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  if (!instance || instance.slug !== slug) return html`<p class="loading">Loading…</p>`

  return html`
    <${AppHeader} instance=${instance} />
    <${ViewModeToolbar} instance=${instance} onClearAllFields=${clearAllFields} requestApprovalSlug=${instance.workspaceBacked ? instance.slug : null} />
    <${StageScreen} key=${instance.stage.id} instance=${instance} onFieldRegistered=${registerField} />
  `
}

// ============================================================ Workspaces landing page (#77, restructured by #102) — the landing screen at `/`, titled "Workspaces". Two togglable views over the multi-instance registry (`GET /api/instances`, #76): master-detail (default, grouping instances by workspace — see groupInstancesByWorkspace above) and stage swimlanes (still one chip per instance, ungrouped — the ticket's own acceptance criteria describe the *list*, i.e. master-detail's list pane, not this alternate view). The view choice is a persisted signal (web/lib/dashboardView.js), not local state, so it survives remounting this page and reloading the app. ============================================================

// `slug` is optional: the Workspaces landing page (DashboardPage) calls
// this with none, since it has no single "current" workspace in mind and
// only ever wants the global-default PAT's best-effort view (see
// lib/registry.js's buildAzureDevOpsRow — an entry this PAT can't
// authenticate to is simply left out, not treated as a fatal error). A
// caller that *does* already know which instance it's asking on behalf of
// (InstanceSwitcher, below) should pass its slug, so this resolves and
// attaches that instance's own workspace PAT override (#104) via
// `apiFetchForInstance` instead of only ever trying the global default —
// otherwise a workspace whose override PAT differs from the global default
// would silently drop out of the response entirely (every one of its rows
// failing to authenticate), even for the one instance whose own page is
// making this exact request and already knows the right credential.
async function loadInstances(slug) {
  const res = slug ? await apiFetchForInstance(slug, '/api/instances') : await apiFetch('/api/instances')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instances (${res.status})`)
  }
  return res.json()
}

// Registry `status` is only ever 'complete'/'incomplete' (the current stage's requirements) — a different, coarser vocabulary than a module's own draft/review/agreed frontmatter status. Reuses the same `.stamp` tokens (agreed = done, draft = still in progress) rather than inventing a third visual language, since the Gate Ledger only defines those three.
function statusStampClass(status) {
  return status === 'complete' ? 'agreed' : 'draft'
}

function StatusStamp({ status }) {
  return html`<span class="stamp ${statusStampClass(status)}">${status.toUpperCase()}</span>`
}

function ViewToggle() {
  return html`
    <div class="view-toggle" role="group" aria-label="Dashboard view">
      ${DASHBOARD_VIEW_MODES.map(
        (mode) => html`
          <button
            type="button"
            key=${mode}
            class=${'btn small' + (dashboardViewMode.value === mode ? ' active' : '')}
            aria-pressed=${dashboardViewMode.value === mode}
            onClick=${() => (dashboardViewMode.value = mode)}
          >
            ${mode === 'master-detail' ? 'Master-detail' : 'Stage swimlanes'}
          </button>
        `
      )}
    </div>
  `
}

function EmptyState() {
  return html`
    <div class="dashboard-empty">
      <p>No instances registered yet.</p>
      <a class="btn primary" href="/new-workspace">+ New Workspace</a>
    </div>
  `
}

// Runs an instance's Check or Render action against the registry-listing API's slug (not the module editor's shared signals, which only track whichever single instance is currently open) — the dashboard can trigger either action for any listed instance without navigating away from it.
async function runCheck(slug) {
  const res = await apiFetchForInstance(slug, `/api/instance/check?slug=${encodeURIComponent(slug)}`)
  const body = await res.json()
  if (!res.ok) return `Check failed: ${body.message ?? body.error}`
  if (body.pass) return 'PASS — gate requirements met.'
  const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
  return `FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`
}

async function runRender(slug) {
  const detailRes = await apiFetchForInstance(slug, `/api/instance?slug=${encodeURIComponent(slug)}`)
  const detail = await detailRes.json()
  if (!detailRes.ok) return `Render failed: ${detail.message ?? detail.error}`
  if (!detail.artefacts.length) return 'No artefact available to render for this stage yet.'
  const results = []
  for (const artefact of detail.artefacts) {
    const res = await apiFetchForInstance(slug, `/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, { method: 'POST' })
    const body = await res.json()
    results.push(res.ok ? `Rendered ${artefact.title}` : `${artefact.title} failed: ${body.message ?? body.error}`)
  }
  return results.join(' · ')
}

// Persists the instance record's own stored `assignee` (#97) — the instance detail pane's edit affordance for it, distinct from `PUT /api/instance/modules/:id`'s module-level `owner` (the untouched Design Authority sign-off convention). Not routed through ModuleCard's per-module save flow: this is instance-scoped, not module-scoped.
async function saveAssignee(slug, assignee) {
  const res = await apiFetch(`/api/instance/assignee?slug=${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to save assignee (${res.status})`)
  }
  return body
}

// ---------- Grouping instances by workspace (#102) ----------
// The Workspaces landing page's core grouping rule: an Azure-DevOps-backed row carries a `workspace` (lib/registry.js, #102) — every instance sharing that workspace's `id` groups into one row, one entry per workspace, per the ticket's acceptance criteria. A local instance has no `workspace` at all (Workspace is an Azure-DevOps-repo concept only, #96) — it groups on its own, keyed by its own slug, so a repo (or local instance) holding just one instance still renders through the exact same group shape as one holding several — nothing here special-cases a single-instance group.
function groupInstancesByWorkspace(instances) {
  const groups = new Map()
  for (const inst of instances) {
    const key = inst.workspace ? `workspace:${inst.workspace.id}` : `local:${inst.slug}`
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: inst.workspace ? inst.workspace.repository : inst.slug,
        subtitle: inst.workspace ? `${inst.workspace.organization}/${inst.workspace.project}` : 'Local instance',
        instances: [],
      })
    }
    groups.get(key).instances.push(inst)
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

// The list-pane row's secondary line — deliberately the same shape whether the group holds one instance or several (count · distinct definitions), rather than branching into a one-off "single instance" format, so a single-instance workspace is never visually singled out from a multi-instance one (the ticket's own "no special-casing visible to the user" acceptance criterion).
function groupSummaryText(group) {
  const definitions = [...new Set(group.instances.map((inst) => inst.definition))]
  const count = group.instances.length
  return `${count} instance${count === 1 ? '' : 's'} · ${definitions.join(', ')}`
}

// A group's dot in the list pane reflects every one of its instances being complete, not just the first — a multi-instance workspace with even one outstanding instance is "in progress" as a whole.
function groupStatusClass(group) {
  return group.instances.every((inst) => inst.status === 'complete') ? 'agreed' : 'draft'
}

// ---------- Master-detail view ----------
// The Workspaces landing page's default view (#102, superseding #77's flat per-instance listing): the list pane shows one row per workspace (groupInstancesByWorkspace above); selecting one shows every instance it holds in the detail pane, each its own card with definition/assignee/status and the same Check/Render/Open-editor actions the old flat list offered per instance.
function MasterDetailView({ instances, onInstancesChange }) {
  const [filter, setFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState(null)
  // Keyed by instance slug (not the single shared string the old flat list used) — several instances can be in flight for the *same* selected workspace at once (one Check, one Render, one assignee save), and each must report its own status independently.
  const [actionStatus, setActionStatus] = useState({})
  const [assigneeDrafts, setAssigneeDrafts] = useState({})
  const [assigneeStatus, setAssigneeStatus] = useState({})

  const groups = groupInstancesByWorkspace(instances)

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? groups.filter(
        (group) =>
          group.title.toLowerCase().includes(needle) ||
          group.subtitle.toLowerCase().includes(needle) ||
          group.instances.some(
            (inst) => inst.slug.toLowerCase().includes(needle) || inst.assignee.toLowerCase().includes(needle)
          )
      )
    : groups

  const effectiveKey = filtered.some((group) => group.key === selectedKey) ? selectedKey : (filtered[0]?.key ?? null)
  const selectedGroup = groups.find((group) => group.key === effectiveKey) ?? null

  // Resets every instance-scoped edit/action state whenever the selected workspace changes — never while it's still the same workspace (that would clobber an in-progress edit or Check/Render status on every unrelated `instances` refresh), and seeds the assignee drafts from the newly-selected workspace's own instances.
  useEffect(() => {
    setActionStatus({})
    setAssigneeStatus({})
    setAssigneeDrafts(Object.fromEntries((selectedGroup?.instances ?? []).map((inst) => [inst.slug, inst.assignee ?? ''])))
    // eslint-disable-next-line
  }, [effectiveKey])

  async function handleCheck(slug) {
    setActionStatus((prev) => ({ ...prev, [slug]: 'Checking…' }))
    const result = await runCheck(slug)
    setActionStatus((prev) => ({ ...prev, [slug]: result }))
  }

  async function handleRender(slug) {
    setActionStatus((prev) => ({ ...prev, [slug]: 'Rendering…' }))
    const result = await runRender(slug)
    setActionStatus((prev) => ({ ...prev, [slug]: result }))
  }

  async function handleAssigneeSave(slug, draftOverride) {
    const inst = selectedGroup?.instances.find((i) => i.slug === slug)
    const draft = draftOverride ?? assigneeDrafts[slug] ?? ''
    if (!inst || draft === (inst.assignee ?? '')) return
    setAssigneeStatus((prev) => ({ ...prev, [slug]: 'Saving…' }))
    try {
      const saved = await saveAssignee(slug, draft)
      setAssigneeStatus((prev) => ({ ...prev, [slug]: 'Saved.' }))
      onInstancesChange?.((prev) => prev.map((i) => (i.slug === slug ? { ...i, assignee: saved.assignee } : i)))
    } catch (err) {
      setAssigneeStatus((prev) => ({ ...prev, [slug]: `Failed to save: ${err.message}` }))
    }
  }

  return html`
    <div class="master-detail">
      <div class="list-pane">
        <input
          class="field search"
          type="text"
          placeholder="Filter by workspace, instance, assignee…"
          value=${filter}
          onInput=${(e) => setFilter(e.currentTarget.value)}
        />
        <div class="instance-list">
          ${filtered.map(
            (group) => html`
              <div
                key=${group.key}
                class=${'list-item' + (group.key === effectiveKey ? ' selected' : '')}
                role="button"
                tabindex="0"
                onClick=${() => setSelectedKey(group.key)}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedKey(group.key)
                }}
              >
                <span class=${'dot ' + groupStatusClass(group)}></span>
                <span class="meta">
                  <span class="name">${group.title}</span>
                  <span class="def">${groupSummaryText(group)}</span>
                </span>
              </div>
            `
          )}
          ${filtered.length === 0 ? html`<p class="loading">No workspaces match "${filter}".</p>` : null}
        </div>
      </div>
      <div class="detail-pane">
        ${!selectedGroup
          ? html`<div class="placeholder">Select a workspace to see its instances.</div>`
          : html`
              <h2>${selectedGroup.title}</h2>
              <p class="workspace-subtitle">${selectedGroup.subtitle}</p>
              <div class="workspace-instances">
                ${selectedGroup.instances.map(
                  (inst) => html`
                    <div class="instance-card" key=${inst.slug}>
                      <div class="instance-card-header">
                        <span class="name">${inst.slug}</span>
                        <span class="def">${inst.definition}</span>
                        <${StatusStamp} status=${inst.status} />
                      </div>
                      <div class="instance-card-row">
                        <span class="field-label">Assignee</span>
                        <${IdentityPicker}
                          value=${assigneeDrafts[inst.slug] ?? ''}
                          onChange=${(uniqueName) => {
                            setAssigneeDrafts((prev) => ({ ...prev, [inst.slug]: uniqueName }))
                            // Commit immediately — pass the value directly so it doesn't read stale state
                            handleAssigneeSave(inst.slug, uniqueName)
                          }}
                          placeholder="Unassigned"
                          slug=${inst.slug}
                          className="mono"
                        />
                      </div>
                      <div class="save-status assignee-save-status">${assigneeStatus[inst.slug] ?? ''}</div>
                      <div class="detail-actions">
                        <a class="btn primary" href="/instance/${inst.slug}">Open editor</a>
                        <button type="button" class="btn" onClick=${() => handleCheck(inst.slug)}>Check</button>
                        <button type="button" class="btn" onClick=${() => handleRender(inst.slug)}>Render</button>
                      </div>
                      <div class="save-status">${actionStatus[inst.slug] ?? ''}</div>
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    </div>
  `
}

// ---------- Stage-swimlane view ----------
// One overflow menu open at a time, closed by clicking anywhere else in the
// lanes (SwimlaneGroup owns that single `openSlug`; the chip's own menu is
// the shared Dropdown, web/lib/dropdown.js, whose outside-click/Escape close
// covers the rest). The chip forwards the Dropdown's *requested* next state
// (`onOpenMenu(slug-or-null)`, an explicit set — not a toggle): a blind
// toggle would race the group's own close-on-click wrapper, re-opening a
// menu an outside click just closed.
function SwimlaneChip({ instance, menuOpen, onOpenMenu, onAction }) {
  return html`
    <${Dropdown}
      className="chip"
      triggerClass="btn small ghost menu-btn"
      triggerLabel="⋯"
      triggerAriaLabel=${`Actions for ${instance.slug}`}
      open=${menuOpen}
      onOpenChange=${(next) => onOpenMenu(next ? instance.slug : null)}
      body=${({ trigger, menu }) => html`
        <div class="name">${instance.slug}</div>
        <div class="def">${instance.definition}</div>
        <div class="chip-foot">
          <span class="assignee">${instance.assignee || 'unassigned'}</span>
          <${StatusStamp} status=${instance.status} />
          ${trigger}
        </div>
        ${menu}
      `}
    >
      <a href="/instance/${instance.slug}">Open</a>
      <button type="button" onClick=${() => onAction(instance.slug, 'check')}>Check</button>
      <button type="button" onClick=${() => onAction(instance.slug, 'render')}>Render</button>
    <//>
  `
}

function SwimlaneGroup({ definitionId, stages, instances, showTitle }) {
  const [openSlug, setOpenSlug] = useState(null)
  const [status, setStatus] = useState('')

  async function handleAction(slug, action) {
    setOpenSlug(null)
    setStatus(action === 'check' ? 'Checking…' : 'Rendering…')
    setStatus(await (action === 'check' ? runCheck(slug) : runRender(slug)))
  }

  return html`
    <div class="swimlane-group" onClick=${() => setOpenSlug(null)}>
      ${showTitle ? html`<h2 class="swimlane-group-title">${definitionId}</h2>` : null}
      <div class="lanes">
        ${stages.map((stage) => {
          const items = instances.filter((inst) => inst.stage === stage.id)
          return html`
            <div class="lane" key=${stage.id}>
              <div class="lane-header">
                <span class="stage-name">${stage.title}</span>
                <span class="count">${items.length}</span>
              </div>
              ${items.length === 0
                ? html`<div class="empty-lane">No instances in ${stage.title}</div>`
                : items.map(
                    (inst) => html`
                      <${SwimlaneChip}
                        key=${inst.slug}
                        instance=${inst}
                        menuOpen=${openSlug === inst.slug}
                        onOpenMenu=${setOpenSlug}
                        onAction=${handleAction}
                      />
                    `
                  )}
            </div>
          `
        })}
      </div>
      <div class="save-status">${status}</div>
    </div>
  `
}

function SwimlaneView({ instances }) {
  const [stagesByDefinition, setStagesByDefinition] = useState({})
  const [stagesError, setStagesError] = useState(null)
  const definitionIds = [...new Set(instances.map((inst) => inst.definition))].sort()

  useEffect(() => {
    definitionIds.forEach((definitionId) => {
      apiFetch(`/api/definitions/${encodeURIComponent(definitionId)}/stages`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load stages for "${definitionId}" (${res.status})`)
          return res.json()
        })
        .then((stages) => setStagesByDefinition((prev) => ({ ...prev, [definitionId]: stages })))
        .catch((err) => setStagesError(err.message))
    })
    // eslint-disable-next-line
  }, [definitionIds.join(',')])

  if (stagesError) return html`<p class="load-error">Failed to load: ${stagesError}</p>`

  return html`
    <div class="swimlanes">
      ${definitionIds.map((definitionId) => {
        const stages = stagesByDefinition[definitionId]
        if (!stages) return html`<p class="loading" key=${definitionId}>Loading…</p>`
        return html`
          <${SwimlaneGroup}
            key=${definitionId}
            definitionId=${definitionId}
            stages=${stages}
            instances=${instances.filter((inst) => inst.definition === definitionId)}
            showTitle=${definitionIds.length > 1}
          />
        `
      })}
    </div>
  `
}

// ---------- Dashboard page ----------
function DashboardPage() {
  const [instances, setInstances] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadInstances()
      .then((data) => {
        setInstances(data)
        setError(null)
      })
      .catch((err) => setError(err.message))
  }, [])

  return html`
    <main class="dashboard">
      <div class="dashboard-topbar">
        <h1>Workspaces</h1>
        <div class="dashboard-controls">
          ${instances?.length ? html`<${ViewToggle} />` : null}
          <a class="btn small ghost" href="/new-workspace">+ New Workspace</a>
          <a class="btn small ghost" href=${`/settings?from=${encodeURIComponent('/')}`}>Settings</a>
        </div>
      </div>
      ${error
        ? html`<p class="load-error">Failed to load: ${error}</p>`
        : !instances
          ? html`<p class="loading">Loading…</p>`
          : instances.length === 0
            ? html`<${EmptyState} />`
            : dashboardViewMode.value === 'swimlanes'
              ? html`<${SwimlaneView} instances=${instances} />`
              : html`<${MasterDetailView} instances=${instances} onInstancesChange=${setInstances} />`}
    </main>
  `
}

// ---------- Azure DevOps PAT prompt (#87) ----------
// Rendered globally (see App() below) rather than scoped to any one screen — `apiFetch` (web/lib/apiFetch.js) opens it (via `requestPat()`) the moment *any* request against gantry's own API comes back with the structured "authentication required" response, regardless of which route triggered it. Local instances never produce that response, so this never opens for them — nothing here checks "is this instance local" itself.
function PatPromptModal() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') resolvePromptWith(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function handleSubmit() {
    if (!value.trim()) {
      setError('Paste a Personal Access Token to continue.')
      return
    }
    resolvePromptWith(value.trim())
  }

  return html`
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Azure DevOps sign-in required">
        <h3>Azure DevOps sign-in required</h3>
        <p class="guidance">
          This instance's data lives in Azure DevOps. Paste a Personal Access Token (PAT) to continue — it needs
          <strong>Code (Read & write)</strong> and <strong>Work Items (Read & write)</strong> scope.
          It's stored only in this browser and sent solely to your own gantry server.
        </p>
        <input
          class=${'text-field' + (error ? ' has-error' : '')}
          type="password"
          autocomplete="off"
          placeholder="Paste your Azure DevOps PAT"
          value=${value}
          onInput=${(e) => {
            setValue(e.currentTarget.value)
            if (error) setError('')
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        ${error ? html`<div class="inline-error">${error}</div>` : null}
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${() => resolvePromptWith(null)}>Cancel</button>
          <button type="button" class="btn primary" onClick=${handleSubmit}>Continue</button>
        </div>
      </div>
    </div>
  `
}

// ---------- App shell: preact-iso routing ----------
// Eight routes: the dashboard (#77, default/landing), the module editor per instance, the "+ New Workspace" wizard (#110/#126, replacing the old #78 instance-setup wizard), the asset library (#80), and three tab-free Settings screens (#107, superseding #101/#104's single tabbed `/settings`) — Global Settings, Workspace Settings (scoped to one instance's own workspace), and Instance Settings (assignee, read-only instance info, read-only work-item link details). `instanceData`/`loadError` above are populated regardless of which route is active (the `effect()` isn't scoped to a component), so the library screen never has to re-fetch instance data just to know which instance it's browsing.
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/instance/:slug" component=${ModuleEditorPage} />
        <${Route} path="/new-workspace" component=${NewWorkspaceWizardPage} />
        <${Route} path="/assets" component=${AssetLibraryPage} />
        <${Route} path="/settings" component=${GlobalSettingsPage} />
        <${Route} path="/settings/workspace" component=${WorkspaceSettingsPage} />
        <${Route} path="/settings/instance" component=${InstanceSettingsPage} />
        <${Route} default component=${DashboardPage} />
      <//>
    <//>
    ${promptOpen.value ? html`<${PatPromptModal} />` : null}
  `
}

render(html`<${App} />`, document.getElementById('app'))
