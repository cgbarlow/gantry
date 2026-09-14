import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { renderMarkdown } from '../lib/markdown.js'
import { reorder } from '../lib/reorder.js'
import { Dropdown } from '../lib/dropdown.js'
import { defnView, setDefnView } from '../lib/definitionView.js'

// The rebuilt Definitions page (WI #381, Feature #380's grilling session). Primary source:
// web/prototypes/definition-editor.prototype.html — variant A (Outline) and C (Map) both wanted,
// switchable, sharing one focus pane and one docked Library panel; variant B (rail + drawer) was
// rejected. This file is a from-scratch rewrite, not a promotion of prototype markup.
//
// Vocabulary (CONTEXT.md): a definition's four **Element** kinds are Stage, Artefact, Module and
// Field. **Field visibility per artefact** is an artefact-`requires` fact (`module.field`, or
// `module.field?` for optional-in-scope) — a stage lists whole modules only.
//
// Scope note: the docked Library panel here is read-only — WI #382 wires up Copy (with provenance).

function isValidSlugClient(slug) {
  return typeof slug === 'string' && slug !== '' && slug !== '.' && slug !== '..' && /^[^\\/]+$/.test(slug)
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

  // Drag and drop — every kind here has a button-route equivalent (reorder ↑/↓; "Add module"/"Add
  // requirement" pickers; a field's own "Move to module" control).
  const [dragPayload, setDragPayload] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)

  // Docked, read-only Library panel (WI #381 scope — Copy itself is WI #382).
  const [libSourceId, setLibSourceId] = useState(null)
  const [libDetail, setLibDetail] = useState(null)
  const [libError, setLibError] = useState(null)

  // Save / Discard / Cancel leave guard (web/lib/stageSave.js's pattern): `pendingNav` holds the
  // navigation to run once the guard is resolved.
  const [pendingNav, setPendingNav] = useState(null)

  const isEditable = detail?.status === 'draft'
  const isDirty = Boolean(isEditable && draft && detail && JSON.stringify(editableStructure(draft)) !== JSON.stringify(editableStructure(detail)))
  const working = isEditable ? draft : detail

  function fetchDefinitions(showArchivedFlag) {
    const qs = showArchivedFlag ? '?archived=1' : ''
    return fetch(`/api/definitions${qs}`).then((res) => {
      if (!res.ok) throw new Error(`Failed to load definitions (${res.status})`)
      return res.json()
    })
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

  // Docked Library panel: whichever other definition is picked, read-only.
  useEffect(() => {
    if (!definitions) return
    if (libSourceId && definitions.some((d) => d.id === libSourceId)) return
    const other = definitions.find((d) => d.id !== selectedId) ?? null
    setLibSourceId(other?.id ?? null)
  }, [definitions, selectedId])

  useEffect(() => {
    if (!libSourceId) { setLibDetail(null); return }
    const def = definitions?.find((d) => d.id === libSourceId)
    if (!def) return
    const v = def.latestPublished ?? Math.max(...def.versions.map((x) => x.version))
    setLibError(null)
    fetch(`/api/definitions/${encodeURIComponent(libSourceId)}/versions/${encodeURIComponent(String(v))}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        return res.json()
      })
      .then(setLibDetail)
      .catch((err) => setLibError(err.message))
  }, [libSourceId, definitions])

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
        body: JSON.stringify({ newId: newBlankId, title: newBlankTitle || newBlankId }),
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
  // module onto stage
  function stageDropZone(stageIndex) {
    return zoneProps(`stage-drop:${stageIndex}`, (payload) => {
      if (payload.kind === 'module') {
        updateDraft((d) => {
          const s = d.stages[stageIndex]
          if (!s.modules.includes(payload.id)) s.modules.push(payload.id)
        })
      }
    })
  }
  // module or field onto artefact
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
      }
    })
  }
  // field between modules (dropped on a *different* module's field list moves it there; dropped
  // within its own module's list is handled by reorderFieldZone below)
  function moduleFieldsDropZone(moduleIndex, moduleId) {
    return zoneProps(`module-drop:${moduleIndex}`, (payload) => {
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
        <div class="defn-switcher-group">
          <div class="kicker">Server library</div>
          ${definitions?.map(
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
        <div class="defn-switcher-footer">
          <label class="defn-show-archived">
            <input type="checkbox" checked=${showArchived} onChange=${(e) => setShowArchived(e.currentTarget.checked)} />
            Show archived
          </label>
          <button class="btn small" onClick=${() => { setNewDefMode('blank'); setNewBlankId(''); setNewBlankTitle(''); setNewDefError(null) }}>+ New definition…</button>
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
  function outlineNode({ type, id, label, draggable, dropZone, extra, moveButtons }) {
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
          <div class="defn-outline-group-head">
            <span class="kicker">Stages · ${d.stages.length}</span>
          </div>
          ${d.stages.map((s, si) =>
            html`<div key=${s.id} ...${reorderZone('stages', si)}>${outlineNode({
              type: 'stage', id: s.id, label: s.title,
              draggable: isEditable ? { payload: { listPath: 'stages', index: si }, kind: 'reorder' } : null,
              dropZone: isEditable ? { key: `stage-drop:${si}`, props: stageDropZone(si) } : null,
              moveButtons: isEditable ? {
                kind: 'stage', upDisabled: si === 0, downDisabled: si === d.stages.length - 1,
                onUp: () => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si - 1) }),
                onDown: () => updateDraft((dd) => { dd.stages = reorder(dd.stages, si, si + 1) }),
              } : null,
            })}</div>`
          )}
        </div>
        <div class="defn-outline-group">
          <div class="defn-outline-group-head">
            <span class="kicker">Artefacts · ${d.artefacts.length}</span>
          </div>
          ${d.artefacts.map((a, ai) =>
            html`<div key=${a.id} ...${reorderZone('artefacts', ai)}>${outlineNode({
              type: 'artefact', id: a.id, label: a.title,
              draggable: isEditable ? { payload: { listPath: 'artefacts', index: ai }, kind: 'reorder' } : null,
              dropZone: isEditable ? { key: `artefact-drop:${ai}`, props: artefactDropZone(ai) } : null,
              moveButtons: isEditable ? {
                kind: 'artefact', upDisabled: ai === 0, downDisabled: ai === d.artefacts.length - 1,
                onUp: () => updateDraft((dd) => { dd.artefacts = reorder(dd.artefacts, ai, ai - 1) }),
                onDown: () => updateDraft((dd) => { dd.artefacts = reorder(dd.artefacts, ai, ai + 1) }),
              } : null,
            })}</div>`
          )}
        </div>
        <div class="defn-outline-group">
          <div class="defn-outline-group-head">
            <span class="kicker" role="button" tabindex="0" onClick=${() => toggleGroup('modules')}>${modulesCollapsed ? '▸' : '▾'} Modules · ${d.modules.length}</span>
          </div>
          ${!modulesCollapsed && d.modules.map((m, mi) =>
            html`<div key=${m.id}>
              <div ...${reorderZone('modules', mi)}>${outlineNode({
                type: 'module', id: m.id, label: m.title,
                draggable: isEditable ? { payload: { listPath: 'modules', index: mi }, kind: 'reorder' } : null,
                dropZone: isEditable ? { key: `module-drop:${mi}`, props: moduleFieldsDropZone(mi, m.id) } : null,
                extra: isEditable ? html`<span ...${dragHandleProps({ id: m.id }, 'module')} title="Drag onto a stage or artefact">⠿</span>` : null,
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
                        · ${f.title}
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
                  ${mod?.title ?? mid}${hasProblem('module', mid) ? html`<span class="defn-problem-dot"></span>` : null}
                </div>
              `
            })}
            <div class="defn-map-gate">
              <span class="kicker">Gate · ${s.gate}</span>
              ${d.artefacts.map((a, ai) => a.gate === s.gate
                ? html`
                    <div key=${a.id} class=${'defn-map-achip' + (selection.type === 'artefact' && selection.id === a.id ? ' selected' : '') + (dropTarget === `artefact-drop:${ai}` ? ' defn-drop-target' : '')}
                      role="button" tabindex="0" onClick=${() => select('artefact', a.id)} ...${artefactDropZone(ai)}>
                      ◇ ${a.title} <span class="mono muted">${a.requires.length}</span>${hasProblem('artefact', a.id) ? html`<span class="defn-problem-dot"></span>` : null}
                    </div>
                  `
                : null)}
            </div>
          </div>
        `)}
        <div class="defn-map-col defn-map-col-unused">
          <div class="defn-map-col-head"><span class="t muted">Not in any stage</span></div>
          ${unused.map((m) => html`<div key=${m.id} class=${'defn-map-chip' + (selection.type === 'module' && selection.id === m.id ? ' selected' : '')} role="button" tabindex="0" onClick=${() => select('module', m.id)} ...${isEditable ? dragHandleProps({ id: m.id }, 'module') : {}}>${m.title}</div>`)}
          ${unused.length === 0 ? html`<span class="muted">—</span>` : null}
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
              <h2><input class="wizard-input defn-focus-title-input" value=${s.title} onInput=${(e) => updateDraft((dd) => { dd.stages[si].title = e.currentTarget.value })} /></h2>
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
              <h2>${s.title} <span class="defn-id">${s.id}</span></h2>
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
              <h2><input class="wizard-input defn-focus-title-input" value=${a.title} onInput=${(e) => updateDraft((dd) => { dd.artefacts[ai].title = e.currentTarget.value })} /></h2>
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
              </div>
            `
          : html`
              <h2>${a.title} <span class="defn-id">${a.id}</span>${hasProblem('artefact', a.id) ? html` <span class="stamp small error">problem</span>` : null}</h2>
              ${a.purpose ? html`<p class="guidance">${a.purpose}</p>` : null}
              <p><span class="field-label">Template</span> <code>${a.template}</code> <button class="btn small ghost" onClick=${() => handleOpenTemplate(a.id)}>View template</button></p>
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
              <h2><input class="wizard-input defn-focus-title-input" value=${m.title ?? ''} onInput=${(e) => updateDraft((dd) => { dd.modules[mi].title = e.currentTarget.value })} /></h2>
              <div class="defn-focus-row">
                <label class="field-label">Id</label>
                <input class="wizard-input mono" value=${m.id} onInput=${(e) => { const val = e.currentTarget.value; if (selection.id === m.id) setSelection({ type: 'module', id: val }); updateDraft((dd) => { dd.modules[mi].id = val }) }} />
                ${!isValidSlugClient(m.id) ? html`<p class="inline-error">Invalid slug</p>` : null}
                <label class="field-label">Purpose</label>
                <textarea class="wizard-input" rows="2" value=${m.purpose ?? ''} onInput=${(e) => updateDraft((dd) => { dd.modules[mi].purpose = e.currentTarget.value })}></textarea>
              </div>
            `
          : html`
              <h2>${m.title} <span class="defn-id">${m.id}</span></h2>
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
          ${isEditable ? html`<button class="btn small" onClick=${() => updateDraft((dd) => { dd.modules[mi].fields.push({ id: `new-field-${dd.modules[mi].fields.length + 1}`, title: 'New Field', type: 'markdown', guidance: '' }) })}>+ Add field</button>` : null}
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
  function renderLibraryPanel() {
    const otherDefs = definitions?.filter((d) => d.id !== selectedId) ?? []
    return html`
      <aside class="defn-library">
        <div class="defn-library-head">
          <span class="kicker">Library</span>
          <span class="muted defn-hint">read-only for now</span>
        </div>
        ${otherDefs.length
          ? html`
              <select class="wizard-input defn-library-source" value=${libSourceId ?? ''} onChange=${(e) => setLibSourceId(e.currentTarget.value)}>
                ${otherDefs.map((d) => html`<option value=${d.id}>${d.title} (${d.id})</option>`)}
              </select>
            `
          : html`<p class="muted">No other definitions in the library yet.</p>`}
        ${libError ? html`<p class="inline-error">${libError}</p>` : null}
        ${libDetail
          ? html`
              <div class="defn-library-tree">
                <div class="defn-library-group"><span class="kicker">Stages</span>${libDetail.stages.map((s) => html`<div key=${s.id} class="defn-library-node">${s.title}</div>`)}</div>
                <div class="defn-library-group"><span class="kicker">Artefacts</span>${libDetail.artefacts.map((a) => html`<div key=${a.id} class="defn-library-node">${a.title}</div>`)}</div>
                <div class="defn-library-group">
                  <span class="kicker">Modules</span>
                  ${libDetail.modules.map((m) => html`
                    <div key=${m.id}>
                      <div class="defn-library-node">${m.title}</div>
                      ${m.fields.map((f) => html`<div key=${f.id} class="defn-library-node defn-library-field">· ${f.title}</div>`)}
                    </div>
                  `)}
                </div>
              </div>
              <p class="defn-hint muted">Copying elements from the Library arrives in a later release (WI #382).</p>
            `
          : null}
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
