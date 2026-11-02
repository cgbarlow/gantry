// #279 (map #238, decided in #245): the **Source documents** panel in the Instance editor. An architect can upload evidence (a brief, requirements, meeting notes, a spreadsheet, a screenshot) to an Instance, rename it, read its text again, download it and remove it, before connecting any AI Provider. Every rule about the list lives in web/lib/sourceDocuments.js; the text is read out of each document here, in the browser (web/lib/sourceExtract.js); this file draws the panel and runs the steps in order.
//
// The panel is given a `store` with the methods web/lib/sourceDocuments.js's createSourceStore has (`list`, `upload`, `rename`, `remove`, `setText`, `readOriginal`): a Local Workspace's own folder (web/lib/localSourceDocuments.js) or the server's routes (web/lib/serverSourceDocuments.js).
import { html } from 'htm/preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  MAX_SOURCE_BYTES,
  SOURCE_FILE_ACCEPT,
  formatBytes,
  isRemovedSource,
  sourceFileTypeProblem,
  sourceSizeProblem,
} from './sourceDocuments.js'
import { extractSourceText } from './sourceExtract.js'

const NO_TEXT_REASON = {
  image: 'A picture has no text to read. The AI looks at the original.',
  scanned: 'This PDF looks scanned, so there is no text layer to read. The AI looks at the original.',
  empty: 'No text was found in it.',
}

function formatWhen(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
}

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes]))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function noTextNote(extraction) {
  if (extraction.problem) return extraction.problem
  return NO_TEXT_REASON[extraction.reason] ?? 'No text was read from it.'
}

/**
 * `store` is described above. `actor` is the name stamped on uploads and removals ('' when unknown). `readOnly` hides every control that changes the list (an archived Instance). `extract(filename, bytes)` is the text reader; tests and the app use the default.
 */
