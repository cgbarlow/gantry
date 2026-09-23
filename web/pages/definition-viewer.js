import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { renderMarkdown } from '../lib/markdown.js'
import { reorder } from '../lib/reorder.js'
import { Dropdown } from '../lib/dropdown.js'
import { moduleFieldUsage } from '../lib/moduleFieldUsage.js'
import { defnView, setDefnView, defnMapExpanded, setDefnMapExpanded } from '../lib/definitionView.js'
import { planCopy, resolveCollision, applyPlan, isResolved } from '../lib/copyPlanner.js'

// The rebuilt Definitions page (WI #381, Feature #380's grilling session). Primary source:
// web/prototypes/definition-editor.prototype.html — variant A (Outline) and C (Map) both wanted,
// switchable, sharing one focus pane and one docked Library panel; variant B (rail + drawer) was
// rejected. This file is a from-scratch rewrite, not a promotion of prototype markup.
//
// Vocabulary (CONTEXT.md): a definition's four **Element** kinds are Stage, Artefact, Module and
// Field. **Field visibility per artefact** is an artefact-`requires` fact (`module.field`, or
// `module.field?` for optional-in-scope) — a stage lists whole modules only.
//
// WI #382 (Feature #380 phase 2): the docked Library panel — read-only in phase 1 — now supports
// Copy (with provenance, ADR-0035): drag a stage/artefact/module/field from it onto an outline/map
// node or a focus-pane drop list, or use the "From another definition…" picker next to any "+ add"
// affordance, to build a `CopyPlanner` plan (web/lib/copyPlanner.js, ported from
// web/prototypes/definition-copy.prototype.html and canonical at lib/copyPlanner.js). A copy never
// lands until every id clash is resolved and the confirm panel is accepted — see `renderCopyFlow`.

function isValidSlugClient(slug) {
  return typeof slug === 'string' && slug !== '' && slug !== '.' && slug !== '..' && /^[^\\/]+$/.test(slug)
}

// WI #383 (ADR-0036): copy sources are "server library + same workspace" — a library definition
// (`kind: 'library'`, including one being edited that has no `home` yet) or a definition in the exact
// same server workspace as `currentDef`; a definition from a *different* workspace stays private, even
// though every row briefly passes through this same flat `definitions` array. `currentDef` being a
// library definition itself (or `home` not yet loaded) narrows this to library-only sources — the
// pre-existing behavior from before this ticket, unchanged.
//
// WI #386: a library-repo-sourced definition (`kind: 'library-repo'`) is a server-library source too
// — "viewable, copyable-from, clonable into a workspace" — eligible from anywhere, the same as a
// packaged-library definition, never scoped to one workspace the way a server-workspace source is.
function isEligibleCopySource(def, currentDef) {
  const kind = def.home?.kind ?? 'library'
  if (kind === 'library' || kind === 'library-repo') return true
  return currentDef?.home?.kind === 'server-workspace' && def.home.kind === 'server-workspace' && def.home.id === currentDef.home.id
}

// WI #383: the switcher's own grouping key/label for a row's `home` — "Server library" first, then
// one group per server workspace, in the order the workspace's own definitions first appear in
// `definitions` (already sorted by workspace id, since `listDefinitionsAcrossHomes` builds it that
// way). A row with no `home` at all (shouldn't happen once `includeWorkspaces=1` is always sent, but
// keeps this defensive rather than throwing) groups with the library.
//
// WI #386: a library-repo-sourced row gets its own group, labelled by the repo — kept distinct from
// "Server library" (the packaged directory) so the switcher always shows *where* a read-only
// definition actually comes from, not just that it's read-only.
function groupDefinitionsByHome(definitions) {
  const groups = new Map()
  for (const def of definitions ?? []) {
    const home = def.home ?? { kind: 'library' }
    const key = home.kind === 'library' ? 'library' : home.kind === 'library-repo' ? `library-repo:${home.id}` : `server-workspace:${home.id}`
    if (!groups.has(key)) {
      const label = home.kind === 'library' ? 'Server library' : home.kind === 'library-repo' ? `Library repo: ${home.name}` : `Workspace: ${home.name}`
      groups.set(key, { key, label, defs: [] })
    }
    groups.get(key).defs.push(def)
  }
  return [...groups.values()]
}

function templateBasename(tmpl) {
  if (!tmpl) return ''
  const parts = String(tmpl).split('/')
  return parts[parts.length - 1] || ''
}

// What Save compares against, and what a fresh draft starts from — title/description/stages/
// artefacts/modules only, the fields Save actually writes (id/version/status never change here).
function editableStructure(def) {
  if (!def) return null
  return {
    title: def.title,
    description: def.description,
    stages: def.stages,
    artefacts: def.artefacts,
    modules: def.modules,
  }
}

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}

// Parses the element a validation problem is anchored to out of its message — every message from
// `findDefinitionProblemsInStructure` opens with `Stage "id"`, `Artefact "id"` or `Module "id"` (see
// lib/definition.js) naming the element that owns the problem, so the toolbar's problems count and
// the outline/map markers can point straight at it without a second, structured "where" field.
function problemTarget(problem) {
  const m = /^(Stage|Artefact|Module) "([^"]+)"/.exec(problem?.message ?? '')
  if (!m) return null
  return { type: m[1].toLowerCase(), id: m[2] }
}

// #149: the gates an Artefact's `gate` and a Field's `required-at` may name — each Stage's own gate,
// in Stage order, blanks skipped. Anything else is what gateReferenceProblems (lib/definition.js)
// reports, so the editor offers exactly these rather than free text.
function stageGates(d) {
  return [...new Set(d.stages.map((s) => s.gate).filter((gate) => typeof gate === 'string' && gate !== ''))]
}

// #149: a Field's `required-at` as the list of gates the editor shows, or null when it has none. A bare
// string (the invalid-required-at problem — the engine substring-matches it) reads as the one gate it
// names, so the Required control shows what the Field really does and one tick converts it to a list.
function requiredAtGates(f) {
  if (typeof f.requiredAt === 'string') return [f.requiredAt]
  return Array.isArray(f.requiredAt) ? f.requiredAt : null
}

// #89 (ADR-0045): the three filename: built-ins filenamePatternProblems (lib/definition.js)
// always accepts, regardless of what the artefact requires.
const FILENAME_BUILTIN_TOKENS = [
  { token: 'instance.name', label: 'Instance name' },
  { token: 'instance.slug', label: 'Instance slug' },
  { token: 'today', label: "Today's date" },
]

// #89: which {module.field} tokens an artefact's filename: pattern may legally reference —
// mirrors filenamePatternProblems' own acceptance rule (lib/definition.js): single-valued
// select/text/date fields, reachable either by their own `module.field` requirement or by a
// bare `module` requirement that puts the whole module's fields in scope. Kept in lock-step
// with that function rather than asking it directly, since the editor needs the list of what
// *is* eligible (to offer as tokens) where filenamePatternProblems only ever reports what
// isn't.
function eligibleFilenameFields(d, artefact) {
  const results = []
  const seen = new Set()
  for (const requirement of artefact.requires ?? []) {
    const ref = requirement.endsWith('?') ? requirement.slice(0, -1) : requirement
    const dot = ref.indexOf('.')
    const moduleId = dot === -1 ? ref : ref.slice(0, dot)
    const fieldId = dot === -1 ? null : ref.slice(dot + 1)
    const mod = d.modules.find((m) => m.id === moduleId)
    if (!mod) continue
    const fields = fieldId ? mod.fields.filter((f) => f.id === fieldId) : mod.fields
    for (const f of fields) {
      if (!['select', 'text', 'date'].includes(f.type) || (f.type === 'select' && f.multiple === true)) continue
      const token = `${moduleId}.${f.id}`
      if (seen.has(token)) continue
      seen.add(token)
      results.push({ token, label: `${mod.title} · ${f.title}` })
    }
  }
  return results
}

// #150 (ADR-0049): an Artefact's `document-control:` switch. Ticked (the default, the key absent)
// prints the Document Control and Review & sign-off tables; unticked stores `documentControl:
// false`, which leaves both out of that Artefact's render. `onToggle` null shows it read-only, as
// on a published version.
function documentControlCheckbox(artefact, onToggle) {
  return html`
    <label class="defn-document-control">
      <input type="checkbox" checked=${artefact.documentControl !== false} disabled=${!onToggle} onChange=${onToggle ? (e) => onToggle(e.currentTarget.checked) : undefined} />
      Print the Document Control and Review & sign-off tables
    </label>
  `
}

// #152 (docs/adr/0050): marks or unmarks one of a stage's mounted modules read-only, keeping
// `readOnlyModules` in the stage's own module order and dropping the key once it is empty — so a stage
// nobody marks read-only saves exactly as it did before the key existed (opt-in).
function setStageModuleReadOnly(stage, moduleId, readOnly) {
  const listed = new Set(stage.readOnlyModules ?? [])
  if (readOnly) listed.add(moduleId)
  else listed.delete(moduleId)
  const next = stage.modules.filter((id) => listed.has(id))
  if (next.length) stage.readOnlyModules = next
  else delete stage.readOnlyModules
}

// #151 (ADR-0051): an Artefact's `satisfies-gate:` switch. Ticked (the default, the key absent)
// means completing this Artefact passes its Gate; unticked stores `satisfiesGate: false` — an
// audience document that is still rendered and linked for approval, but never passes the Gate on its
// own. `onToggle` null shows it read-only, as on a published version.
function satisfiesGateCheckbox(artefact, onToggle) {
  return html`
    <label class="defn-satisfies-gate">
      <input type="checkbox" checked=${artefact.satisfiesGate !== false} disabled=${!onToggle} onChange=${onToggle ? (e) => onToggle(e.currentTarget.checked) : undefined} />
      Completing this artefact passes its gate
    </label>
  `
}

// -- list addressing for reorder-in-place drags/buttons --------------------------------------
function getList(d, listPath) {
  if (listPath === 'stages') return d.stages
  if (listPath === 'artefacts') return d.artefacts
  if (listPath === 'modules') return d.modules
  if (listPath.startsWith('stage-modules:')) return d.stages[Number(listPath.split(':')[1])].modules
  if (listPath.startsWith('artefact-requires:')) return d.artefacts[Number(listPath.split(':')[1])].requires
  return []
}
function setList(d, listPath, next) {
  if (listPath === 'stages') { d.stages = next; return }
  if (listPath === 'artefacts') { d.artefacts = next; return }
  if (listPath === 'modules') { d.modules = next; return }
  if (listPath.startsWith('stage-modules:')) { d.stages[Number(listPath.split(':')[1])].modules = next; return }
  if (listPath.startsWith('artefact-requires:')) { d.artefacts[Number(listPath.split(':')[1])].requires = next; return }
}

