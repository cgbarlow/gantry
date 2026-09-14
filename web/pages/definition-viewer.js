import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { renderMarkdown } from '../lib/markdown.js'
import { reorder } from '../lib/reorder.js'
import { Dropdown } from '../lib/dropdown.js'
import { defnView, setDefnView } from '../lib/definitionView.js'
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
function isEligibleCopySource(def, currentDef) {
  if ((def.home?.kind ?? 'library') === 'library') return true
  return currentDef?.home?.kind === 'server-workspace' && def.home.kind === 'server-workspace' && def.home.id === currentDef.home.id
}

// WI #383: the switcher's own grouping key/label for a row's `home` — "Server library" first, then
// one group per server workspace, in the order the workspace's own definitions first appear in
// `definitions` (already sorted by workspace id, since `listDefinitionsAcrossHomes` builds it that
// way). A row with no `home` at all (shouldn't happen once `includeWorkspaces=1` is always sent, but
// keeps this defensive rather than throwing) groups with the library.
function groupDefinitionsByHome(definitions) {
  const groups = new Map()
  for (const def of definitions ?? []) {
    const home = def.home ?? { kind: 'library' }
    const key = home.kind === 'library' ? 'library' : `server-workspace:${home.id}`
    if (!groups.has(key)) {
      groups.set(key, { key, label: home.kind === 'library' ? 'Server library' : `Workspace: ${home.name}`, defs: [] })
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
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [newDefMode, setNewDefMode] = useState(null) // null | 'blank' | 'clone'
  const [newBlankId, setNewBlankId] = useState('')
  const [newBlankTitle, setNewBlankTitle] = useState('')
  const [newCloneId, setNewCloneId] = useState('')
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
    setNewDefBusy(true)
    setNewDefError(null)
    try {
      const res = await fetch('/api/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: selectedId, newId: newCloneId }),
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
  function select(type, id) {
    setSelection({ type, id })
    setTemplateView(null)
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
                    ${def.archived
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
                <button class="btn small" onClick=${handleNewDraft}>New draft version</button>
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
                <div class="defn-view-toggle" role="group" aria-label="Outline or Map view">
                  <button class=${'btn small' + (defnView.value === 'outline' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'outline'} onClick=${() => setDefnView('outline')}>Outline</button>
                  <button class=${'btn small' + (defnView.value === 'map' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'map'} onClick=${() => setDefnView('map')}>Map</button>
                </div>
                ${isDirty ? html`<span class="muted">Unsaved changes</span>` : null}
                ${isDirty ? html`<button class="btn small ghost" onClick=${handleDiscard} disabled=${saving}>Discard</button>` : null}
                <button class="btn primary" onClick=${handleSave} disabled=${saving || !isDirty}>${saving ? 'Saving…' : 'Save'}</button>
                <button class="btn" title=${isDirty ? 'Save your changes first' : ''} disabled=${publishing || isDirty} onClick=${handlePublish}>${publishing ? 'Publishing…' : 'Publish'}</button>
              `
            : detail
              ? html`
                  <div class="defn-view-toggle" role="group" aria-label="Outline or Map view">
                    <button class=${'btn small' + (defnView.value === 'outline' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'outline'} onClick=${() => setDefnView('outline')}>Outline</button>
                    <button class=${'btn small' + (defnView.value === 'map' ? ' primary' : ' ghost')} aria-pressed=${defnView.value === 'map'} onClick=${() => setDefnView('map')}>Map</button>
                  </div>
                  <p class="guidance">Read-only — published.</p>
                `
              : null}
        </div>
      </div>
      ${newDraftError ? html`<p class="inline-error">${newDraftError}</p>` : null}
      ${publishProblems.length ? html`<div class="load-error"><p><strong>Publish failed:</strong></p><ul>${publishProblems.map((p) => html`<li>${p.message}</li>`)}</ul></div>` : null}
      ${publishError ? html`<p class="load-error">${publishError}</p>` : null}
      ${saveProblems.length ? html`<div class="load-error"><p><strong>Validation failed:</strong></p><ul>${saveProblems.map((p) => html`<li>${p.message}</li>`)}</ul></div>` : null}
      ${saveError ? html`<p class="load-error">${saveError}</p>` : null}
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
  function outlineNode({ type, id, label, draggable, dropZone, extra, moveButtons, badge }) {
    const selected = selection.type === type && selection.id === id
    const key = draggable ? dragHandleProps(draggable.payload, draggable.kind) : null
    return html`
      <div
        class=${'defn-outline-node' + (selected ? ' selected' : '') + (dropTarget && dropZone && dropTarget === dropZone.key ? ' defn-drop-target' : '')}
        role="button"
        tabindex="0"
        onClick=${() => select(type, id)}
        onKeyDown=${(e) => { if (e.key === 'Enter') select(type, id) }}
        ...${dropZone ? dropZone.props : {}}
      >
        ${key ? html`<span ...${key}>⠿</span>` : null}
        ${extra ?? null}
        <span class="defn-outline-label">${label}</span>
        ${badge ?? null}
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
    return html`
      <nav class="defn-outline" aria-label="Definition outline">
        <div class="defn-outline-group">
          <div class=${'defn-outline-group-head' + (isEditable && dropTarget === 'library-drop:stage' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('stage') : {}}>
            <span class="kicker">Stages · ${d.stages.length}</span>
            ${isEditable ? html`<button class="btn small ghost" aria-label="Add stage" onClick=${() => updateDraft((dd) => { const id = `new-stage-${dd.stages.length + 1}`; dd.stages.push({ id, title: 'New Stage', purpose: '', gate: '', modules: [] }); select('stage', id) })}>+</button>` : null}
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
            ${isEditable ? html`<button class="btn small ghost" aria-label="Add artefact" onClick=${() => updateDraft((dd) => { const id = `new-artefact-${dd.artefacts.length + 1}`; dd.artefacts.push({ id, title: 'New Artefact', purpose: '', template: '', gate: '', requires: [] }); select('artefact', id) })}>+</button>` : null}
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
    return html`
      <div class="defn-map">
        ${d.stages.map((s, si) => html`
          <div key=${s.id} class=${'defn-map-col' + (selection.type === 'stage' && selection.id === s.id ? ' selected' : '') + (dropTarget === `stage-drop:${si}` ? ' defn-drop-target' : '')} ...${stageDropZone(si)}>
            <div class="defn-map-col-head" role="button" tabindex="0" onClick=${() => select('stage', s.id)}>
              <span class="t">${s.title}</span>
              <span class="mono muted">${s.modules.length}</span>
              ${hasProblem('stage', s.id) ? html`<span class="defn-problem-dot"></span>` : null}
            </div>
            ${isEditable ? html`
              <span class="defn-move-btns">
                <button class="btn small ghost" aria-label=${`Move stage "${s.title}" up`} disabled=${si === 0} onClick=${() => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si - 1) })}>↑</button>
                <button class="btn small ghost" aria-label=${`Move stage "${s.title}" down`} disabled=${si === d.stages.length - 1} onClick=${() => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si + 1) })}>↓</button>
              </span>
            ` : null}
            ${s.modules.map((mid) => {
              const mod = d.modules.find((m) => m.id === mid)
              return html`
                <div key=${mid} class=${'defn-map-chip' + (selection.type === 'module' && selection.id === mid ? ' selected' : '')}
                  role="button" tabindex="0" onClick=${() => select('module', mid)}
                  ...${isEditable ? dragHandleProps({ id: mid }, 'module') : {}}>
                  ${mod?.title ?? mid} ${copiedFromBadge(mod)}${hasProblem('module', mid) ? html`<span class="defn-problem-dot"></span>` : null}
                </div>
              `
            })}
            <div class="defn-map-gate">
              <span class="kicker">Gate · ${s.gate}</span>
              ${d.artefacts.map((a, ai) => a.gate === s.gate
                ? html`
                    <div key=${a.id} class=${'defn-map-achip' + (selection.type === 'artefact' && selection.id === a.id ? ' selected' : '') + (dropTarget === `artefact-drop:${ai}` ? ' defn-drop-target' : '')}
                      role="button" tabindex="0" onClick=${() => select('artefact', a.id)} ...${artefactDropZone(ai)}>
                      ◇ ${a.title} <span class="mono muted">${a.requires.length}</span> ${copiedFromBadge(a)}${hasProblem('artefact', a.id) ? html`<span class="defn-problem-dot"></span>` : null}
                    </div>
                  `
                : null)}
            </div>
          </div>
        `)}
        <div class=${'defn-map-col defn-map-col-unused' + (isEditable && dropTarget === 'library-drop:module' ? ' defn-drop-target' : '')} ...${isEditable ? topLevelLibraryDropZone('module') : {}}>
          <div class="defn-map-col-head"><span class="t muted">Not in any stage</span></div>
          ${unused.map((m) => html`<div key=${m.id} class=${'defn-map-chip' + (selection.type === 'module' && selection.id === m.id ? ' selected' : '')} role="button" tabindex="0" onClick=${() => select('module', m.id)} ...${isEditable ? dragHandleProps({ id: m.id }, 'module') : {}}>${m.title} ${copiedFromBadge(m)}</div>`)}
          ${unused.length === 0 ? html`<span class="muted">—</span>` : null}
          ${isEditable ? html`
            <div class="defn-map-add-row">
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-stage-${dd.stages.length + 1}`; dd.stages.push({ id, title: 'New Stage', purpose: '', gate: '', modules: [] }); select('stage', id) })}>+ Stage</button>
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-module-${dd.modules.length + 1}`; dd.modules.push({ id, title: 'New Module', purpose: '', fields: [] }); select('module', id) })}>+ Module</button>
              <button class="btn small ghost" onClick=${() => updateDraft((dd) => { const id = `new-artefact-${dd.artefacts.length + 1}`; dd.artefacts.push({ id, title: 'New Artefact', purpose: '', template: '', gate: '', requires: [] }); select('artefact', id) })}>+ Artefact</button>
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
    const req = f.required ? 'required' : Array.isArray(f.requiredAt) && f.requiredAt.length ? `required at ${f.requiredAt.length} gate(s)` : 'optional'
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
          <select class="wizard-input" value=${f.type} onChange=${(e) => updateDraft((d) => { d.modules[mIndex].fields[fi].type = e.currentTarget.value })}>
            <option value="markdown">markdown</option>
            <option value="list">list</option>
          </select>
          <label class="field-label">Required</label>
          <select class="wizard-input" value=${f.required === true ? 'required' : Array.isArray(f.requiredAt) ? 'required-at' : 'optional'} onChange=${(e) => {
            const v = e.currentTarget.value
            updateDraft((d) => {
              const field = d.modules[mIndex].fields[fi]
              if (v === 'optional') { delete field.required; delete field.requiredAt }
              else if (v === 'required') { field.required = true; delete field.requiredAt }
              else if (v === 'required-at') { delete field.required; field.requiredAt = Array.isArray(field.requiredAt) ? field.requiredAt : [] }
            })
          }}>
            <option value="optional">optional</option>
            <option value="required">required (always)</option>
            <option value="required-at">required at gate(s)</option>
          </select>
          ${Array.isArray(f.requiredAt)
            ? html`
                <label class="field-label">At gate(s)</label>
                <div class="defn-gate-checks">
                  ${[...new Set(working.stages.map((s) => s.gate))].map((gate) => html`
                    <label key=${gate}><input type="checkbox" checked=${f.requiredAt.includes(gate)} onChange=${(e) => updateDraft((d) => {
                      const field = d.modules[mIndex].fields[fi]
                      field.requiredAt = e.currentTarget.checked ? [...field.requiredAt, gate] : field.requiredAt.filter((g) => g !== gate)
                    })} /> ${gate}</label>
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
              return html`
                <span key=${mid} class="defn-chip" ...${isEditable ? reorderZone(`stage-modules:${si}`, mi) : {}}>
                  ${isEditable ? html`<span ...${dragHandleProps({ listPath: `stage-modules:${si}`, index: mi }, 'reorder')}>⠿</span>` : null}
                  <span role="button" tabindex="0" onClick=${() => select('module', mid)}>${mod?.title ?? mid}</span>
                  ${isEditable ? html`
                    <span class="defn-move-btns">
                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" up`} disabled=${mi === 0} onClick=${() => updateDraft((dd) => { dd.stages[si].modules = reorder(dd.stages[si].modules, mi, mi - 1) })}>↑</button>
                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" down`} disabled=${mi === s.modules.length - 1} onClick=${() => updateDraft((dd) => { dd.stages[si].modules = reorder(dd.stages[si].modules, mi, mi + 1) })}>↓</button>
                    </span>
                    <button class="btn small ghost" aria-label=${`Remove module ref "${mid}"`} onClick=${() => updateDraft((dd) => { dd.stages[si].modules.splice(mi, 1) })}>✕</button>
                  ` : null}
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
                <input class="wizard-input mono" value=${a.gate ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].gate = e.currentTarget.value })} />
                <label class="field-label">Purpose</label>
                <textarea class="wizard-input" rows="2" value=${a.purpose ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].purpose = e.currentTarget.value })}></textarea>
                <label class="field-label">Template</label>
                <div class="defn-template-row">
                  <input class="wizard-input mono" value=${a.template ?? ''} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].template = e.currentTarget.value })} />
                  <button class="btn small" onClick=${() => handleOpenTemplate(a.id)}>Edit template</button>
                </div>
                <label class="field-label">Reference docx</label>
                ${renderReferenceDocxRow(a.id, true)}
              </div>
            `
          : html`
              <h2>${a.title} <span class="defn-id">${a.id}</span>${hasProblem('artefact', a.id) ? html` <span class="stamp small error">problem</span>` : null} ${copiedFromBadge(a)}</h2>
              ${a.purpose ? html`<p class="guidance">${a.purpose}</p>` : null}
              <p><span class="field-label">Template</span> <code>${a.template}</code> <button class="btn small ghost" onClick=${() => handleOpenTemplate(a.id)}>View template</button></p>
              <p><span class="field-label">Reference docx</span></p>
              ${renderReferenceDocxRow(a.id, false)}
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
        ${renderCopyFlow()}
      </aside>
    `
  }

  // -------------------------------------------------------------------------------- Layout
  function renderWorkbench() {
    if (defnView.value === 'map') {
      return html`
        <div class="defn-workbench defn-workbench-map">
          <div class="defn-map-pane pane">${renderMap()}</div>
          <div class="defn-bottom">
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
      ${!selectedId ? html`<p class="loading">Select a definition.</p>` : null}
      ${detailLoading ? html`<p class="loading">Loading…</p>` : null}
      ${detailError ? html`<p class="load-error">${detailError}</p>` : null}
      ${detail && !detailLoading ? renderWorkbench() : null}
    </main>
  `
}