export function SourceDocumentsPanel({ store, actor = '', readOnly = false, extract = extractSourceText }) {
  const [list, setList] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(null)

  const reload = useCallback(async () => {
    try {
      setList(await store.list())
      setLoadError('')
    } catch (err) {
      setLoadError(err.message)
    }
  }, [store])

  useEffect(() => {
    setList(null)
    setMessage(null)
    setRenaming(null)
    setConfirmRemove(null)
    reload()
  }, [reload])

  async function run(work) {
    setBusy(true)
    try {
      await work()
    } catch (err) {
      setMessage({ kind: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const typeProblem = sourceFileTypeProblem(file.name)
      const sizeProblem = sourceSizeProblem(file.size, file.name)
      if (typeProblem || sizeProblem) {
        setMessage({ kind: 'error', text: typeProblem ?? sizeProblem })
        continue
      }
      await run(async () => {
        setMessage({ kind: 'info', text: `Reading ${file.name}…` })
        const bytes = new Uint8Array(await file.arrayBuffer())
        const extraction = await extract(file.name, bytes)
        setMessage({ kind: 'info', text: `Saving ${file.name}…` })
        const { entry } = await store.upload({ filename: file.name, bytes, text: extraction.text ?? undefined, uploadedBy: actor })
        await reload()
        setMessage(
          extraction.text !== null
            ? { kind: 'ok', text: `Added "${entry.title}" and read its text.` }
            : { kind: extraction.problem ? 'warn' : 'ok', text: `Added "${entry.title}". ${noTextNote(extraction)}` }
        )
      })
    }
  }

  async function onPick(event) {
    const input = event.currentTarget
    const files = [...(input.files ?? [])]
    input.value = ''
    if (files.length) await uploadFiles(files)
  }

  const saveRename = () =>
    run(async () => {
      await store.rename(renaming.id, renaming.title)
      setRenaming(null)
      await reload()
      setMessage({ kind: 'ok', text: 'Renamed. Only the title changed; citations already written keep the title they were written with.' })
    })

  const extractAgain = (entry) =>
    run(async () => {
      setMessage({ kind: 'info', text: `Reading ${entry.filename} again…` })
      const { bytes } = await store.readOriginal(entry.id)
      if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
      const extraction = await extract(entry.filename, bytes)
      if (extraction.problem) {
        // Leave the text already kept as it was: a failed read is not a reason to lose a good one.
        setMessage({ kind: 'warn', text: `${extraction.problem} The text already kept for "${entry.title}" is unchanged.` })
        return
      }
      await store.setText(entry.id, extraction.text)
      await reload()
      setMessage(
        extraction.text !== null
          ? { kind: 'ok', text: `Read the text of "${entry.title}" again.` }
          : { kind: 'ok', text: `"${entry.title}" has no text now. ${noTextNote(extraction)}` }
      )
    })

  const downloadOriginal = (entry) =>
    run(async () => {
      const { bytes } = await store.readOriginal(entry.id)
      if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
      download(bytes, entry.filename)
    })

  const removeConfirmed = (entry) =>
    run(async () => {
      await store.remove(entry.id, { removedBy: actor })
      setConfirmRemove(null)
      await reload()
      setMessage({ kind: 'ok', text: `Removed "${entry.title}". Its file and text are deleted; its name stays in the list.` })
    })

  const entries = list?.entries ?? []
  const live = entries.filter((e) => !isRemovedSource(e))
  const removed = entries.filter(isRemovedSource)

  return html`
    <details class="source-documents" data-testid="source-documents">
      <summary data-testid="source-documents-summary">Source documents${list ? html` <span class="source-documents-count">(${live.length})</span>` : null}</summary>
      <div class="source-documents-body">
        <p class="guidance source-documents-intro">
          Evidence this Instance's content is drawn from: briefs, requirements, meeting notes, spreadsheets, screenshots. They are kept with the Instance, separate from its images, and Gantry reads the text out of each one when you add it. Word, PowerPoint, spreadsheets, PDFs, Markdown, text and images, up to ${formatBytes(MAX_SOURCE_BYTES)} each.
        </p>
        ${loadError ? html`<p class="inline-error" role="alert" data-testid="source-documents-load-error">${loadError}</p>` : null}
        ${list?.warning ? html`<p class="source-documents-warning" role="status" data-testid="source-documents-warning">${list.warning}</p>` : null}
        ${readOnly
          ? null
          : html`<div class="source-documents-upload">
              <label class=${`btn small${busy ? ' disabled' : ''}`}>
                Upload documents
                <input type="file" multiple accept=${SOURCE_FILE_ACCEPT} aria-label="Upload Source documents" data-testid="source-documents-input" style="display:none" disabled=${busy} onChange=${onPick} />
              </label>
            </div>`}
        <p class=${`source-documents-message ${message ? message.kind : ''}`} role="status" aria-live="polite" data-testid="source-documents-message">${message ? message.text : ''}</p>
        ${list === null && !loadError ? html`<p class="loading">Loading…</p>` : null}
        ${list !== null && live.length === 0
          ? html`<p class="muted source-documents-empty" data-testid="source-documents-empty">No Source documents yet.</p>`
          : null}
        ${live.length > 0
          ? html`<table class="source-documents-table" data-testid="source-documents-list">
              <thead>
                <tr><th>Title</th><th>File</th><th>Size</th><th>Added</th><th>Text</th><th><span class="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                ${live.map(
                  (entry) => html`<tr key=${entry.id} data-source-id=${entry.id}>
                    <td class="source-documents-title">
                      ${renaming?.id === entry.id
                        ? html`<form
                            class="source-documents-rename"
                            onSubmit=${(e) => {
                              e.preventDefault()
                              saveRename()
                            }}
                          >
                            <input
                              type="text"
                              aria-label=${`New title for ${entry.title}`}
                              value=${renaming.title}
                              onInput=${(e) => setRenaming({ id: entry.id, title: e.currentTarget.value })}
                              data-testid="source-documents-rename-input"
                            />
                            <button type="submit" class="btn small primary" disabled=${busy || !renaming.title.trim()}>Save</button>
                            <button type="button" class="btn small ghost" onClick=${() => setRenaming(null)}>Cancel</button>
                          </form>`
                        : html`<span class="source-documents-title-text">${entry.title}</span>`}
                    </td>
                    <td class="source-documents-file">${entry.filename}</td>
                    <td>${formatBytes(entry.size)}</td>
                    <td>${formatWhen(entry.uploadedAt)}${entry.uploadedBy ? html`<br /><span class="muted">${entry.uploadedBy}</span>` : null}</td>
                    <td>
                      ${entry.text
                        ? html`<span class="stamp agreed" title="The text read from this document is kept with it">TEXT READ</span>`
                        : html`<span class="stamp review" title="No text was kept: the AI looks at the original">NO TEXT</span>`}
                    </td>
                    <td>
                      ${confirmRemove === entry.id
                        ? html`<div class="source-documents-actions source-documents-confirm" role="group" aria-label=${`Remove ${entry.title}`}>
                            <span>Remove "${entry.title}"? Its file and text are deleted.</span>
                            <button type="button" class="btn small primary" disabled=${busy} onClick=${() => removeConfirmed(entry)} data-testid="source-documents-confirm-remove">Remove</button>
                            <button type="button" class="btn small ghost" onClick=${() => setConfirmRemove(null)}>Cancel</button>
                          </div>`
                        : html`<div class="source-documents-actions">
                            <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => downloadOriginal(entry)}>Download</button>
                            ${readOnly
                              ? null
                              : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => setRenaming({ id: entry.id, title: entry.title })}>Rename</button>
                                  <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => extractAgain(entry)}>Extract text again</button>
                                  <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => setConfirmRemove(entry.id)}>Remove</button>`}
                          </div>`}
                    </td>
                  </tr>`
                )}
              </tbody>
            </table>`
          : null}
        ${removed.length > 0
          ? html`<details class="source-documents-removed" data-testid="source-documents-removed">
              <summary>Removed (${removed.length})</summary>
              <ul>
                ${removed.map(
                  (entry) => html`<li key=${entry.id} data-source-id=${entry.id}>
                    <span class="source-documents-removed-title">${entry.title}</span>
                    <span class="muted"> · removed ${formatWhen(entry.removedAt)}${entry.removedBy ? ` by ${entry.removedBy}` : ''}</span>
                  </li>`
                )}
              </ul>
            </details>`
          : null}
      </div>
    </details>
  `
}