export function DefinitionViewerPage() {
  const { route } = useLocation()

  const [definitions, setDefinitions] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedVersion, setSelectedVersion] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saveProblems, setSaveProblems] = useState([])
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [validationProblems, setValidationProblems] = useState([])
  const [showArchived, setShowArchived] = useState(false)
  // WI #386 — library repos' id-clash problems ("Definition home: server library ... library repos
  // ... a clash is reported as a problem on the Definitions page and the clashing repo copy is
  // ignored"), and the explicit Refresh button's own busy/error state.
  const [libraryProblems, setLibraryProblems] = useState([])
  const [refreshingLibrary, setRefreshingLibrary] = useState(false)
  const [refreshLibraryError, setRefreshLibraryError] = useState(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [newDefMode, setNewDefMode] = useState(null) // null | 'blank' | 'clone'
  const [newBlankId, setNewBlankId] = useState('')
  const [newBlankTitle, setNewBlankTitle] = useState('')
  const [newCloneId, setNewCloneId] = useState('')
  // WI #386 — only used (and only shown) when the definition being cloned is library-repo-sourced:
  // that source has no home of its own for the clone to land in (it's read-only), so the author must
  // pick a target workspace explicitly, unlike every other source (library, server workspace) which
  // always clones into its own home.
  const [newCloneHomeId, setNewCloneHomeId] = useState('')
  // WI #383 (ADR-0036) — Definition home: server library or a server workspace's own `definitions/`
  // folder. `newBlankHomeId` is `''` for the library, else a server workspace's own id (its folder
  // name). `workspaceHomes` is fetched once from `/api/server-workspaces` (not derived from
  // `definitions`, which never lists a workspace that has no definitions of its own yet) so a
  // brand-new, still-empty workspace can be picked as a target too.
  const [workspaceHomes, setWorkspaceHomes] = useState([])
  const [newBlankHomeId, setNewBlankHomeId] = useState('')
  const [newDefError, setNewDefError] = useState(null)
  const [newDefBusy, setNewDefBusy] = useState(false)
  const [newDraftError, setNewDraftError] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const [publishProblems, setPublishProblems] = useState([])
  const [publishError, setPublishError] = useState(null)

  // Promote (WI #387, ADR-0036's Promote section) — one Pull Request per selected library repo,
  // from a published workspace definition version. `promotions` is this version's persisted
  // per-repo PR link/status (`GET .../promotions`), refreshed by a promote or an explicit Check —
  // never polled.
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [promoteRepos, setPromoteRepos] = useState(null)
  const [promoteSelectedIds, setPromoteSelectedIds] = useState([])
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState(null)
  const [promotions, setPromotions] = useState([])
  const [checkingPromotions, setCheckingPromotions] = useState(false)

  // Focus pane: which element is shown, and (for a module) which field row is expanded — "fields are
  // compact rows, one expanded at a time" (Feature #380).
  const [selection, setSelection] = useState({ type: 'stage', id: null })
  const [openFieldKey, setOpenFieldKey] = useState(null)
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [moveFieldTarget, setMoveFieldTarget] = useState({})

  // Template editing as its own focus-pane view (CodeMirror), not embedded in the artefact form.
  const [templateView, setTemplateView] = useState(null) // { artefactId, loading, source, error, saving, saved } | null
  const templateHostRef = useRef(null)
  const templateCmRef = useRef(null)

  // Reference docx Replace/Download (WI #385), keyed by artefact id — several artefacts' rows can
  // carry independent in-flight state as the author moves between them without one clobbering
  // another's error/status message.
  const [docxStatus, setDocxStatus] = useState({}) // { [artefactId]: { uploading, error, message } }

  // Drag and drop — every kind here has a button-route equivalent (reorder ↑/↓; "Add module"/"Add
  // requirement" pickers; a field's own "Move to module" control).
  const [dragPayload, setDragPayload] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)

  // Docked Library panel (WI #381 built the browse-only shell; WI #382 wires up Copy). Sources are
  // "any server-library definition (published or draft)" (WI #382) — libSourceVersion defaults to
  // latest-published (else the max version) but can be pointed at a specific draft explicitly.
  const [libSourceId, setLibSourceId] = useState(null)
  const [libSourceVersion, setLibSourceVersion] = useState(null)
  const [libDetail, setLibDetail] = useState(null)
  const [libError, setLibError] = useState(null)

  // Copy flow (WI #382): a plan built by CopyPlanner, from either a Library drag or a "From
  // another definition…" picker, pending confirmation before it lands. `afterLand` carries a
  // follow-on local edit `applyCopyFlow` performs once the plan's own elements have landed — e.g.
  // "and add the module this landed as to stage 2's module list" — for the composite drops
  // CopyPlanner's own single-element refs don't cover by themselves (a whole module dropped onto a
  // stage or an artefact).
  const [copyFlow, setCopyFlow] = useState(null) // { plan, sourceId, sourceVersion, afterLand } | null

  // Save / Discard / Cancel leave guard (web/lib/stageSave.js's pattern): `pendingNav` holds the
  // navigation to run once the guard is resolved.
  const [pendingNav, setPendingNav] = useState(null)

  const isEditable = detail?.status === 'draft'
  const isDirty = Boolean(isEditable && draft && detail && JSON.stringify(editableStructure(draft)) !== JSON.stringify(editableStructure(detail)))
  const working = isEditable ? draft : detail

  // WI #383: `includeWorkspaces=1` unions the library with every server workspace's own definitions,
  // each row carrying `home` — `{ kind: 'library' }` or `{ kind: 'server-workspace', id, name }` —
  // which the switcher groups by and the copy-sources picker filters by. Without this the response is
  // byte-for-byte the pre-existing library-only shape (`GET /api/definitions` unchanged).
  function fetchDefinitions(showArchivedFlag) {
    const params = new URLSearchParams({ includeWorkspaces: '1' })
    if (showArchivedFlag) params.set('archived', '1')
    return fetch(`/api/definitions?${params}`).then((res) => {
      if (!res.ok) throw new Error(`Failed to load definitions (${res.status})`)
      return res.json()
    })
  }

  useEffect(() => {
    fetch('/api/server-workspaces')
      .then((res) => (res.ok ? res.json() : []))
      .then(setWorkspaceHomes)
      .catch(() => setWorkspaceHomes([]))
  }, [])

  // WI #386 — the current library-repo id-clash problems, on load (independent of ever clicking
  // Refresh: a clash can already be sitting in the cache from an earlier server startup).
  useEffect(() => {
    fetch('/api/library-repos')
      .then((res) => (res.ok ? res.json() : { problems: [] }))
      .then((body) => setLibraryProblems(body.problems ?? []))
      .catch(() => {})
  }, [])

  // The Definitions page's explicit Refresh (ADR-0036) — re-reads every configured library repo now,
  // then reloads the definitions list and the problems banner so newly-fetched (or newly-stale)
  // content shows up immediately.
  async function handleRefreshLibrary() {
    setRefreshingLibrary(true)
    setRefreshLibraryError(null)
    try {
      const res = await fetch('/api/library-repos/refresh', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefreshLibraryError(body.error ?? `Refresh failed (${res.status})`)
        return
      }
      setLibraryProblems(body.problems ?? [])
      const failed = (body.results ?? []).filter((r) => !r.ok)
      if (failed.length) {
        setRefreshLibraryError(`${failed.length} librar${failed.length === 1 ? 'y repo' : 'y repos'} could not be read — showing cached content.`)
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
    } catch (err) {
      setRefreshLibraryError(err.message)
    } finally {
      setRefreshingLibrary(false)
    }
  }

  useEffect(() => {
    fetchDefinitions(showArchived)
      .then((data) => {
        setDefinitions(data)
        setLoadError(null)
        if (data.length && !selectedId) {
          const first = data.find((d) => d.id === 'design') ?? data[0]
          const defaultVersion = first.latestPublished ?? Math.max(...first.versions.map((v) => v.version))
          setSelectedId(first.id)
          setSelectedVersion(defaultVersion)
        }
      })
      .catch((err) => setLoadError(err.message))
    // eslint-disable-next-line
  }, [])

  useEffect(() => {
    fetchDefinitions(showArchived)
      .then((data) => {
        setDefinitions(data)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err.message))
    // eslint-disable-next-line
  }, [showArchived])

  useEffect(() => {
    if (!selectedId || selectedVersion == null) return
    setDetailLoading(true)
    setDetailError(null)
    fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `Failed to load definition (${res.status})`)
        }
        return res.json()
      })
      .then((data) => {
        setDetail(data)
        setDraft(data.status === 'draft' ? clone(data) : null)
        setDetailError(null)
        setPublishProblems([])
        setPublishError(null)
        setSaveProblems([])
        setSaveError(null)
        setSelection({ type: 'stage', id: data.stages[0]?.id ?? null })
        setOpenFieldKey(null)
        setTemplateView(null)
      })
      .catch((err) => {
        setDetail(null)
        setDraft(null)
        setDetailError(err.message)
      })
      .finally(() => setDetailLoading(false))
  }, [selectedId, selectedVersion])

  // WI #387: this version's persisted per-repo promotion PR link/status — reloaded whenever the
  // selected definition/version changes, never polled thereafter (a promote or an explicit Check is
  // what refreshes it from here on). `[]` for anything that isn't a published server-workspace
  // version — the only home Promote is available on.
  useEffect(() => {
    if (!selectedId || selectedVersion == null || detail?.status !== 'published') {
      setPromotions([])
      return
    }
    const def = definitions?.find((d) => d.id === selectedId)
    if (def?.home?.kind !== 'server-workspace') {
      setPromotions([])
      return
    }
    fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/promotions`)
      .then((res) => (res.ok ? res.json() : { promotions: [] }))
      .then((body) => setPromotions(body.promotions ?? []))
      .catch(() => setPromotions([]))
  }, [selectedId, selectedVersion, detail?.status, definitions])

  // Live validation markers, sharing findDefinitionProblemsInStructure with the server (WI #381) via
  // POST .../validate — debounced so it runs once per pause in typing, not on every keystroke.
  useEffect(() => {
    if (!isEditable || !draft || !selectedId || selectedVersion == null) {
      setValidationProblems([])
      return
    }
    const timer = setTimeout(() => {
      fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
        .then((res) => (res.ok ? res.json() : { problems: [] }))
        .then((body) => setValidationProblems(body.problems ?? []))
        .catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [draft, isEditable, selectedId, selectedVersion])

  // Leave/unsaved-changes guard for a real tab close or reload — the three-way Save/Discard/Cancel
  // guard below covers in-app navigation (switching definition/version, "← Workspaces").
  useEffect(() => {
    function onBeforeUnload(e) {
      if (!isDirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  // Docked Library panel: whichever other definition is picked. Re-picks whenever the current
  // libSourceId is no longer valid *or* has come to equal the definition now being edited (e.g. the
  // editor's own default-selection effect briefly selects whichever definition sorts first, which
  // this effect — running before that settles — may have already pointed the Library at) — the
  // Library must never end up aimed at the same definition the workbench is editing.
  useEffect(() => {
    if (!definitions) return
    const currentDef = definitions.find((d) => d.id === selectedId) ?? null
    const eligible = definitions.filter((d) => d.id !== selectedId && isEligibleCopySource(d, currentDef))
    if (libSourceId && libSourceId !== selectedId && eligible.some((d) => d.id === libSourceId)) return
    setLibSourceId(eligible[0]?.id ?? null)
  }, [definitions, selectedId])

  useEffect(() => {
    if (!libSourceId) { setLibSourceVersion(null); return }
    const def = definitions?.find((d) => d.id === libSourceId)
    if (!def) return
    if (libSourceVersion && def.versions.some((v) => v.version === libSourceVersion)) return
    setLibSourceVersion(def.latestPublished ?? Math.max(...def.versions.map((x) => x.version)))
  }, [libSourceId, definitions])

  useEffect(() => {
    if (!libSourceId || libSourceVersion == null) { setLibDetail(null); return }
    setLibError(null)
    fetch(`/api/definitions/${encodeURIComponent(libSourceId)}/versions/${encodeURIComponent(String(libSourceVersion))}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        return res.json()
      })
      .then(setLibDetail)
      .catch((err) => setLibError(err.message))
  }, [libSourceId, libSourceVersion])

  function guardedNav(action) {
    if (isDirty) {
      setPendingNav(() => action)
      return
    }
    action()
  }

  async function handleSave() {
    if (!draft || !selectedId || selectedVersion == null) return false
    setSaving(true)
    setSaveProblems([])
    setSaveError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422 && body.problems) {
        setSaveProblems(body.problems)
        return false
      }
      if (!res.ok) {
        setSaveError(body.error ?? `Save failed (${res.status})`)
        if (body.problems) setSaveProblems(body.problems)
        return false
      }
      const { ok, ...proj } = body
      setDetail(proj)
      setDraft(clone(proj))
      setSaveProblems([])
      setSaveError(null)
      return true
    } catch (err) {
      setSaveError(err.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    setDraft(detail ? clone(detail) : null)
    setSaveProblems([])
    setSaveError(null)
  }

  async function resolveGuard(choice) {
    const action = pendingNav
    setPendingNav(null)
    if (choice === 'cancel') return
    if (choice === 'discard') {
      handleDiscard()
      action?.()
      return
    }
    if (choice === 'save') {
      const ok = await handleSave()
      if (ok) action?.()
    }
  }

  function handleSelectDefinition(def) {
    guardedNav(() => {
      setSelectedId(def.id)
      const v = def.latestPublished ?? Math.max(...def.versions.map((x) => x.version))
      setSelectedVersion(v)
      setSwitcherOpen(false)
    })
  }
  function handleSelectVersion(v) {
    guardedNav(() => setSelectedVersion(v))
  }
  function handleGoHome(e) {
    e.preventDefault()
    guardedNav(() => route('/'))
  }

  async function handleNewDraft() {
    if (!selectedId) return
    setNewDraftError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNewDraftError(body.error ?? `Failed (${res.status})`)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      setSelectedVersion(body.version)
    } catch (err) {
      setNewDraftError(err.message)
    }
  }

  async function handleCreateBlank() {
    if (!newBlankId || !isValidSlugClient(newBlankId)) {
      setNewDefError('Invalid slug — single segment, no slashes or ".."')
      return
    }
    setNewDefBusy(true)
    setNewDefError(null)
    try {
      const res = await fetch('/api/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newId: newBlankId,
          title: newBlankTitle || newBlankId,
          home: newBlankHomeId ? { kind: 'server-workspace', id: newBlankHomeId } : { kind: 'library' },
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNewDefError(body.error ?? `Failed (${res.status})`)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      guardedNav(() => {
        setSelectedId(body.id)
        setSelectedVersion(1)
      })
      setNewDefMode(null)
      setNewBlankId('')
      setNewBlankTitle('')
      setNewBlankHomeId('')
      setSwitcherOpen(false)
    } catch (err) {
      setNewDefError(err.message)
    } finally {
      setNewDefBusy(false)
    }
  }

  async function handleCreateClone() {
    if (!selectedId) return
    if (!newCloneId || !isValidSlugClient(newCloneId)) {
      setNewDefError('Invalid slug — single segment, no slashes or ".."')
      return
    }
    // WI #386: a library-repo-sourced definition is read-only and has no home of its own to clone
    // back into — the author must pick a real (writable) target workspace instead.
    const sourceHomeKind = definitions?.find((d) => d.id === selectedId)?.home?.kind
    if (sourceHomeKind === 'library-repo' && !newCloneHomeId) {
      setNewDefError('Pick a workspace to clone this library-repo definition into.')
      return
    }
    setNewDefBusy(true)
    setNewDefError(null)
    try {
      // WI #383 review: the clone has to land in the *source* definition's own home — a
      // workspace-homed definition has no counterpart in the library for `cloneDefinition` to read
      // from, so omitting `home` here always 400'd with "Unknown definition" for anything but a
      // library definition. WI #386: a library-repo source is the one exception — it has no home of
      // its own to land in, so the author-picked `newCloneHomeId` (always a real workspace) is used
      // instead.
      const sourceHome =
        sourceHomeKind === 'library-repo'
          ? { kind: 'server-workspace', id: newCloneHomeId }
          : (definitions?.find((d) => d.id === selectedId)?.home ?? { kind: 'library' })
      const res = await fetch('/api/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: selectedId, newId: newCloneId, home: sourceHome }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNewDefError(body.error ?? `Failed (${res.status})`)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      guardedNav(() => {
        setSelectedId(body.id)
        setSelectedVersion(1)
      })
      setNewDefMode(null)
      setNewCloneId('')
      setNewCloneHomeId('')
      setSwitcherOpen(false)
    } catch (err) {
      setNewDefError(err.message)
    } finally {
      setNewDefBusy(false)
    }
  }

  async function handleArchive(id, e) {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(id)}/archive`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Archive failed (${res.status})`)
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
    } catch (err) {
      setLoadError(err.message)
    }
  }
  async function handleRestore(id, e) {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(id)}/restore`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Restore failed (${res.status})`)
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
    } catch (err) {
      setLoadError(err.message)
    }
  }

  async function handlePublish() {
    if (!detail || !selectedId || selectedVersion == null) return
    if (detail.status !== 'draft' || isDirty) return
    const confirmed = typeof window !== 'undefined' && window.confirm
      ? window.confirm(`Publish v${detail.version}? This makes it immutable.`)
      : true
    if (!confirmed) return
    setPublishing(true)
    setPublishProblems([])
    setPublishError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/publish`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422 && body.problems) {
        setPublishProblems(body.problems)
        return
      }
      if (!res.ok) {
        setPublishError(body.error ?? `Publish failed (${res.status})`)
        if (body.problems) setPublishProblems(body.problems)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      const { ok, ...proj } = body
      setDetail(proj)
      setDraft(null)
      setPublishProblems([])
      setPublishError(null)
    } catch (err) {
      setPublishError(err.message)
    } finally {
      setPublishing(false)
    }
  }

  // WI #387 — opens the Promote dialog, loading the configured library repos fresh each time (a
  // repo added or edited in Settings since the page loaded must show up without a reload).
  function handleOpenPromote() {
    setPromoteError(null)
    setPromoteSelectedIds([])
    setPromoteOpen(true)
    setPromoteRepos(null)
    fetch('/api/library-repos')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? `Failed to load library repos (${res.status})`)
        return body
      })
      .then((body) => setPromoteRepos(body.repos ?? []))
      .catch((err) => setPromoteError(err.message))
  }

  function togglePromoteRepo(repoId) {
    setPromoteSelectedIds((prev) => (prev.includes(repoId) ? prev.filter((id) => id !== repoId) : [...prev, repoId]))
  }

  async function handlePromote() {
    if (!selectedId || selectedVersion == null || promoteSelectedIds.length === 0) return
    setPromoting(true)
    setPromoteError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoIds: promoteSelectedIds }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? `Promote failed (${res.status})`)
      }
      setPromotions(body.promotions ?? [])
      const failed = (body.results ?? []).filter((r) => !r.ok)
      if (failed.length) {
        setPromoteError(failed.map((r) => `${r.repoName}: ${r.error}`).join(' · '))
      } else {
        setPromoteOpen(false)
      }
    } catch (err) {
      setPromoteError(err.message)
    } finally {
      setPromoting(false)
    }
  }

  // The explicit "Check" action (WI #387: "status is read on an explicit Check, not polled — same
  // posture as sign-off") — re-reads every promotion's Pull Request status/review from Azure DevOps.
  async function handleCheckPromotions() {
    if (!selectedId || selectedVersion == null) return
    setCheckingPromotions(true)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/promotions/check`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.ok) setPromotions(body.promotions ?? [])
    } finally {
      setCheckingPromotions(false)
    }
  }

  function updateDraft(updater) {
    setDraft((prev) => {
      const next = clone(prev)
      updater(next)
      return next
    })
  }

  // ---------------------------------------------------------------- copy from another definition (WI #382)
  // `startLibraryCopy` builds a CopyPlanner ref from a Library drag or picker choice and opens the
  // confirm panel; nothing lands until `applyCopyFlow` runs on a fully resolved plan (isResolved).
  function copyRequirementRef(fromField, targetArtefactId) {
    const artefact = working.artefacts.find((a) => a.id === targetArtefactId)
    return { kind: 'requirement', artefactId: targetArtefactId, req: `${fromField.moduleId}.${fromField.fieldId}`, artefactTitle: artefact?.title }
  }

  function startLibraryCopy(elementKind, payload, afterLand) {
    if (!libDetail || !working) return
    let ref
    if (elementKind === 'module') ref = { kind: 'module', id: payload.id }
    else if (elementKind === 'stage') ref = { kind: 'stage', id: payload.id }
    else if (elementKind === 'artefact') ref = { kind: 'artefact', id: payload.id }
    else if (elementKind === 'field-into-module') ref = { kind: 'field', moduleId: payload.moduleId, id: payload.fieldId, targetModuleId: payload.targetModuleId }
    else if (elementKind === 'field-into-artefact') ref = copyRequirementRef(payload, payload.targetArtefactId)
    else return
    const plan = planCopy(working, libDetail, ref)
    setCopyFlow({ plan, sourceId: libDetail.id, sourceVersion: libDetail.version, afterLand: afterLand ?? null })
  }

  function resolveCopyFlowCollision(id, choice, renameTo) {
    setCopyFlow((prev) => (prev ? { ...prev, plan: resolveCollision(prev.plan, id, choice, renameTo) } : prev))
  }

  function cancelCopyFlow() {
    setCopyFlow(null)
  }

  // The final id a landed 'module' ref settles under — its own id, unless a rename collision chose
  // a different one — so a caller's `afterLand` step (add-to-stage, add-all-fields-to-artefact) can
  // find the module that just landed inside the freshly applied target.
  function landedModuleId(plan) {
    if (plan.ref.kind !== 'module') return plan.ref.id
    const c = plan.collisions.find((x) => x.kind === 'module')
    return c?.choice === 'rename' ? c.renameTo : plan.ref.id
  }

  // Same idea as landedModuleId, for an 'artefact' ref — needed so a renamed-on-collision artefact
  // still receives its brought-along template and reference docx under the id it actually landed as.
  function landedArtefactId(plan) {
    if (plan.ref.kind !== 'artefact') return plan.ref.id
    const c = plan.collisions.find((x) => x.kind === 'artefact')
    return c?.choice === 'rename' ? c.renameTo : plan.ref.id
  }

  async function applyCopyFlow() {
    if (!copyFlow || !isResolved(copyFlow.plan) || !libDetail) return
    const { plan, afterLand, sourceId, sourceVersion } = copyFlow
    const { target } = applyPlan(working, libDetail, plan)
    if (afterLand) {
      const modId = landedModuleId(plan)
      const mod = target.modules.find((m) => m.id === modId)
      if (afterLand.stageIndexAddModule !== undefined && mod) {
        const stage = target.stages[afterLand.stageIndexAddModule]
        if (stage && !stage.modules.includes(mod.id)) stage.modules.push(mod.id)
      }
      if (afterLand.artefactIndexAddAllFields !== undefined && mod) {
        const artefact = target.artefacts[afterLand.artefactIndexAddAllFields]
        if (artefact) {
          for (const f of mod.fields) {
            const req = `${mod.id}.${f.id}`
            if (!artefact.requires.includes(req) && !artefact.requires.includes(`${req}?`)) artefact.requires.push(req)
          }
        }
      }
    }
    setDraft(target)
    setCopyFlow(null)
    // An artefact copy "brings" a template (CopyPlanner's 'template' entry) — the artefact's
    // `template` YAML path lands as part of the plan above, but the .md.tmpl *content*, and its
    // paired reference .docx (WI #385) if it has one, are separate files, written through the same
    // read/write-template and reference-docx endpoints the focus pane's own "Edit template" and
    // Replace/Download already use (lib/definition.js's readDefinitionTemplate/writeDefinitionTemplate
    // and readDefinitionReferenceDocx/writeDefinitionReferenceDocx — both live outside the
    // draft/Save cycle, same as those buttons). Both fetches are best-effort: the artefact itself has
    // already landed regardless, so a failure just leaves the template and/or docx to be added by
    // hand, same as any brand-new artefact starts out. A missing docx (404 — the common case, most
    // artefacts don't have a custom one) is not a failure and is silently skipped.
    const templateBring = plan.brings.find((b) => b.kind === 'template')
    const name = templateBring && templateBasename(templateBring.id)
    if (name && selectedId && selectedVersion != null) {
      try {
        const res = await fetch(`/api/definitions/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(String(sourceVersion))}/templates/${encodeURIComponent(name)}`)
        if (res.ok) {
          const body = await res.json()
          await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: body.source ?? '' }),
          })
        }
      } catch {
        // best-effort — see comment above
      }
      const sourceArtefactId = plan.ref.id
      const targetArtefactId = landedArtefactId(plan)
      try {
        const docxRes = await fetch(
          `/api/definitions/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(String(sourceVersion))}/artefacts/${encodeURIComponent(sourceArtefactId)}/reference-docx`
        )
        if (docxRes.ok) {
          const bytes = new Uint8Array(await docxRes.arrayBuffer())
          await fetch(
            `/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/artefacts/${encodeURIComponent(targetArtefactId)}/reference-docx`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docxBase64: bytesToBase64(bytes) }) }
          )
        }
      } catch {
        // best-effort — see comment above
      }
    }
  }

  // ---------------------------------------------------------------- template editing (focus pane)
  async function handleOpenTemplate(artefactId) {
    const artefact = working?.artefacts.find((a) => a.id === artefactId)
    const name = templateBasename(artefact?.template)
    setTemplateView({ artefactId, loading: true, error: null, source: '', saving: false, saved: null })
    if (!name) {
      setTemplateView((prev) => ({ ...prev, loading: false, source: '' }))
      return
    }
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`)
      if (res.status === 404) {
        setTemplateView((prev) => ({ ...prev, loading: false, source: '' }))
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTemplateView((prev) => ({ ...prev, loading: false, error: body.error ?? `Failed (${res.status})` }))
        return
      }
      setTemplateView((prev) => ({ ...prev, loading: false, source: body.source ?? '' }))
    } catch (err) {
      setTemplateView((prev) => ({ ...prev, loading: false, error: err.message }))
    }
  }
  function handleCloseTemplate() {
    setTemplateView(null)
  }
  async function handleSaveTemplate() {
    if (!templateView) return
    const artefact = working?.artefacts.find((a) => a.id === templateView.artefactId)
    const name = templateBasename(artefact?.template)
    if (!name) return
    const source = templateCmRef.current ? templateCmRef.current.state.doc.toString() : templateView.source
    setTemplateView((prev) => ({ ...prev, saving: true, error: null, saved: null }))
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422) {
        setTemplateView((prev) => ({ ...prev, saving: false, error: body.error ?? 'Template does not compile' }))
        return
      }
      if (!res.ok) {
        setTemplateView((prev) => ({ ...prev, saving: false, error: body.error ?? `Save failed (${res.status})` }))
        return
      }
      setTemplateView((prev) => ({ ...prev, saving: false, source, saved: 'Saved ✓', error: null }))
      setTimeout(() => setTemplateView((prev) => (prev ? { ...prev, saved: null } : prev)), 2000)
    } catch (err) {
      setTemplateView((prev) => ({ ...prev, saving: false, error: err.message }))
    }
  }
  // The CodeMirror instance is the source of firm truth for the template's text (same posture as the
  // module editor's field editors) — created once per open template, torn down on close, never
  // recreated on every keystroke.
  useEffect(() => {
    if (!templateView || templateView.loading || !templateHostRef.current) return
    const view = new EditorView({
      doc: templateView.source ?? '',
      extensions: [basicSetup, markdown(), EditorView.lineWrapping, EditorView.editable.of(isEditable)],
      parent: templateHostRef.current,
    })
    templateCmRef.current = view
    return () => {
      view.destroy()
      templateCmRef.current = null
    }
    // eslint-disable-next-line
  }, [templateView?.artefactId, templateView?.loading, isEditable])

  // ---------------------------------------------------------------- reference docx (Replace/Download)
  function setDocxArtefactStatus(artefactId, patch) {
    setDocxStatus((prev) => ({ ...prev, [artefactId]: { ...(prev[artefactId] ?? {}), ...patch } }))
  }
  // btoa/Uint8Array chunking mirrors web/app.js's bytesToBase64 — kept local here rather than
  // shared, since a definition editor page has no reason to import from the instance-viewer entry
  // point (or vice versa).
  function bytesToBase64(bytes) {
    const CHUNK = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  async function handleReplaceReferenceDocx(artefactId, file) {
    setDocxArtefactStatus(artefactId, { uploading: true, error: null, message: null })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const docxBase64 = bytesToBase64(bytes)
      const res = await fetch(
        `/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/artefacts/${encodeURIComponent(artefactId)}/reference-docx`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docxBase64 }) }
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDocxArtefactStatus(artefactId, { uploading: false, error: body.error ?? `Replace failed (${res.status})` })
        return
      }
      setDocxArtefactStatus(artefactId, { uploading: false, error: null, message: 'Replaced ✓' })
      setTimeout(() => setDocxArtefactStatus(artefactId, { message: null }), 2000)
    } catch (err) {
      setDocxArtefactStatus(artefactId, { uploading: false, error: err.message })
    }
  }
  async function handleDownloadReferenceDocx(artefactId) {
    setDocxArtefactStatus(artefactId, { error: null })
    try {
      const res = await fetch(
        `/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/artefacts/${encodeURIComponent(artefactId)}/reference-docx`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setDocxArtefactStatus(artefactId, { error: body.error ?? `Download failed (${res.status})` })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `reference-${artefactId}.docx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setDocxArtefactStatus(artefactId, { error: err.message })
    }
  }

  // ---------------------------------------------------------------- drag and drop
  function startReorderDrag(e, listPath, index) {
    const payload = { kind: 'reorder', listPath, index }
    try { e.dataTransfer.setData('text/plain', JSON.stringify(payload)) } catch {}
    e.dataTransfer.effectAllowed = 'move'
    setDragPayload(payload)
  }
  function startModuleDrag(e, moduleId) {
    const payload = { kind: 'module', id: moduleId }
    try { e.dataTransfer.setData('text/plain', JSON.stringify(payload)) } catch {}
    e.dataTransfer.effectAllowed = 'copyMove'
    setDragPayload(payload)
  }
  function startFieldDrag(e, moduleId, fieldId, index) {
    const payload = { kind: 'field', moduleId, fieldId, index }
    try { e.dataTransfer.setData('text/plain', JSON.stringify(payload)) } catch {}
    e.dataTransfer.effectAllowed = 'copyMove'
    setDragPayload(payload)
  }
  // WI #382: dragging a stage/artefact/module/field out of the docked Library panel. Distinct
  // `kind: 'library'` payload (vs. `module`/`field` above, which move something already inside this
  // definition) so every drop zone below can tell "reorder/move within my own definition" apart from
  // "copy in from elsewhere" and route to CopyPlanner instead of a plain array splice.
  function startLibraryDrag(e, elementKind, payload) {
    const dragPayloadObj = { kind: 'library', elementKind, ...payload }
    try { e.dataTransfer.setData('text/plain', JSON.stringify(dragPayloadObj)) } catch {}
    e.dataTransfer.effectAllowed = 'copy'
    setDragPayload(dragPayloadObj)
  }
  function libraryDragHandleProps(elementKind, payload, title) {
    return {
      class: 'defn-drag-handle',
      draggable: true,
      role: 'button',
      title,
      'aria-label': title,
      onDragStart: (e) => startLibraryDrag(e, elementKind, payload),
      onDragEnd: endDrag,
    }
  }
  function endDrag() {
    setDragPayload(null)
    setDropTarget(null)
  }
  function readDropPayload(e) {
    let p = dragPayload
    try {
      const raw = e.dataTransfer.getData('text/plain')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') p = parsed
      }
    } catch {}
    return p
  }
  const DRAG_HANDLE_TITLES = { reorder: 'Drag to reorder', module: 'Drag onto a stage or artefact', field: 'Drag onto an artefact, or onto another module to move it there' }
  function dragHandleProps(payload, kind) {
    return {
      class: 'defn-drag-handle',
      draggable: true,
      role: 'button',
      title: DRAG_HANDLE_TITLES[kind],
      'aria-label': DRAG_HANDLE_TITLES[kind],
      onDragStart: (e) => {
        if (kind === 'reorder') startReorderDrag(e, payload.listPath, payload.index)
        else if (kind === 'module') startModuleDrag(e, payload.id)
        else if (kind === 'field') startFieldDrag(e, payload.moduleId, payload.fieldId, payload.index)
      },
      onDragEnd: endDrag,
    }
  }
  function zoneProps(key, onAccept) {
    return {
      onDragOver: (e) => {
        if (!dragPayload) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dropTarget !== key) setDropTarget(key)
      },
      onDragLeave: () => {
        if (dropTarget === key) setDropTarget(null)
      },
      onDrop: (e) => {
        e.preventDefault()
        const payload = readDropPayload(e)
        endDrag()
        if (payload) onAccept(payload)
      },
    }
  }
  function reorderZone(listPath, index) {
    return zoneProps(`${listPath}#${index}`, (payload) => {
      if (payload.kind === 'reorder' && payload.listPath === listPath) {
        updateDraft((d) => setList(d, listPath, reorder(getList(d, listPath), payload.index, index)))
      }
    })
  }
  // module onto stage (a local module just adds its id; a Library module opens a copy plan that
  // also adds it to this stage once it lands — see applyCopyFlow's `afterLand.stageIndexAddModule`)
  function stageDropZone(stageIndex) {
    return zoneProps(`stage-drop:${stageIndex}`, (payload) => {
      if (payload.kind === 'module') {
        updateDraft((d) => {
          const s = d.stages[stageIndex]
          if (!s.modules.includes(payload.id)) s.modules.push(payload.id)
        })
      } else if (payload.kind === 'library' && payload.elementKind === 'module') {
        startLibraryCopy('module', { id: payload.id }, { stageIndexAddModule: stageIndex })
      }
    })
  }
  // module or field onto artefact (a Library module opens a copy plan that adds every field it
  // lands with as a requirement — same shape as the local-module branch — a Library field opens a
  // 'requirement' copy plan directly, which brings its module along if the target lacks it)
  function artefactDropZone(artefactIndex) {
    return zoneProps(`artefact-drop:${artefactIndex}`, (payload) => {
      if (payload.kind === 'module') {
        const mod = working?.modules.find((m) => m.id === payload.id)
        if (!mod) return
        updateDraft((d) => {
          const a = d.artefacts[artefactIndex]
          for (const f of mod.fields) {
            const ref = `${payload.id}.${f.id}`
            if (!a.requires.includes(ref) && !a.requires.includes(`${ref}?`)) a.requires.push(ref)
          }
        })
      } else if (payload.kind === 'field') {
        updateDraft((d) => {
          const a = d.artefacts[artefactIndex]
          const ref = `${payload.moduleId}.${payload.fieldId}`
          if (!a.requires.includes(ref) && !a.requires.includes(`${ref}?`)) a.requires.push(ref)
        })
      } else if (payload.kind === 'library' && payload.elementKind === 'module') {
        startLibraryCopy('module', { id: payload.id }, { artefactIndexAddAllFields: artefactIndex })
      } else if (payload.kind === 'library' && payload.elementKind === 'field') {
        startLibraryCopy('field-into-artefact', { moduleId: payload.moduleId, fieldId: payload.id, targetArtefactId: working.artefacts[artefactIndex].id }, null)
      }
    })
  }
  // field between modules (dropped on a *different* module's field list moves it there; dropped
  // within its own module's list is handled by reorderFieldZone below). A Library field opens a
  // 'field' copy plan targeting this module instead of a plain splice.
  function moduleFieldsDropZone(moduleIndex, moduleId) {
    return zoneProps(`module-drop:${moduleIndex}`, (payload) => {
      if (payload.kind === 'library' && payload.elementKind === 'field') {
        startLibraryCopy('field-into-module', { moduleId: payload.moduleId, fieldId: payload.id, targetModuleId: moduleId }, null)
        return
      }
      if (payload.kind === 'module') return // dropping a module id onto a module isn't a defined move
      if (payload.kind !== 'field') return
      if (payload.moduleId === moduleId) return // same module: use reorderFieldZone instead
      updateDraft((d) => {
        const src = d.modules.find((m) => m.id === payload.moduleId)
        const dst = d.modules[moduleIndex]
        if (!src || !dst) return
        const fi = src.fields.findIndex((f) => f.id === payload.fieldId)
        if (fi === -1) return
        if (dst.fields.some((f) => f.id === payload.fieldId)) return // id clash — button route (Move to module) reports this via validation
        const [field] = src.fields.splice(fi, 1)
        dst.fields.push(field)
      })
      if (openFieldKey === `${payload.moduleId}.${payload.fieldId}`) setOpenFieldKey(`${moduleId}.${payload.fieldId}`)
    })
  }
  // Top-level copy from the Library: drop a stage/artefact/module (no specific target node — e.g.
  // the outline's "Stages"/"Artefacts"/"Modules" group heads) to copy it in as its own new element.
  function topLevelLibraryDropZone(elementKind) {
    return zoneProps(`library-drop:${elementKind}`, (payload) => {
      if (payload.kind === 'library' && payload.elementKind === elementKind) {
        startLibraryCopy(elementKind, { id: payload.id }, null)
      }
    })
  }
  function reorderFieldZone(moduleIndex, moduleId, fieldIndex) {
    return zoneProps(`module-fields:${moduleIndex}#${fieldIndex}`, (payload) => {
      if (payload.kind !== 'field') return
      if (payload.moduleId === moduleId) {
        updateDraft((d) => {
          d.modules[moduleIndex].fields = reorder(d.modules[moduleIndex].fields, payload.index, fieldIndex)
        })
      } else {
        // dropped on a specific row of a different module: same move as moduleFieldsDropZone, inserted at that row
        updateDraft((d) => {
          const src = d.modules.find((m) => m.id === payload.moduleId)
          const dst = d.modules[moduleIndex]
          if (!src || !dst) return
          const fi = src.fields.findIndex((f) => f.id === payload.fieldId)
          if (fi === -1) return
          if (dst.fields.some((f) => f.id === payload.fieldId)) return
          const [field] = src.fields.splice(fi, 1)
          dst.fields.splice(fieldIndex, 0, field)
        })
      }
    })
  }

  // ---------------------------------------------------------------- selection helpers
  // Picking or adding something always wants the focus pane to show it, so an expanded Map (#161)
  // gives the panes back rather than selecting into one the user can't see.
  function select(type, id) {
    setSelection({ type, id })
    setTemplateView(null)
    if (defnView.value === 'map' && defnMapExpanded.value) setDefnMapExpanded(false)
  }
  function selectField(moduleId, fieldId) {
    setSelection({ type: 'module', id: moduleId })
    setOpenFieldKey(`${moduleId}.${fieldId}`)
    setTemplateView(null)
  }
  function toggleField(moduleId, fieldId) {
    const key = `${moduleId}.${fieldId}`
    setOpenFieldKey((prev) => (prev === key ? null : key))
  }
  function toggleGroup(key) {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const problemTargets = validationProblems.map(problemTarget).filter(Boolean)
  function hasProblem(type, id) {
    return problemTargets.some((t) => t.type === type && t.id === id)
  }
  function jumpToFirstProblem() {
    const t = problemTargets[0]
    if (t) select(t.type, t.id)
  }

  const selectedDef = definitions?.find((d) => d.id === selectedId) ?? null

  // -------------------------------------------------------------------------------- copy provenance badge
  // "from <id> v<n>" (WI #382) — shown on every element that carries `copiedFrom`, in both the
  // outline/map and the focus pane. `element` (e.g. "module:risks.risk-register") is the tooltip,
  // not the visible label — the visible label only ever needs to answer "where did this come from".
  function copiedFromBadge(obj) {
    if (!obj?.copiedFrom) return null
    return html`<span class="stamp small review defn-from-badge" title=${`Copied from ${obj.copiedFrom.element}`}>from ${obj.copiedFrom.definition} v${obj.copiedFrom.version}</span>`
  }

  // "From another definition…" — the non-drag route WI #382 requires next to every "+ add"
  // affordance, sourced from whichever definition/version is currently picked in the Library panel.
  // A plain <select> reset to its placeholder after each pick, same convention as the existing
  // "+ Add module…"/"+ Add requirement…" selects it sits beside.
  function libraryPicker(elementKind, onPick, disabledHint) {
    if (!libDetail) return null
    const list = elementKind === 'stage' ? libDetail.stages : elementKind === 'artefact' ? libDetail.artefacts : libDetail.modules
    if (!list.length) return null
    return html`
      <select class="wizard-input defn-library-picker" aria-label=${`From another definition: ${elementKind}`} onChange=${(e) => { const val = e.currentTarget.value; if (!val) return; onPick(val); e.currentTarget.value = '' }}>
        <option value="">From another definition…</option>
        ${list.map((x) => html`<option value=${x.id}>${x.title} (${libDetail.id})</option>`)}
      </select>
    `
  }
  // Same idea, one level deeper: every field across the Library source's modules, for the field-level
  // "+ Add field" (into a module) and "+ Add requirement" (onto an artefact) pickers.
  function libraryFieldPicker(onPick) {
    if (!libDetail) return null
    const options = libDetail.modules.flatMap((m) => m.fields.map((f) => ({ value: `${m.id}.${f.id}`, label: `${m.title} · ${f.title} (${libDetail.id})` })))
    if (!options.length) return null
    return html`
      <select class="wizard-input defn-library-picker" aria-label="From another definition: field" onChange=${(e) => {
        const val = e.currentTarget.value
        if (!val) return
        const dot = val.indexOf('.')
        onPick({ moduleId: val.slice(0, dot), fieldId: val.slice(dot + 1) })
        e.currentTarget.value = ''
      }}>
        <option value="">From another definition…</option>
        ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
      </select>
    `
  }

  function describeCopyRef(ref) {
    if (ref.kind === 'module') return `module "${ref.id}"`
    if (ref.kind === 'field') return `field "${ref.moduleId}.${ref.id}"`
    if (ref.kind === 'stage') return `stage "${ref.id}"`
    if (ref.kind === 'artefact') return `artefact "${ref.id}"`
    if (ref.kind === 'requirement') return `"${ref.req}" onto artefact "${ref.artefactTitle ?? ref.artefactId}"`
    return ''
  }

  // ==================================================================================== rendering
  function renderSwitcherMenu() {
    if (newDefMode) {
      return html`
        <div class="defn-newdef-panel">
          <div class="defn-newdef-tabs">
            <button class=${'btn small' + (newDefMode === 'blank' ? ' primary' : ' ghost')} onClick=${() => { setNewDefMode('blank'); setNewDefError(null) }}>Blank</button>
            <button class=${'btn small' + (newDefMode === 'clone' ? ' primary' : ' ghost')} onClick=${() => { setNewDefMode('clone'); setNewDefError(null) }} disabled=${!selectedId}>Clone current</button>
          </div>
          ${newDefMode === 'blank' ? html`
            <label class="field-label" for="defn-newdef-blank-id">New id</label>
            <input id="defn-newdef-blank-id" class="wizard-input" placeholder="e.g. procurement" value=${newBlankId} onInput=${(e) => setNewBlankId(e.currentTarget.value)} />
            <label class="field-label" for="defn-newdef-blank-title">Title</label>
            <input id="defn-newdef-blank-title" class="wizard-input" value=${newBlankTitle} onInput=${(e) => setNewBlankTitle(e.currentTarget.value)} />
            <label class="field-label" for="defn-newdef-blank-home">Home</label>
            <select id="defn-newdef-blank-home" class="wizard-input" value=${newBlankHomeId} onChange=${(e) => setNewBlankHomeId(e.currentTarget.value)}>
              <option value="">Server library</option>
              ${workspaceHomes.map((w) => html`<option value=${w.id}>Workspace: ${w.name}</option>`)}
            </select>
          ` : html`
            <label class="field-label" for="defn-newdef-clone-id">New id (cloned from ${selectedId})</label>
            <input id="defn-newdef-clone-id" class="wizard-input" placeholder="e.g. procurement" value=${newCloneId} onInput=${(e) => setNewCloneId(e.currentTarget.value)} />
            ${definitions?.find((d) => d.id === selectedId)?.home?.kind === 'library-repo'
              ? html`
                  <label class="field-label" for="defn-newdef-clone-home">Clone into workspace</label>
                  <select id="defn-newdef-clone-home" class="wizard-input" value=${newCloneHomeId} onChange=${(e) => setNewCloneHomeId(e.currentTarget.value)}>
                    <option value="">Select a workspace…</option>
                    ${workspaceHomes.map((w) => html`<option value=${w.id}>Workspace: ${w.name}</option>`)}
                  </select>
                  <p class="guidance">This definition comes from a read-only library repo — it can only be cloned into a workspace, never edited in place.</p>
                `
              : null}
          `}
          ${newDefError ? html`<p class="inline-error">${newDefError}</p>` : null}
          <div class="defn-clone-actions">
            <button class="btn small primary" disabled=${newDefBusy} onClick=${newDefMode === 'blank' ? handleCreateBlank : handleCreateClone}>${newDefBusy ? 'Creating…' : 'Create'}</button>
            <button class="btn small ghost" onClick=${() => { setNewDefMode(null); setNewDefError(null) }}>Cancel</button>
          </div>
        </div>
      `
    }
    return html`
      <div class="defn-switcher-menu">
        ${loadError ? html`<p class="load-error">${loadError}</p>` : null}
        ${!definitions ? html`<p class="loading">Loading…</p>` : null}
        ${definitions?.length === 0 ? html`<p class="load-error">No definitions found.</p>` : null}
        ${groupDefinitionsByHome(definitions).map(
          (group) => html`
            <div class="defn-switcher-group" key=${group.key}>
              <div class="kicker">${group.label}</div>
              ${group.defs.map(
                (def) => html`
                  <div
                    key=${def.id}
                    class=${'defn-switcher-row' + (def.id === selectedId ? ' selected' : '') + (def.archived ? ' archived' : '')}
                    role="button"
                    tabindex="0"
                    onClick=${() => handleSelectDefinition(def)}
                    onKeyDown=${(e) => { if (e.key === 'Enter') handleSelectDefinition(def) }}
                  >
                    <div class="defn-switcher-row-title">${def.title} <span class="defn-id">${def.id}</span>${def.archived ? html` <span class="stamp small error">archived</span>` : null}</div>
                    <div class="defn-rail-badges">
                      ${def.versions.map((v) => html`<span class=${'stamp small' + (v.status === 'published' ? ' agreed' : ' draft')} key=${v.version}>v${v.version} · ${v.status}</span>`)}
                    </div>
                    ${def.home?.kind === 'library-repo'
                      ? null
                      : def.archived
                        ? html`<button class="btn small ghost" onClick=${(e) => handleRestore(def.id, e)}>Restore</button>`
                        : html`<button class="btn small ghost" onClick=${(e) => handleArchive(def.id, e)}>Archive</button>`}
                  </div>
                `
              )}
            </div>
          `
        )}
        <div class="defn-switcher-footer">
          <label class="defn-show-archived">
            <input type="checkbox" checked=${showArchived} onChange=${(e) => setShowArchived(e.currentTarget.checked)} />
            Show archived
          </label>
          <button class="btn small" onClick=${() => { setNewDefMode('blank'); setNewBlankId(''); setNewBlankTitle(''); setNewBlankHomeId(''); setNewDefError(null) }}>+ New definition…</button>
        </div>
      </div>
    `
  }

  function renderToolbar() {
    return html`
      <div class="defn-toolbar">
        <div class="defn-toolbar-left">
          <a class="btn small ghost" href="/" onClick=${handleGoHome}>← Workspaces</a>
          <button
            class="btn small ghost"
            title="Re-read every configured library repo now"
            disabled=${refreshingLibrary}
            onClick=${handleRefreshLibrary}
          >
            ${refreshingLibrary ? 'Refreshing…' : 'Refresh'}
          </button>
          <${Dropdown}
            className="dd defn-switcher"
            open=${switcherOpen}
            onOpenChange=${(v) => { setSwitcherOpen(v); if (!v) setNewDefMode(null) }}
            triggerClass="btn ghost"
            triggerLabel=${html`<span class="defname">${selectedDef ? selectedDef.title : 'Definitions'}</span>${selectedDef ? html` <span class="defn-id">${selectedDef.id}</span>` : null} ▾`}
          >
            ${renderSwitcherMenu()}
          <//>
          ${selectedDef
            ? html`
                <label class="sr-only" for="defn-version-select">Version</label>
                <select
                  id="defn-version-select"
                  class="wizard-input"
                  value=${String(selectedVersion)}
                  onChange=${(e) => handleSelectVersion(Number(e.currentTarget.value))}
                >
                  ${selectedDef.versions.map((v) => html`<option value=${String(v.version)}>v${v.version} — ${v.status}</option>`)}
                </select>
                ${selectedDef.home?.kind === 'library-repo'
                  ? null
                  : html`<button class="btn small" onClick=${handleNewDraft}>New draft version</button>`}
              `
            : null}
          ${detail ? html`<span class=${'stamp small ' + (detail.status === 'published' ? 'agreed' : 'draft')}>v${detail.version} ${detail.status}</span>` : null}
          ${isEditable
            ? validationProblems.length
              ? html`<button class="btn small ghost defn-problems" onClick=${jumpToFirstProblem}>● ${validationProblems.length} problem${validationProblems.length === 1 ? '' : 's'}</button>`
              : html`<span class="defn-no-problems muted">No problems</span>`
            : null}
        </div>
        <div class="defn-toolbar-right">
          ${isEditable
            ? html`
                ${renderViewToggle()}
                ${isDirty ? html`<span class="muted">Unsaved changes</span>` : null}
                ${isDirty ? html`<button class="btn small ghost" onClick=${handleDiscard} disabled=${saving}>Discard</button>` : null}
                <button class="btn primary" onClick=${handleSave} disabled=${saving || !isDirty}>${saving ? 'Saving…' : 'Save'}</button>
                <button class="btn" title=${isDirty ? 'Save your changes first' : ''} disabled=${publishing || isDirty} onClick=${handlePublish}>${publishing ? 'Publishing…' : 'Publish'}</button>
              `
            : detail
              ? html`
                  ${renderViewToggle()}
                  <p class="guidance">Read-only — published.</p>
                  ${selectedDef?.home?.kind === 'server-workspace' ? html`<button class="btn small" onClick=${handleOpenPromote}>Promote…</button>` : null}
                `
              : null}
        </div>
      </div>
      ${newDraftError ? html`<p class="inline-error">${newDraftError}</p>` : null}
      ${publishProblems.length ? html`<div class="load-error"><p><strong>Publish failed:</strong></p><ul>${publishProblems.map((p) => html`<li>${p.message}</li>`)}</ul></div>` : null}
      ${publishError ? html`<p class="load-error">${publishError}</p>` : null}
      ${saveProblems.length ? html`<div class="load-error"><p><strong>Validation failed:</strong></p><ul>${saveProblems.map((p) => html`<li>${p.message}</li>`)}</ul></div>` : null}
      ${saveError ? html`<p class="load-error">${saveError}</p>` : null}
      ${!isEditable && detail && selectedDef?.home?.kind === 'server-workspace' && promotions.length
        ? html`
            <div class="defn-promotions">
              <div class="defn-promotion-row">
                <strong>Promoted to</strong>
                <button class="btn small ghost" onClick=${handleCheckPromotions} disabled=${checkingPromotions}>${checkingPromotions ? 'Checking…' : 'Check status'}</button>
              </div>
              ${promotions.map(
                (p) => html`
                  <div class="defn-promotion-row" key=${p.repoId}>
                    <span class="defn-promotion-repo">${p.repoName}</span>
                    <a href=${p.pullRequestUrl} target="_blank" rel="noreferrer">PR #${p.pullRequestId}</a>
                    <span class="stamp small">${p.status}</span>
                    <span class=${'stamp small ' + (p.review?.state === 'approved' ? 'agreed' : 'draft')}>${p.review?.state ?? 'pending'}</span>
                    ${p.reviewerError ? html`<span class="muted">${p.reviewerError}</span>` : null}
                  </div>
                `
              )}
            </div>
          `
        : null}
      ${promoteOpen
        ? html`
            <div class="defn-promote-modal-backdrop" onClick=${() => !promoting && setPromoteOpen(false)}>
              <div class="defn-promote-modal" role="dialog" aria-label="Promote" onClick=${(e) => e.stopPropagation()}>
                <h3>Promote v${detail?.version} of ${selectedDef?.title} to a library repo</h3>
                <p class="guidance">
                  Opens one Pull Request per repo you select below, into that repo's own reviewers to
                  approve and merge — gantry never writes to a library repo directly.
                </p>
                ${promoteRepos === null
                  ? html`<p class="loading">Loading library repos…</p>`
                  : promoteRepos.length === 0
                    ? html`<p class="guidance">No library repos configured — add one in Settings first.</p>`
                    : html`
                        <div class="defn-promote-repo-list">
                          ${promoteRepos.map(
                            (repo) => html`
                              <label key=${repo.id}>
                                <input type="checkbox" checked=${promoteSelectedIds.includes(repo.id)} onChange=${() => togglePromoteRepo(repo.id)} />
                                ${repo.provider === 'github' ? `${repo.location.owner}/${repo.location.repository}` : `${repo.location.organization}/${repo.location.project}/${repo.location.repository}`}
                                ${repo.codeOwner ? html`<span class="muted"> — code owner: ${repo.codeOwner}</span>` : null}
                              </label>
                            `
                          )}
                        </div>
                      `}
                ${promoteError ? html`<p class="inline-error">${promoteError}</p>` : null}
                <div class="defn-promote-modal-actions">
                  <button class="btn small ghost" onClick=${() => setPromoteOpen(false)} disabled=${promoting}>Cancel</button>
                  <button class="btn small primary" onClick=${handlePromote} disabled=${promoting || promoteSelectedIds.length === 0}>${promoting ? 'Promoting…' : 'Promote'}</button>
                </div>
              </div>
            </div>
          `
        : null}
      ${pendingNav
        ? html`
            <div class="defn-leave-guard" role="alertdialog" aria-label="Unsaved changes">
              <span>You have unsaved changes.</span>
              <button class="btn small primary" onClick=${() => resolveGuard('save')}>Save</button>
              <button class="btn small ghost" onClick=${() => resolveGuard('discard')}>Discard</button>
              <button class="btn small ghost" onClick=${() => resolveGuard('cancel')}>Cancel</button>
            </div>
          `
        : null}
    `
  }

  // -------------------------------------------------------------------------------- Outline nav
  // -------------------------------------------------------------------------------- Field use
  // Field-use focus, shared by the Map's module chips and the Outline's module rows: with a document
  // selected, each module reads "used/total" for that document and one it draws nothing from is
  // ghosted; otherwise each reads its total field count. Only a document focuses — the page always
  // has a stage selected by default, so a stage-driven focus would leave the plain totals unreachable.
  // Returns (moduleId, module) => { ghost, count, title }.
  function moduleUsageView(d) {
    const focusArtefacts = selection.type === 'artefact' ? d.artefacts.filter((a) => a.id === selection.id) : []
    const focused = focusArtefacts.length > 0
    const focusLabel = focusArtefacts.map((a) => a.title || a.id).join(' and ')
    const usage = moduleFieldUsage(d.modules, focusArtefacts)
    return (mid, mod) => {
      const u = usage.get(mid)
      if (!u) return { ghost: false, count: null, title: undefined }
      const name = mod?.title ?? mid
      return focused
        ? {
            ghost: u.used === 0,
            count: `${u.used}/${u.total}`,
            title: `${name}: ${u.used} of ${u.total} field${u.total === 1 ? '' : 's'} used by ${focusLabel}${u.optional ? ` (${u.optional} optional)` : ''}`,
          }
        : { ghost: false, count: String(u.total), title: `${name}: ${u.total} field${u.total === 1 ? '' : 's'}` }
    }
  }
  const usageCount = (count) => (count === null || count === undefined ? null : html`<span class="defn-field-count mono">${count}</span>`)

  // -------------------------------------------------------------------------------- Outline nav
  function outlineNode({ type, id, label, draggable, dropZone, extra, moveButtons, badge, usage }) {
    const selected = selection.type === type && selection.id === id
    const key = draggable ? dragHandleProps(draggable.payload, draggable.kind) : null
    return html`
      <div
        class=${'defn-outline-node' + (selected ? ' selected' : '') + (usage?.ghost ? ' ghost' : '') + (dropTarget && dropZone && dropTarget === dropZone.key ? ' defn-drop-target' : '')}
        role="button"
        tabindex="0"
        title=${usage?.title}
        onClick=${() => select(type, id)}
        onKeyDown=${(e) => { if (e.key === 'Enter') select(type, id) }}
        ...${dropZone ? dropZone.props : {}}
      >
        ${key ? html`<span ...${key}>⠿</span>` : null}
        ${extra ?? null}
        <span class="defn-outline-label">${label}</span>
        ${badge ?? null}
        ${usage ? usageCount(usage.count) : null}
        ${hasProblem(type, id) ? html`<span class="defn-problem-dot" title="Has a validation problem"></span>` : null}
        ${moveButtons ? html`
          <span class="defn-move-btns">
            <button class="btn small ghost" aria-label=${`Move ${moveButtons.kind} "${label}" up`} disabled=${moveButtons.upDisabled} onClick=${(e) => { e.stopPropagation(); moveButtons.onUp() }}>↑</button>
            <button class="btn small ghost" aria-label=${`Move ${moveButtons.kind} "${label}" down`} disabled=${moveButtons.downDisabled} onClick=${(e) => { e.stopPropagation(); moveButtons.onDown() }}>↓</button>
          </span>
        ` : null}
      </div>
    `
  }

  function renderOutline() {
    const d = working
    const modulesCollapsed = collapsedGroups.modules
    const moduleUsageProps = moduleUsageView(d)
    return html`
      <nav class="defn-outline" aria-label="Definition outline">
        <div class="defn-outline-group">
          <div class=${'defn-outline-group-head' + (isEditable && dropTarget === 'library-drop:stage' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('stage') : {}}>
            <span class="kicker">Stages · ${d.stages.length}</span>
            ${isEditable ? html`<button class="btn small ghost" aria-label="Add stage" onClick=${() => updateDraft((dd) => { const id = `new-stage-${dd.stages.length + 1}`; dd.stages.push({ id, title: 'New Stage', purpose: '', gate: `${id}-gate`, modules: [] }); select('stage', id) })}>+</button>` : null}
            ${isEditable ? libraryPicker('stage', (id) => startLibraryCopy('stage', { id }, null)) : null}
          </div>
          ${d.stages.map((s, si) =>
            html`<div key=${s.id} ...${reorderZone('stages', si)}>${outlineNode({
              type: 'stage', id: s.id, label: s.title,
              draggable: isEditable ? { payload: { listPath: 'stages', index: si }, kind: 'reorder' } : null,
              dropZone: isEditable ? { key: `stage-drop:${si}`, props: stageDropZone(si) } : null,
              badge: copiedFromBadge(s),
              moveButtons: isEditable ? {
                kind: 'stage', upDisabled: si === 0, downDisabled: si === d.stages.length - 1,
                onUp: () => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si - 1) }),
                onDown: () => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si + 1) }),
              } : null,
            })}</div>`
          )}
        </div>
        <div class="defn-outline-group">
          <div class=${'defn-outline-group-head' + (isEditable && dropTarget === 'library-drop:artefact' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('artefact') : {}}>
            <span class="kicker">Artefacts · ${d.artefacts.length}</span>
            ${isEditable ? html`<button class="btn small ghost" aria-label="Add artefact" onClick=${() => updateDraft((dd) => { const id = `new-artefact-${dd.artefacts.length + 1}`; dd.artefacts.push({ id, title: 'New Artefact', purpose: '', template: '', gate: stageGates(dd)[0] ?? '', requires: [] }); select('artefact', id) })}>+</button>` : null}
            ${isEditable ? libraryPicker('artefact', (id) => startLibraryCopy('artefact', { id }, null)) : null}
          </div>
          ${d.artefacts.map((a, ai) =>
            html`<div key=${a.id} ...${reorderZone('artefacts', ai)}>${outlineNode({
              type: 'artefact', id: a.id, label: a.title,
              draggable: isEditable ? { payload: { listPath: 'artefacts', index: ai }, kind: 'reorder' } : null,
              dropZone: isEditable ? { key: `artefact-drop:${ai}`, props: artefactDropZone(ai) } : null,
              badge: copiedFromBadge(a),
              moveButtons: isEditable ? {
                kind: 'artefact', upDisabled: ai === 0, downDisabled: ai === d.artefacts.length - 1,
                onUp: () => updateDraft((dd) => { dd.artefacts = reorder(dd.artefacts, ai, ai - 1) }),
                onDown: () => updateDraft((dd) => { dd.artefacts = reorder(dd.artefacts, ai, ai + 1) }),
              } : null,
            })}</div>`
          )}
        </div>
        <div class="defn-outline-group">
          <div class=${'defn-outline-group-head' + (isEditable && dropTarget === 'library-drop:module' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('module') : {}}>
            <span class="kicker" role="button" tabindex="0" onClick=${() => toggleGroup('modules')}>${modulesCollapsed ? '▸' : '▾'} Modules · ${d.modules.length}</span>
            ${isEditable ? html`<button class="btn small ghost" aria-label="Add module" onClick=${() => updateDraft((dd) => { const id = `new-module-${dd.modules.length + 1}`; dd.modules.push({ id, title: 'New Module', purpose: '', fields: [] }); select('module', id) })}>+</button>` : null}
            ${isEditable ? libraryPicker('module', (id) => startLibraryCopy('module', { id }, null)) : null}
          </div>
          ${!modulesCollapsed && d.modules.map((m, mi) =>
            html`<div key=${m.id}>
              <div ...${reorderZone('modules', mi)}>${outlineNode({
                type: 'module', id: m.id, label: m.title,
                draggable: isEditable ? { payload: { listPath: 'modules', index: mi }, kind: 'reorder' } : null,
                dropZone: isEditable ? { key: `module-drop:${mi}`, props: moduleFieldsDropZone(mi, m.id) } : null,
                extra: isEditable ? html`<span ...${dragHandleProps({ id: m.id }, 'module')} title="Drag onto a stage or artefact">⠿</span>` : null,
                badge: copiedFromBadge(m),
                usage: moduleUsageProps(m.id, m),
                moveButtons: isEditable ? {
                  kind: 'module', upDisabled: mi === 0, downDisabled: mi === d.modules.length - 1,
                  onUp: () => updateDraft((dd) => { dd.modules = reorder(dd.modules, mi, mi - 1) }),
                  onDown: () => updateDraft((dd) => { dd.modules = reorder(dd.modules, mi, mi + 1) }),
                } : null,
              })}</div>
              ${selection.type === 'module' && selection.id === m.id
                ? html`<div class="defn-outline-fields">
                    ${m.fields.map((f) => html`
                      <div key=${f.id} class=${'defn-outline-field-node' + (openFieldKey === `${m.id}.${f.id}` ? ' selected' : '')} role="button" tabindex="0" onClick=${() => selectField(m.id, f.id)}>
                        · ${f.title} ${copiedFromBadge(f)}
                      </div>
                    `)}
                  </div>`
                : null}
            </div>`
          )}
        </div>
      </nav>
    `
  }

  // -------------------------------------------------------------------------------- Map nav
  function renderMap() {
    const d = working
    const usedIds = new Set(d.stages.flatMap((s) => s.modules))
    const unused = d.modules.filter((m) => !usedIds.has(m.id))
    const moduleUsageProps = moduleUsageView(d)
    // One module chip, for a stage column or "Not in any stage". On a draft the drag-handle props
    // are spread FIRST: htm applies props in order, so spreading them last would replace the chip's
    // own class (losing its styling and the ghost state), title and accessible name. The drag hint
    // rides along on the title instead.
    const moduleChip = (mid, mod) => {
      const u = moduleUsageProps(mid, mod)
      const title = isEditable ? `${u.title ?? mod?.title ?? mid} — ${DRAG_HANDLE_TITLES.module}` : u.title
      return html`
        <div key=${mid} ...${isEditable ? dragHandleProps({ id: mid }, 'module') : {}}
          class=${'defn-map-chip' + (selection.type === 'module' && selection.id === mid ? ' selected' : '') + (u.ghost ? ' ghost' : '')}
          role="button" tabindex="0" title=${title} aria-label=${isEditable ? title : undefined} onClick=${() => select('module', mid)}>
          ${mod?.title ?? mid} ${copiedFromBadge(mod)}${hasProblem('module', mid) ? html`<span class="defn-problem-dot"></span>` : null}${usageCount(u.count)}
        </div>
      `
    }
    return html`
      <div class="defn-map">
        ${d.stages.map((s, si) => html`
          <div key=${s.id} class=${'defn-map-col' + (selection.type === 'stage' && selection.id === s.id ? ' selected' : '') + (dropTarget === `stage-drop:${si}` ? ' defn-drop-target' : '')} ...${stageDropZone(si)}>
            <div class="defn-map-col-head" role="button" tabindex="0" onClick=${() => select('stage', s.id)}>
              <span class="t">${s.title}</span>
              <span class="mono muted" title=${`${s.modules.length} module${s.modules.length === 1 ? '' : 's'} in this stage`}>${s.modules.length}</span>
              ${hasProblem('stage', s.id) ? html`<span class="defn-problem-dot"></span>` : null}
            </div>
            ${isEditable ? html`
              <span class="defn-move-btns">
                <button class="btn small ghost" aria-label=${`Move stage "${s.title}" up`} disabled=${si === 0} onClick=${() => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si - 1) })}>↑</button>
                <button class="btn small ghost" aria-label=${`Move stage "${s.title}" down`} disabled=${si === d.stages.length - 1} onClick=${() => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si + 1) })}>↓</button>
              </span>
            ` : null}
            ${s.modules.map((mid) => moduleChip(mid, d.modules.find((m) => m.id === mid)))}
            <div class="defn-map-gate">
              <span class="kicker">Gate · ${s.gate}</span>
              ${d.artefacts.map((a, ai) => a.gate === s.gate
                ? html`
                    <div key=${a.id} class=${'defn-map-achip' + (selection.type === 'artefact' && selection.id === a.id ? ' selected' : '') + (dropTarget === `artefact-drop:${ai}` ? ' defn-drop-target' : '')}
                      role="button" tabindex="0" onClick=${() => select('artefact', a.id)} ...${artefactDropZone(ai)}>
                      ◇ ${a.title} <span class="mono muted" title=${`${a.requires.length} field requirement${a.requires.length === 1 ? '' : 's'}`}>${a.requires.length}</span> ${copiedFromBadge(a)}${hasProblem('artefact', a.id) ? html`<span class="defn-problem-dot"></span>` : null}
                    </div>
                  `
                : null)}
            </div>
          </div>
        `)}
        <div class=${'defn-map-col defn-map-col-unused' + (isEditable && dropTarget === 'library-drop:module' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('module') : {}}>
          <div class="defn-map-col-head"><span class="t muted">Not in any stage</span></div>
          ${unused.map((m) => moduleChip(m.id, m))}
          ${unused.length === 0 ? html`<span class="muted">—</span>` : null}
          ${isEditable ? html`
            <div class="defn-map-add-row">
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-stage-${dd.stages.length + 1}`; dd.stages.push({ id, title: 'New Stage', purpose: '', gate: `${id}-gate`, modules: [] }); select('stage', id) })}>+ Stage</button>
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-module-${dd.modules.length + 1}`; dd.modules.push({ id, title: 'New Module', purpose: '', fields: [] }); select('module', id) })}>+ Module</button>
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-artefact-${dd.artefacts.length + 1}`; dd.artefacts.push({ id, title: 'New Artefact', purpose: '', template: '', gate: stageGates(dd)[0] ?? '', requires: [] }); select('artefact', id) })}>+ Artefact</button>
              ${libraryPicker('module', (id) => startLibraryCopy('module', { id }, null))}
              ${libraryPicker('stage', (id) => startLibraryCopy('stage', { id }, null))}
              ${libraryPicker('artefact', (id) => startLibraryCopy('artefact', { id }, null))}
            </div>
          ` : null}
        </div>
      </div>
    `
  }

  // -------------------------------------------------------------------------------- Field row
  function fieldRow(mIndex, m, f, fi) {
    const key = `${m.id}.${f.id}`
    const open = openFieldKey === key
    const req = f.required ? 'required' : requiredAtGates(f)?.length ? `required at ${requiredAtGates(f).length} gate(s)` : 'optional'
    return html`
      <div key=${f.id} class=${'defn-field-row' + (open ? ' open' : '')} ...${isEditable ? reorderFieldZone(mIndex, m.id, fi) : {}}>
        <div class="defn-field-row-head" role="button" tabindex="0" onClick=${() => toggleField(m.id, f.id)}>
          ${isEditable ? html`<span ...${dragHandleProps({ moduleId: m.id, fieldId: f.id, index: fi }, 'field')}>⠿</span>` : null}
          <span class="defn-field-row-title">${f.title} <code>${f.id}</code></span>
          <span class="mono muted">${f.type}</span>
          <span class="defn-required">${req}</span>
          ${copiedFromBadge(f)}
        </div>
        ${open ? (isEditable ? fieldRowEditBody(mIndex, m, f, fi) : fieldRowViewBody(f)) : null}
      </div>
    `
  }
  function fieldRowViewBody(f) {
    return html`
      <div class="defn-field-row-body">
        ${f.guidance ? html`<div class="guidance" dangerouslySetInnerHTML=${{ __html: renderMarkdown(f.guidance) }} />` : html`<p class="muted">No guidance.</p>`}
      </div>
    `
  }
  function fieldRowEditBody(mIndex, m, f, fi) {
    const otherModules = working.modules.filter((mm) => mm.id !== m.id)
    const moveTarget = moveFieldTarget[`${m.id}.${f.id}`] ?? ''
    return html`
      <div class="defn-field-row-body">
        <div class="defn-focus-row">
          <label class="field-label">Title</label>
          <input class="wizard-input" value=${f.title ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mIndex].fields[fi].title = e.currentTarget.value })} />
          <label class="field-label">Id</label>
          <input class="wizard-input" value=${f.id ?? ''} onInput=${(e) => {
            const val = e.currentTarget.value
            if (openFieldKey === `${m.id}.${f.id}`) setOpenFieldKey(`${m.id}.${val}`)
            updateDraft((d) => { d.modules[mIndex].fields[fi].id = val })
          }} />
          ${!isValidSlugClient(f.id) ? html`<p class="inline-error">Invalid slug</p>` : null}
          <label class="field-label">Type</label>
          <select class="wizard-input defn-field-type" value=${f.type} onChange=${(e) => {
            const nextType = e.currentTarget.value
            // #86 (ADR-0044): switching a select field to any other type discards options:/multiple:/
            // default: — nothing else in the vocabulary can hold them, so warn before the draft loses
            // them, the same window.confirm convention handlePublish already uses for its own
            // irreversible action.
            if (f.type === 'select' && nextType !== 'select' && Array.isArray(f.options) && f.options.length > 0) {
              const confirmed = typeof window !== 'undefined' && window.confirm
                ? window.confirm(`Changing "${f.title || f.id}" from "select" to "${nextType}" discards its ${f.options.length} option${f.options.length === 1 ? '' : 's'}. Continue?`)
                : true
              if (!confirmed) return
            }
            updateDraft((d) => {
              const field = d.modules[mIndex].fields[fi]
              field.type = nextType
              if (nextType !== 'select') {
                delete field.options
                delete field.multiple
                delete field.default
              }
            })
          }}>
            <option value="markdown">markdown</option>
            <option value="list">list</option>
            <option value="select">select</option>
            <option value="text">text</option>
            <option value="date">date</option>
          </select>
          ${f.type === 'select' ? html`
            <label class="field-label">Options</label>
            <div>
              <div class="defn-options-list">
                ${(f.options ?? []).map((opt, oi) => html`
                  <div key=${oi} class="defn-option-row">
                    <input class="wizard-input defn-option-input" value=${opt} placeholder="Option value" onInput=${(e) => updateDraft((d) => { d.modules[mIndex].fields[fi].options[oi] = e.currentTarget.value })} />
                    <span class="defn-move-btns">
                      <button type="button" class="btn small ghost" aria-label=${`Move option "${opt}" up`} disabled=${oi === 0} onClick=${() => updateDraft((d) => { const field = d.modules[mIndex].fields[fi]; field.options = reorder(field.options, oi, oi - 1) })}>↑</button>
                      <button type="button" class="btn small ghost" aria-label=${`Move option "${opt}" down`} disabled=${oi === (f.options.length - 1)} onClick=${() => updateDraft((d) => { const field = d.modules[mIndex].fields[fi]; field.options = reorder(field.options, oi, oi + 1) })}>↓</button>
                    </span>
                    <button type="button" class="btn small ghost" aria-label=${`Remove option "${opt}"`} onClick=${() => updateDraft((d) => {
                      const field = d.modules[mIndex].fields[fi]
                      const removed = field.options[oi]
                      field.options = field.options.filter((_, idx) => idx !== oi)
                      if (field.default === removed) delete field.default
                    })}>✕</button>
                  </div>
                `)}
              </div>
              <button type="button" class="btn small ghost defn-add-option" onClick=${() => updateDraft((d) => {
                const field = d.modules[mIndex].fields[fi]
                field.options = [...(field.options ?? []), '']
              })}>+ Add option</button>
            </div>
            <label class="field-label">Multiple</label>
            <label class="defn-field-multiple"><input type="checkbox" checked=${f.multiple === true} onChange=${(e) => updateDraft((d) => {
              const field = d.modules[mIndex].fields[fi]
              if (e.currentTarget.checked) field.multiple = true
              else delete field.multiple
            })} /> Allow choosing more than one</label>
            <label class="field-label">Default</label>
            <select class="wizard-input defn-field-default" value=${f.default ?? ''} onChange=${(e) => updateDraft((d) => {
              const field = d.modules[mIndex].fields[fi]
              if (e.currentTarget.value === '') delete field.default
              else field.default = e.currentTarget.value
            })}>
              <option value="">None</option>
              ${(f.options ?? []).filter((o) => o !== '').map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
            </select>
          ` : null}
          <label class="field-label">Required</label>
          <select class="wizard-input" value=${f.required === true ? 'required' : requiredAtGates(f) ? 'required-at' : 'optional'} onChange=${(e) => {
            const v = e.currentTarget.value
            updateDraft((d) => {
              const field = d.modules[mIndex].fields[fi]
              if (v === 'optional') { delete field.required; delete field.requiredAt }
              else if (v === 'required') { field.required = true; delete field.requiredAt }
              else if (v === 'required-at') { delete field.required; field.requiredAt = requiredAtGates(field) ?? [] }
            })
          }}>
            <option value="optional">optional</option>
            <option value="required">required (always)</option>
            <option value="required-at">required at gate(s)</option>
          </select>
          ${requiredAtGates(f)
            ? html`
                <label class="field-label">At gate(s)</label>
                <div class="defn-gate-checks">
                  ${[...new Set([...stageGates(working), ...requiredAtGates(f)])].map((gate) => html`
                    <label key=${gate}><input type="checkbox" checked=${requiredAtGates(f).includes(gate)} onChange=${(e) => updateDraft((d) => {
                      const field = d.modules[mIndex].fields[fi]
                      const current = requiredAtGates(field) ?? []
                      field.requiredAt = e.currentTarget.checked ? [...current, gate] : current.filter((g) => g !== gate)
                    })} /> ${gate}${stageGates(working).includes(gate) ? '' : ' (not a stage gate)'}</label>
                  `)}
                </div>
              `
            : null}
          <label class="field-label">Guidance</label>
          <textarea class="wizard-input" rows="3" value=${f.guidance ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mIndex].fields[fi].guidance = e.currentTarget.value })}></textarea>
        </div>
        <div class="defn-field-row-actions">
          <span class="defn-move-btns">
            <button class="btn small ghost" aria-label=${`Move field "${f.title}" up`} disabled=${fi === 0} onClick=${() => updateDraft((d) => { d.modules[mIndex].fields = reorder(d.modules[mIndex].fields, fi, fi - 1) })}>↑</button>
            <button class="btn small ghost" aria-label=${`Move field "${f.title}" down`} disabled=${fi === m.fields.length - 1} onClick=${() => updateDraft((d) => { d.modules[mIndex].fields = reorder(d.modules[mIndex].fields, fi, fi + 1) })}>↓</button>
          </span>
          ${otherModules.length ? html`
            <select class="wizard-input defn-move-to-module" value=${moveTarget} onChange=${(e) => setMoveFieldTarget((prev) => ({ ...prev, [`${m.id}.${f.id}`]: e.currentTarget.value }))}>
              <option value="">Move to module…</option>
              ${otherModules.map((mm) => html`<option value=${mm.id}>${mm.title}</option>`)}
            </select>
            <button class="btn small ghost" disabled=${!moveTarget} onClick=${() => {
              const targetId = moveTarget
              if (!targetId) return
              updateDraft((d) => {
                const src = d.modules[mIndex]
                const dst = d.modules.find((mm) => mm.id === targetId)
                if (!dst || dst.fields.some((ff) => ff.id === f.id)) return
                const idx = src.fields.findIndex((ff) => ff.id === f.id)
                const [field] = src.fields.splice(idx, 1)
                dst.fields.push(field)
              })
              setMoveFieldTarget((prev) => ({ ...prev, [`${m.id}.${f.id}`]: '' }))
              setOpenFieldKey(`${targetId}.${f.id}`)
            }}>Move</button>
          ` : null}
          <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.modules[mIndex].fields.splice(fi, 1) })}>Remove field ✕</button>
        </div>
      </div>
    `
  }

  // -------------------------------------------------------------------------------- Focus pane
  function renderFocusPane() {
    if (templateView) return renderTemplateFocus()
    const d = working
    if (!d) return null
    if (selection.type === 'stage') return renderStageFocus(d)
    if (selection.type === 'artefact') return renderArtefactFocus(d)
    if (selection.type === 'module') return renderModuleFocus(d)
    return html`<p class="loading">Select an element.</p>`
  }

  function renderStageFocus(d) {
    const si = d.stages.findIndex((s) => s.id === selection.id)
    const s = d.stages[si]
    if (!s) return html`<p class="loading">Select a stage.</p>`
    const gateArtefacts = d.artefacts.filter((a) => a.gate === s.gate)
    return html`
      <div class="defn-focus">
        <span class="kicker">Stage</span>
        ${isEditable
          ? html`
              <h2><input class="wizard-input defn-focus-title-input" value=${s.title} onInput=${(e) => updateDraft((dd) => { dd.stages[si].title = e.currentTarget.value })} /> ${copiedFromBadge(s)}</h2>
              <div class="defn-focus-row">
                <label class="field-label">Id</label>
                <input class="wizard-input mono" value=${s.id} onInput=${(e) => { const val = e.currentTarget.value; if (selection.id === s.id) setSelection({ type: 'stage', id: val }); updateDraft((dd) => { dd.stages[si].id = val }) }} />
                <label class="field-label">Gate</label>
                <input class="wizard-input mono" value=${s.gate ?? ''} onInput=${(e) => updateDraft((dd) => { dd.stages[si].gate = e.currentTarget.value })} />
                <label class="field-label">Purpose</label>
                <textarea class="wizard-input" rows="2" value=${s.purpose ?? ''} onInput=${(e) => updateDraft((dd) => { dd.stages[si].purpose = e.currentTarget.value })}></textarea>
              </div>
            `
          : html`
              <h2>${s.title} <span class="defn-id">${s.id}</span> ${copiedFromBadge(s)}</h2>
              ${s.purpose ? html`<p class="guidance">${s.purpose}</p>` : null}
              <p><span class="field-label">Gate</span> <code>${s.gate}</code></p>
            `}
        <div class="defn-focus-section">
          <div class="defn-focus-section-head">
            <span class="kicker">Modules in this stage · ${s.modules.length}</span>
            ${isEditable ? html`<span class="muted defn-hint">drag to reorder · drop a module here to add it</span>` : null}
          </div>
          <div class=${'defn-chips defn-droplist' + (dropTarget === `stage-drop:${si}` ? ' defn-drop-target' : '')} ...${isEditable ? stageDropZone(si) : {}}>
            ${s.modules.map((mid, mi) => {
              const mod = d.modules.find((m) => m.id === mid)
              const readOnly = (s.readOnlyModules ?? []).includes(mid)
              return html`
                <span key=${mid} class=${'defn-chip' + (readOnly ? ' read-only' : '')} ...${isEditable ? reorderZone(`stage-modules:${si}`, mi) : {}}>
                  ${isEditable ? html`<span ...${dragHandleProps({ listPath: `stage-modules:${si}`, index: mi }, 'reorder')}>⠿</span>` : null}
                  <span role="button" tabindex="0" onClick=${() => select('module', mid)}>${mod?.title ?? mid}</span>
                  ${isEditable ? html`
                    <label class="defn-read-only-toggle" title="Mounted so this stage's documents and gate can use it, but edited at an earlier stage">
                      <input type="checkbox" aria-label=${`Read-only at this stage: ${mod?.title ?? mid}`} checked=${readOnly} onChange=${(e) => { const on = e.currentTarget.checked; updateDraft((dd) => setStageModuleReadOnly(dd.stages[si], mid, on)) }} />
                      read-only
                    </label>
                    <span class="defn-move-btns">
                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" up`} disabled=${mi === 0} onClick=${() => updateDraft((dd) => { dd.stages[si].modules = reorder(dd.stages[si].modules, mi, mi - 1) })}>↑</button>
                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" down`} disabled=${mi === s.modules.length - 1} onClick=${() => updateDraft((dd) => { dd.stages[si].modules = reorder(dd.stages[si].modules, mi, mi + 1) })}>↓</button>
                    </span>
                    <button class="btn small ghost" aria-label=${`Remove module ref "${mid}"`} onClick=${() => updateDraft((dd) => { dd.stages[si].modules.splice(mi, 1); setStageModuleReadOnly(dd.stages[si], mid, false) })}>✕</button>
                  ` : readOnly ? html`<span class="muted defn-hint">read-only</span>` : null}
                </span>
              `
            })}
          </div>
          ${isEditable ? html`
            <div class="defn-editor-inline">
              <select class="wizard-input" onChange=${(e) => { const val = e.currentTarget.value; if (!val) return; updateDraft((dd) => { if (!dd.stages[si].modules.includes(val)) dd.stages[si].modules.push(val) }); e.currentTarget.value = '' }}>
                <option value="">+ Add module…</option>
                ${d.modules.filter((m) => !s.modules.includes(m.id)).map((m) => html`<option value=${m.id}>${m.title}</option>`)}
              </select>
              ${libraryPicker('module', (id) => startLibraryCopy('module', { id }, { stageIndexAddModule: si }))}
            </div>
          ` : null}
        </div>
        <div class="defn-focus-section">
          <span class="kicker">Artefacts at this gate</span>
          <div class="defn-chips">
            ${gateArtefacts.map((a) => html`<span key=${a.id} class="defn-chip" role="button" tabindex="0" onClick=${() => select('artefact', a.id)}>${a.title}</span>`)}
            ${gateArtefacts.length === 0 ? html`<span class="muted">none</span>` : null}
          </div>
        </div>
        ${isEditable ? html`<button class="btn small ghost" onClick=${() => updateDraft((dd) => { dd.stages.splice(si, 1) })}>Remove stage ✕</button>` : null}
      </div>
    `
  }

  // Reference docx Replace/Download row (WI #385) — Download is always offered (viewing a
  // published version's reference doc is fine, same posture as "View template"); Replace only
  // when `editable` (a draft), matching the server's own draft-only guard so the UI never offers
  // an action the API would 409 straight back.
  function renderReferenceDocxRow(artefactId, editable) {
    const status = docxStatus[artefactId] ?? {}
    return html`
      <div class="defn-docx-row">
        <button class="btn small ghost" onClick=${() => handleDownloadReferenceDocx(artefactId)}>Download</button>
        ${editable
          ? html`
              <input
                type="file"
                class="wizard-input"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                aria-label="Replace reference docx"
                disabled=${status.uploading}
                onChange=${(e) => {
                  const file = e.currentTarget.files?.[0]
                  e.currentTarget.value = ''
                  if (file) handleReplaceReferenceDocx(artefactId, file)
                }}
              />
            `
          : null}
        ${status.uploading ? html`<span class="muted">Replacing…</span>` : null}
      </div>
      ${status.message ? html`<p class="save-status defn-docx-status defn-docx-saved">${status.message}</p>` : null}
      ${status.error ? html`<p class="inline-error defn-docx-status">${status.error}</p>` : null}
    `
  }

  function renderArtefactFocus(d) {
    const ai = d.artefacts.findIndex((a) => a.id === selection.id)
    const a = d.artefacts[ai]
    if (!a) return html`<p class="loading">Select an artefact.</p>`
    const groups = new Map()
    for (const r of a.requires) {
      const optional = r.endsWith('?')
      const ref = optional ? r.slice(0, -1) : r
      const dot = ref.indexOf('.')
      const moduleId = dot === -1 ? ref : ref.slice(0, dot)
      const fieldId = dot === -1 ? null : ref.slice(dot + 1)
      if (!groups.has(moduleId)) groups.set(moduleId, [])
      groups.get(moduleId).push({ fieldId, optional, raw: r })
    }
    const allFieldOptions = []
    for (const m of d.modules) {
      for (const f of m.fields) {
        const ref = `${m.id}.${f.id}`
        if (!a.requires.includes(ref) && !a.requires.includes(`${ref}?`)) allFieldOptions.push({ value: ref, label: `${m.title} · ${f.title}` })
      }
    }
    // #89 (ADR-0045): the same filenamePatternProblems messages the toolbar's dot markers already
    // count against this artefact, filtered down to the filename: ones and shown inline so a bad
    // token is explained where it's authored, not just flagged elsewhere.
    const filenameProblems = validationProblems.filter((p) => typeof p.type === 'string' && p.type.startsWith('filename-') && problemTarget(p)?.type === 'artefact' && problemTarget(p)?.id === a.id)
    const filenameTokens = [...FILENAME_BUILTIN_TOKENS, ...eligibleFilenameFields(d, a)]
    const gates = stageGates(d)
    return html`
      <div class="defn-focus">
        <span class="kicker">Artefact</span>
        ${isEditable
          ? html`
              <h2><input class="wizard-input defn-focus-title-input" value=${a.title} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].title = e.currentTarget.value })} /> ${copiedFromBadge(a)}</h2>
              <div class="defn-focus-row">
                <label class="field-label">Id</label>
                <input class="wizard-input mono" value=${a.id} onInput=${(e) => { const val = e.currentTarget.value; if (selection.id === a.id) setSelection({ type: 'artefact', id: val }); updateDraft((dd) => { dd.artefacts[ai].id = val }) }} />
                <label class="field-label">Gate</label>
                <select class="wizard-input mono defn-artefact-gate" aria-label="Gate" value=${a.gate ?? ''} onChange=${(e) => updateDraft((dd) => { dd.artefacts[ai].gate = e.currentTarget.value })}>
                  ${gates.includes(a.gate) ? null : html`<option value=${a.gate ?? ''}>${a.gate ? `${a.gate} (not a stage gate)` : 'choose a gate…'}</option>`}
                  ${gates.map((gate) => html`<option key=${gate} value=${gate}>${gate}</option>`)}
                </select>
                <label class="field-label">Purpose</label>
                <textarea class="wizard-input" rows="2" value=${a.purpose ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].purpose = e.currentTarget.value })}></textarea>
                <label class="field-label">Template</label>
                <div class="defn-template-row">
                  <input class="wizard-input mono" value=${a.template ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].template = e.currentTarget.value })} />
                  <button class="btn small" onClick=${() => handleOpenTemplate(a.id)}>Edit template</button>
                </div>
                <label class="field-label">Reference docx</label>
                ${renderReferenceDocxRow(a.id, true)}
                <label class="field-label">Filename pattern</label>
                <div class="defn-filename-editor">
                  <input class="wizard-input mono defn-filename-input" placeholder="e.g. {candidate.name} - Offer Pack" value=${a.filename ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].filename = e.currentTarget.value })} />
                  <div class="defn-filename-tokens">
                    ${filenameTokens.map((t) => html`<button key=${t.token} type="button" class="btn small ghost defn-filename-token" title=${t.label} onClick=${() => updateDraft((dd) => { dd.artefacts[ai].filename = `${dd.artefacts[ai].filename ?? ''}{${t.token}}` })}>{${t.token}}</button>`)}
                  </div>
                  ${filenameProblems.length ? html`<ul class="defn-filename-problems">${filenameProblems.map((p) => html`<li class="inline-error">${p.message}</li>`)}</ul>` : null}
                </div>
                <label class="field-label">Document Control</label>
                ${documentControlCheckbox(a, (checked) => updateDraft((dd) => {
                  if (checked) delete dd.artefacts[ai].documentControl
                  else dd.artefacts[ai].documentControl = false
                }))}
                <label class="field-label">Counts toward gate</label>
                ${satisfiesGateCheckbox(a, (checked) => updateDraft((dd) => {
                  if (checked) delete dd.artefacts[ai].satisfiesGate
                  else dd.artefacts[ai].satisfiesGate = false
                }))}
              </div>
            `
          : html`
              <h2>${a.title} <span class="defn-id">${a.id}</span>${hasProblem('artefact', a.id) ? html` <span class="stamp small error">problem</span>` : null} ${copiedFromBadge(a)}</h2>
              ${a.purpose ? html`<p class="guidance">${a.purpose}</p>` : null}
              <p><span class="field-label">Template</span> <code>${a.template}</code> <button class="btn small ghost" onClick=${() => handleOpenTemplate(a.id)}>View template</button></p>
              <p><span class="field-label">Reference docx</span></p>
              ${renderReferenceDocxRow(a.id, false)}
              ${a.filename ? html`<p><span class="field-label">Filename pattern</span> <code>${a.filename}</code></p>` : null}
              <p><span class="field-label">Document Control</span> ${documentControlCheckbox(a, null)}</p>
              <p><span class="field-label">Counts toward gate</span> ${satisfiesGateCheckbox(a, null)}</p>
            `}
        <div class="defn-focus-section">
          <div class="defn-focus-section-head">
            <span class="kicker">Requires · ${a.requires.length} field(s) in ${groups.size} module(s)</span>
            ${isEditable ? html`<span class="muted defn-hint">order = document outline · drop a module or field here</span>` : null}
          </div>
          <div class=${'defn-droplist' + (dropTarget === `artefact-drop:${ai}` ? ' defn-drop-target' : '')} ...${isEditable ? artefactDropZone(ai) : {}}>
            ${[...groups.entries()].map(([moduleId, entries]) => {
              const mod = d.modules.find((m) => m.id === moduleId)
              return html`
                <div key=${moduleId} class="defn-requires-group">
                  <span class="kicker" role="button" tabindex="0" onClick=${() => select('module', moduleId)}>${mod?.title ?? moduleId}${!mod ? html` <span class="stamp small error">missing</span>` : null}</span>
                  <div class="defn-chips">
                    ${entries.map((entry, ei) => {
                      const ri = a.requires.indexOf(entry.raw)
                      return html`
                        <span key=${entry.raw} class=${'defn-chip' + (entry.optional ? ' optional' : '')} title=${entry.optional ? 'optional in scope' : 'required'} ...${isEditable ? reorderZone(`artefact-requires:${ai}`, ri) : {}}>
                          ${isEditable ? html`<span ...${dragHandleProps({ listPath: `artefact-requires:${ai}`, index: ri }, 'reorder')}>⠿</span>` : null}
                          ${entry.fieldId ?? '(whole module)'}${entry.optional ? html` <span class="muted">?</span>` : null}
                          ${isEditable ? html`<button class="btn small ghost" aria-label=${`Remove requirement "${entry.raw}"`} onClick=${() => updateDraft((dd) => { dd.artefacts[ai].requires.splice(ri, 1) })}>✕</button>` : null}
                        </span>
                      `
                    })}
                  </div>
                </div>
              `
            })}
          </div>
          ${isEditable ? html`
            <div class="defn-editor-inline">
              <select class="wizard-input" onChange=${(e) => { const val = e.currentTarget.value; if (!val) return; updateDraft((dd) => { dd.artefacts[ai].requires.push(val) }); e.currentTarget.value = '' }}>
                <option value="">+ Add requirement…</option>
                ${allFieldOptions.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
              </select>
              ${libraryFieldPicker((f) => startLibraryCopy('field-into-artefact', { moduleId: f.moduleId, fieldId: f.fieldId, targetArtefactId: a.id }, null))}
              ${libraryPicker('module', (id) => startLibraryCopy('module', { id }, { artefactIndexAddAllFields: ai }))}
            </div>
          ` : null}
        </div>
        ${isEditable ? html`<button class="btn small ghost" onClick=${() => updateDraft((dd) => { dd.artefacts.splice(ai, 1) })}>Remove artefact ✕</button>` : null}
      </div>
    `
  }

  function renderModuleFocus(d) {
    const mi = d.modules.findIndex((m) => m.id === selection.id)
    const m = d.modules[mi]
    if (!m) return html`<p class="loading">Select a module.</p>`
    const usedStages = d.stages.filter((s) => s.modules.includes(m.id))
    const usedArtefacts = d.artefacts.filter((a) => a.requires.some((r) => (r.endsWith('?') ? r.slice(0, -1) : r).split('.')[0] === m.id))
    return html`
      <div class="defn-focus" ...${isEditable ? moduleFieldsDropZone(mi, m.id) : {}}>
        <span class="kicker">Module</span>
        ${isEditable
          ? html`
              <h2><input class="wizard-input defn-focus-title-input" value=${m.title ?? ''} onInput=${(e) => updateDraft((dd) => { dd.modules[mi].title = e.currentTarget.value })} /> ${copiedFromBadge(m)}</h2>
              <div class="defn-focus-row">
                <label class="field-label">Id</label>
                <input class="wizard-input mono" value=${m.id} onInput=${(e) => { const val = e.currentTarget.value; if (selection.id === m.id) setSelection({ type: 'module', id: val }); updateDraft((dd) => { dd.modules[mi].id = val }) }} />
                ${!isValidSlugClient(m.id) ? html`<p class="inline-error">Invalid slug</p>` : null}
                <label class="field-label">Purpose</label>
                <textarea class="wizard-input" rows="2" value=${m.purpose ?? ''} onInput=${(e) => updateDraft((dd) => { dd.modules[mi].purpose = e.currentTarget.value })}></textarea>
              </div>
            `
          : html`
              <h2>${m.title} <span class="defn-id">${m.id}</span> ${copiedFromBadge(m)}</h2>
              ${m.purpose ? html`<p class="guidance">${m.purpose}</p>` : null}
            `}
        <div class="defn-focus-section">
          <span class="kicker">Used in</span>
          <div class="defn-chips">
            ${usedStages.map((s) => html`<span key=${'s' + s.id} class="defn-chip" role="button" tabindex="0" onClick=${() => select('stage', s.id)}>${s.title}</span>`)}
            ${usedArtefacts.map((a) => html`<span key=${'a' + a.id} class="defn-chip optional" role="button" tabindex="0" onClick=${() => select('artefact', a.id)}>${a.title}</span>`)}
            ${usedStages.length === 0 && usedArtefacts.length === 0 ? html`<span class="muted">not used anywhere yet</span>` : null}
          </div>
        </div>
        <div class="defn-focus-section">
          <div class="defn-focus-section-head">
            <span class="kicker">Fields · ${m.fields.length}</span>
            ${isEditable ? html`<span class="muted defn-hint">click a row to edit it · drag to reorder or move to another module</span>` : null}
          </div>
          <div class=${'defn-field-rows' + (dropTarget === `module-drop:${mi}` ? ' defn-drop-target' : '')}>
            ${m.fields.map((f, fi) => fieldRow(mi, m, f, fi))}
          </div>
          ${isEditable ? html`
            <div class="defn-editor-inline">
              <button class="btn small" onClick=${() => updateDraft((dd) => { dd.modules[mi].fields.push({ id: `new-field-${dd.modules[mi].fields.length + 1}`, title: 'New Field', type: 'markdown', guidance: '' }) })}>+ Add field</button>
              ${libraryFieldPicker((f) => startLibraryCopy('field-into-module', { moduleId: f.moduleId, fieldId: f.fieldId, targetModuleId: m.id }, null))}
            </div>
          ` : null}
        </div>
        ${isEditable ? html`<button class="btn small ghost" onClick=${() => updateDraft((dd) => { dd.modules.splice(mi, 1) })}>Remove module ✕</button>` : null}
      </div>
    `
  }

  function renderTemplateFocus() {
    const a = working?.artefacts.find((x) => x.id === templateView.artefactId)
    const name = templateBasename(a?.template)
    return html`
      <div class="defn-focus defn-focus-template">
        <span class="kicker">Template</span>
        <h2>${name || '(no template set)'} <button class="btn small ghost" onClick=${handleCloseTemplate}>Close</button></h2>
        ${templateView.loading ? html`<p class="loading">Loading…</p>` : html`
          <div class="defn-template-editor" ref=${templateHostRef}></div>
          ${templateView.error ? html`<p class="inline-error defn-template-error">${templateView.error}</p>` : null}
          ${templateView.saved ? html`<p class="save-status defn-template-saved">${templateView.saved}</p>` : null}
          ${isEditable ? html`
            <div class="defn-template-actions">
              <button class="btn small primary" onClick=${handleSaveTemplate} disabled=${templateView.saving}>${templateView.saving ? 'Saving…' : 'Save template'}</button>
            </div>
          ` : null}
        `}
      </div>
    `
  }

  // -------------------------------------------------------------------------------- Library panel
  // -------------------------------------------------------------------------------- Copy confirm (WI #382)
  const COLLISION_CHOICE_LABEL = { rename: 'Keep both, rename the copy', replace: 'Replace mine with the copy', merge: 'Merge' }
  function collisionMergeLabel(kind) {
    return kind === 'stage' ? 'Merge: add its modules to mine' : 'Merge: add only the fields I lack'
  }
  function renderCopyFlow() {
    if (!copyFlow) return null
    const { plan, sourceId, sourceVersion } = copyFlow
    const ok = isResolved(plan)
    return html`
      <div class="defn-copy-modal-backdrop">
        <div class="defn-copy-modal" role="alertdialog" aria-label="Confirm copy">
          <h3>Copy ${describeCopyRef(plan.ref)} from <span class="defn-id">${sourceId} v${sourceVersion}</span></h3>
          ${plan.errors.length ? html`<p class="inline-error">${plan.errors.join('; ')}</p>` : null}
          ${plan.adds.length ? html`
            <div class="defn-copy-section">
              <span class="kicker">Will add</span>
              <ul>${plan.adds.map((a) => html`<li key=${`${a.kind}:${a.id}`}>${a.kind} <code>${a.id}</code>${a.moduleId ? ` in module ${a.moduleId}` : ''}${a.artefactId ? ` to ${a.artefactId}` : ''}</li>`)}</ul>
            </div>
          ` : null}
          ${plan.brings.length ? html`
            <div class="defn-copy-section">
              <span class="kicker">Comes along <span class="muted">(you don't have these yet)</span></span>
              <ul>${plan.brings.map((b) => html`<li key=${`${b.kind}:${b.id}`}>${b.kind} <code>${b.id}</code>${b.docx ? ` + ${b.docx}` : ''}</li>`)}</ul>
            </div>
          ` : null}
          ${plan.collisions.length ? html`
            <div class="defn-copy-section">
              <span class="kicker">Already exists — decide</span>
              ${plan.collisions.map((c) => html`
                <div key=${c.id} class="defn-copy-collision">
                  <p>${c.kind} <code>${c.id}</code>${c.moduleId ? ` in ${c.moduleId}` : ''} is already in your definition.</p>
                  ${c.options.map((o) => html`
                    <label key=${o}>
                      <input type="radio" name=${`copy-collision-${c.id}`} checked=${c.choice === o} onChange=${() => resolveCopyFlowCollision(c.id, o)} />
                      ${o === 'merge' ? collisionMergeLabel(c.kind) : COLLISION_CHOICE_LABEL[o]}
                    </label>
                  `)}
                  ${c.choice === 'rename' ? html`
                    <div class="defn-copy-rename">
                      <label class="field-label" for=${`copy-rename-${c.id}`}>New id</label>
                      <input id=${`copy-rename-${c.id}`} class="wizard-input mono" value=${c.renameTo} onInput=${(e) => resolveCopyFlowCollision(c.id, 'rename', e.currentTarget.value)} />
                    </div>
                  ` : null}
                </div>
              `)}
            </div>
          ` : null}
          <div class="defn-copy-modal-actions">
            <button class="btn primary" disabled=${!ok} onClick=${applyCopyFlow}>Confirm copy</button>
            <button class="btn ghost" onClick=${cancelCopyFlow}>Cancel</button>
            ${!ok && !plan.errors.length ? html`<span class="muted">Resolve every clash to confirm.</span>` : null}
          </div>
        </div>
      </div>
    `
  }

  function renderLibraryPanel() {
    const currentDef = definitions?.find((d) => d.id === selectedId) ?? null
    const otherDefs = definitions?.filter((d) => d.id !== selectedId && isEligibleCopySource(d, currentDef)) ?? []
    const sourceDef = otherDefs.find((d) => d.id === libSourceId)
    return html`
      <aside class="defn-library">
        <div class="defn-library-head">
          <span class="kicker">Library</span>
          ${isEditable ? html`<span class="muted defn-hint">drag onto the definition, or use "From another definition…"</span>` : html`<span class="muted defn-hint">read-only — published</span>`}
        </div>
        ${otherDefs.length
          ? html`
              <div class="defn-library-source-row">
                <select class="wizard-input defn-library-source" value=${libSourceId ?? ''} onChange=${(e) => setLibSourceId(e.currentTarget.value)}>
                  ${otherDefs.map((d) => html`<option value=${d.id}>${d.title} (${d.id})</option>`)}
                </select>
                ${sourceDef ? html`
                  <select class="wizard-input defn-library-version" aria-label="Library source version" value=${String(libSourceVersion ?? '')} onChange=${(e) => setLibSourceVersion(Number(e.currentTarget.value))}>
                    ${sourceDef.versions.map((v) => html`<option value=${String(v.version)}>v${v.version} · ${v.status}</option>`)}
                  </select>
                ` : null}
              </div>
            `
          : html`<p class="muted">No other definitions in the library yet.</p>`}
        ${libError ? html`<p class="inline-error">${libError}</p>` : null}
        ${libDetail
          ? html`
              <div class="defn-library-tree">
                <div class="defn-library-group">
                  <span class="kicker">Stages</span>
                  ${libDetail.stages.map((s) => html`
                    <div key=${s.id} class="defn-library-node">
                      ${isEditable ? html`<span ...${libraryDragHandleProps('stage', { id: s.id }, `Drag "${s.title}" onto the outline or map`)}>⠿</span>` : null}
                      <span>${s.title}</span>
                      ${isEditable ? html`<button class="btn small ghost defn-library-copy-btn" onClick=${() => startLibraryCopy('stage', { id: s.id }, null)}>Copy</button>` : null}
                    </div>
                  `)}
                </div>
                <div class="defn-library-group">
                  <span class="kicker">Artefacts</span>
                  ${libDetail.artefacts.map((a) => html`
                    <div key=${a.id} class="defn-library-node">
                      ${isEditable ? html`<span ...${libraryDragHandleProps('artefact', { id: a.id }, `Drag "${a.title}" onto the outline or map`)}>⠿</span>` : null}
                      <span>${a.title}</span>
                      ${isEditable ? html`<button class="btn small ghost defn-library-copy-btn" onClick=${() => startLibraryCopy('artefact', { id: a.id }, null)}>Copy</button>` : null}
                    </div>
                  `)}
                </div>
                <div class="defn-library-group">
                  <span class="kicker">Modules</span>
                  ${libDetail.modules.map((m) => html`
                    <div key=${m.id}>
                      <div class="defn-library-node">
                        ${isEditable ? html`<span ...${libraryDragHandleProps('module', { id: m.id }, `Drag "${m.title}" onto a stage, an artefact, or the outline/map`)}>⠿</span>` : null}
                        <span>${m.title}</span>
                        ${isEditable ? html`<button class="btn small ghost defn-library-copy-btn" onClick=${() => startLibraryCopy('module', { id: m.id }, null)}>Copy</button>` : null}
                      </div>
                      ${m.fields.map((f) => html`
                        <div key=${f.id} class="defn-library-node defn-library-field">
                          ${isEditable ? html`<span ...${libraryDragHandleProps('field', { moduleId: m.id, id: f.id }, `Drag "${f.title}" onto a module or an artefact`)}>⠿</span>` : null}
                          <span>· ${f.title}</span>
                        </div>
                      `)}
                    </div>
                  `)}
                </div>
              </div>
              <p class="defn-hint muted">Copying always shows what's coming along, and stops for you to resolve any name clash, before anything lands.</p>
            `
          : null}
      </aside>
    `
  }

  // -------------------------------------------------------------------------------- Layout
  // The Outline/Map switch, plus — in Map view only — the toggle that lets the Map take the whole
  // workbench. Expanding hides the focus pane and Library panel rather than unmounting them, so an
  // edit in progress down there is exactly as it was when they come back.
  function renderViewToggle() {
    return html`
      <div class="defn-view-toggle" role="group" aria-label="Outline or Map view">
        <button class=${'btn small' + (defnView.value === 'outline' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'outline'} onClick=${() => setDefnView('outline')}>Outline</button>
        <button class=${'btn small' + (defnView.value === 'map' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'map'} onClick=${() => setDefnView('map')}>Map</button>
      </div>
      ${defnView.value === 'map'
        ? html`<button class=${'btn small defn-map-expand' + (defnMapExpanded.value ? ' primary' : ' ghost')} aria-pressed=${defnMapExpanded.value}
            title=${defnMapExpanded.value ? 'Show the detail and Library panes below the map again' : 'Hide the detail and Library panes and give the map the whole workbench'}
            onClick=${() => setDefnMapExpanded(!defnMapExpanded.value)}>Expand map</button>`
        : null}
    `
  }

  function renderWorkbench() {
    if (defnView.value === 'map') {
      return html`
        <div class=${'defn-workbench defn-workbench-map' + (defnMapExpanded.value ? ' expanded' : '')}>
          <div class="defn-map-pane pane">${renderMap()}</div>
          <div class="defn-bottom" hidden=${defnMapExpanded.value}>
            <div class="defn-focus-pane pane">${renderFocusPane()}</div>
            ${renderLibraryPanel()}
          </div>
        </div>
      `
    }
    return html`
      <div class="defn-workbench defn-workbench-outline">
        <div class="pane">${renderOutline()}</div>
        <div class="defn-focus-pane pane">${renderFocusPane()}</div>
        ${renderLibraryPanel()}
      </div>
    `
  }

  return html`
    <header class="wizard-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>gantry</h1>
      </div>
    </header>
    <main class="defn-viewer">
      ${renderToolbar()}
      ${refreshLibraryError ? html`<p class="inline-error defn-library-problem">${refreshLibraryError}</p>` : null}
      ${libraryProblems.length
        ? html`
            <div class="defn-library-problems">
              ${libraryProblems.map(
                (p) => html`<p class="inline-error defn-library-problem" key=${`${p.repoId}:${p.id}`}>${p.message}</p>`
              )}
            </div>
          `
        : null}
      ${!selectedId ? html`<p class="loading">Select a definition.</p>` : null}
      ${detailLoading ? html`<p class="loading">Loading…</p>` : null}
      ${detailError ? html`<p class="load-error">${detailError}</p>` : null}
      ${detail && !detailLoading ? renderWorkbench() : null}
      ${renderCopyFlow()}
    </main>
  `
}
