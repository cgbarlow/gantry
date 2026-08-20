import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt()

async function loadInstance(stageId) {
  const url = stageId ? `/api/instance?stage=${encodeURIComponent(stageId)}` : '/api/instance'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load instance (${res.status})`)
  return res.json()
}

// Free-browse stage switcher: lets you view/edit any stage's modules
// without changing the instance's own persisted current stage.
function renderStageNav(container, stages, currentStageId, viewedStageId, onSelect) {
  container.replaceChildren()
  stages.forEach((stage) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = stage.title + (stage.id === currentStageId ? ' (current)' : '')
    if (stage.id === viewedStageId) button.classList.add('active')
    button.addEventListener('click', () => onSelect(stage.id))
    container.appendChild(button)
  })
}

function renderPreview(container, text) {
  container.innerHTML = DOMPurify.sanitize(md.render(text))
}

function fieldLabel(field) {
  const label = document.createElement('label')
  label.textContent = field.title + (field.required ? ' *' : '')
  return label
}

function fieldGuidance(field) {
  if (!field.guidance) return null
  const p = document.createElement('p')
  p.className = 'guidance'
  p.textContent = field.guidance
  return p
}

// EditorView.updateListener -> markdown-it -> DOMPurify -> sibling preview
// pane, per docs/adr/0004-markdown-editor-codemirror.md.
function createMarkdownField(field) {
  const wrapper = document.createElement('div')
  wrapper.className = 'field field-markdown'
  wrapper.appendChild(fieldLabel(field))
  const guidance = fieldGuidance(field)
  if (guidance) wrapper.appendChild(guidance)

  const split = document.createElement('div')
  split.className = 'split'
  const editorHost = document.createElement('div')
  editorHost.className = 'editor-host'
  const preview = document.createElement('div')
  preview.className = 'preview'
  split.append(editorHost, preview)
  wrapper.appendChild(split)

  const state = EditorState.create({
    doc: field.value ?? '',
    extensions: [
      basicSetup,
      markdown(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) renderPreview(preview, update.state.doc.toString())
      }),
    ],
  })
  const view = new EditorView({ state, parent: editorHost })
  renderPreview(preview, field.value ?? '')

  function setValue(text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
    renderPreview(preview, text ?? '')
  }

  return { element: wrapper, getValue: () => view.state.doc.toString(), setValue }
}

function createListField(field) {
  const wrapper = document.createElement('div')
  wrapper.className = 'field field-list'
  wrapper.appendChild(fieldLabel(field))
  const guidance = fieldGuidance(field)
  if (guidance) wrapper.appendChild(guidance)

  const rows = document.createElement('div')
  rows.className = 'list-rows'
  wrapper.appendChild(rows)

  function addRow(value) {
    const row = document.createElement('div')
    row.className = 'list-row'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = value ?? ''
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => row.remove())
    row.append(input, remove)
    rows.appendChild(row)
  }

  const initialValues = field.value?.length ? field.value : ['']
  initialValues.forEach(addRow)

  const addButton = document.createElement('button')
  addButton.type = 'button'
  addButton.textContent = 'Add'
  addButton.addEventListener('click', () => addRow())
  wrapper.appendChild(addButton)

  function setValue(values) {
    rows.replaceChildren()
    const items = values?.length ? values : ['']
    items.forEach(addRow)
  }

  return {
    element: wrapper,
    getValue: () => [...rows.querySelectorAll('input')].map((i) => i.value).filter((v) => v.trim() !== ''),
    setValue,
  }
}

function renderModule(mod, stageId) {
  const section = document.createElement('section')
  section.className = 'module'

  const heading = document.createElement('h2')
  heading.textContent = mod.title
  section.appendChild(heading)

  if (mod.purpose) {
    const purpose = document.createElement('p')
    purpose.className = 'purpose'
    purpose.textContent = mod.purpose
    section.appendChild(purpose)
  }

  const fieldControls = mod.fields.map((field) =>
    field.type === 'list' ? createListField(field) : createMarkdownField(field)
  )
  fieldControls.forEach((control) => section.appendChild(control.element))

  const status = document.createElement('div')
  status.className = 'save-status'

  const saveButton = document.createElement('button')
  saveButton.type = 'button'
  saveButton.textContent = `Save ${mod.title}`
  saveButton.addEventListener('click', async () => {
    const fields = {}
    mod.fields.forEach((field, i) => {
      fields[field.id] = fieldControls[i].getValue()
    })
    status.textContent = 'Saving…'
    const res = await fetch(`/api/instance/modules/${mod.id}?stage=${encodeURIComponent(stageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: mod.status, owner: mod.owner, fields }),
    })
    if (!res.ok) {
      status.textContent = 'Save failed.'
      return
    }
    const instanceStatus = await res.json()
    const thisModule = instanceStatus.modules.find((m) => m.id === mod.id)
    status.textContent = thisModule?.complete
      ? 'Saved — complete.'
      : `Saved — outstanding: ${thisModule?.outstanding.join(', ') || 'none'}`
  })
  section.append(saveButton, status)

  return { element: section, fieldControls }
}

// One "Populate"/"Clear" pair per gate screen, acting across every module
// shown for that stage — not per-module, since a gate's fields are what
// you're filling in together.
function renderStageActions(fieldEntries, hasExample) {
  const container = document.createElement('div')
  container.className = 'stage-actions'

  const populateButton = document.createElement('button')
  populateButton.type = 'button'
  populateButton.textContent = 'Populate example text'
  populateButton.disabled = !hasExample
  populateButton.title = hasExample ? '' : 'No example instance configured for this stage'
  populateButton.addEventListener('click', () => {
    fieldEntries.forEach(({ field, control }) => control.setValue(field.example))
  })

  const clearButton = document.createElement('button')
  clearButton.type = 'button'
  clearButton.textContent = 'Clear all fields'
  clearButton.addEventListener('click', () => {
    fieldEntries.forEach(({ field, control }) => control.setValue(field.type === 'list' ? [] : ''))
  })

  container.append(populateButton, clearButton)
  return container
}

function renderArtefactsSection(instance) {
  const section = document.createElement('section')
  section.className = 'artefacts'

  const heading = document.createElement('h2')
  heading.textContent = 'Render'
  section.appendChild(heading)

  const status = document.createElement('div')
  status.className = 'save-status'

  instance.artefacts.forEach((artefact) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `Render ${artefact.title}`
    button.addEventListener('click', async () => {
      status.textContent = 'Rendering…'
      const res = await fetch(`/api/instance/render/${artefact.id}`, { method: 'POST' })
      const body = await res.json()
      status.textContent = res.ok ? `Rendered to ${body.docxPath}` : `Render failed: ${body.error}`
    })
    section.appendChild(button)
  })

  section.appendChild(status)
  return section
}

async function renderInstance(stageId) {
  const instance = await loadInstance(stageId)
  document.getElementById('instance-title').textContent = `${instance.slug} — ${instance.definition}`
  document.getElementById('stage-line').textContent = `${instance.stage.title} (gate: ${instance.stage.gate})`

  renderStageNav(
    document.getElementById('stage-nav'),
    instance.stages,
    instance.currentStageId,
    instance.stage.id,
    (selectedStageId) => renderInstance(selectedStageId).catch((err) => {
      document.body.textContent = `Failed to load: ${err.message}`
    })
  )

  const fieldEntries = []
  const modulesRoot = document.getElementById('modules')
  modulesRoot.replaceChildren()
  instance.modules.forEach((mod) => {
    const { element, fieldControls } = renderModule(mod, instance.stage.id)
    modulesRoot.appendChild(element)
    mod.fields.forEach((field, i) => fieldEntries.push({ field, control: fieldControls[i] }))
  })
  modulesRoot.appendChild(renderArtefactsSection(instance))

  document.getElementById('stage-actions').replaceChildren(
    renderStageActions(fieldEntries, instance.hasExample)
  )
}

renderInstance().catch((err) => {
  document.body.textContent = `Failed to load: ${err.message}`
})
