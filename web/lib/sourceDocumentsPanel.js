// #279 (map #238, decided in #245): the **Source documents** panel in the Instance editor. An architect can upload evidence (a brief, requirements, meeting notes, a spreadsheet, a screenshot) to an Instance, rename it, read its text again, download it and remove it, before connecting any AI Provider. Every rule about the list lives in web/lib/sourceDocuments.js; the text is read out of each document here, in the browser (web/lib/sourceExtract.js); this file draws the panel and runs the steps in order.
//
// The panel is given a `store` with the methods web/lib/sourceDocuments.js's createSourceStore has (`list`, `upload`, `rename`, `remove`, `setText`, `readOriginal`): a Local Workspace's own folder (web/lib/localSourceDocuments.js) or the server's routes (web/lib/serverSourceDocuments.js).
import { html } from 'htm/preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  MAX_SOURCE_BYTES,
  SOURCE_FILE_ACCEPT,
  formatBytes,
  canUseSourceAsImage,
  isRemovedSource,
  replacedByMap,
  sourceFileExtension,
  sourceFileKind,
  sourceFileTypeProblem,
  sourceSizeProblem,
} from './sourceDocuments.js'
import { extractSourceText, noTextNote } from './sourceExtract.js'
import { sourceCitationFor } from './sourceCitations.js'
import { sourceListTick } from './outOfDateState.js'

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

// What a browser can show in a tab without running anything from the document: a PDF, a picture or plain text. Everything else (a Word, PowerPoint or Excel file, a Markdown file's own type) is saved instead. Never a type that could run script, such as HTML.
const VIEWABLE_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.markdown': 'text/plain',
  '.csv': 'text/plain',
  '.tsv': 'text/plain',
}

/**
 * #281: opens a Source document from a citation. A PDF, picture or text file opens in a new tab; a Word, PowerPoint or spreadsheet file, which a browser can't show, is saved to the person's machine. `store` is the panel's; `entry` is `{ id, filename, title }`. Rejects with the reason when the file can't be read.
 */
export async function openSourceDocument(store, entry) {
  const { bytes } = await store.readOriginal(entry.id)
  if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
  const type = VIEWABLE_TYPES[sourceFileExtension(entry.filename)]
  if (!type) {
    download(bytes, entry.filename)
    return
  }
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * #297: `newSince` is the set of document ids marked **New since last interview** (worked out from the decisions logs by the caller). Each document that a newer one replaces shows "replaced by <new>", and the upload has a "This replaces…" picker that records the link in the manifest.
 *
 * `store` is described above. `actor` is the name stamped on uploads and removals ('' when unknown). `readOnly` hides every control that changes the list (an archived Instance). `commitNote` is shown under the introduction when each change is committed to a repository as it is made (an Azure DevOps or GitHub workspace, #280). `extract(filename, bytes)` is the text reader; tests and the app use the default. `compact` draws the list as the Interview page's narrow rail does (#286): titles, a "+ Add Source document" button and a drop zone, with no table; `onList(list)` is told whenever the list has been read (after a load or a change).
 */
export function SourceDocumentsPanel({ store, actor = '', readOnly = false, commitNote = '', extract = extractSourceText, onList = null, compact = false, newSince = null }) {
  const [list, setList] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(null)
  // #297: the older document the next upload replaces ('' for none).
  const [replaces, setReplaces] = useState('')

  const reload = useCallback(async () => {
    try {
      const loaded = await store.list()
      setList(loaded)
      setLoadError('')
      onList?.(loaded)
      // #297: tells the editor and the Interview page to look again for Out of date Fields.
      sourceListTick.value += 1
    } catch (err) {
      setLoadError(err.message)
    }
  }, [store, onList])

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
    if (replaces && files.length > 1) {
      setMessage({ kind: 'error', text: 'Pick one file at a time when it replaces another document.' })
      return
    }
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
        const older = replaces ? entries.find((e) => e.id === replaces) : null
        const { entry } = await store.upload({ filename: file.name, bytes, text: extraction.text ?? undefined, uploadedBy: actor, ...(replaces ? { replaces } : {}) })
        setReplaces('')
        await reload()
        const replacing = older ? ` It replaces "${older.title}", which stays in the list and can still be cited.` : ''
        setMessage(
          extraction.text !== null
            ? { kind: 'ok', text: `Added "${entry.title}" and read its text.${replacing}` }
            : { kind: extraction.problem ? 'warn' : 'ok', text: `Added "${entry.title}". ${noTextNote(extraction)}${replacing}` }
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

  // #292: a PDF sent as the PDF itself, for an AI Provider that takes PDFs, instead of as its text.
  const toggleReadVisually = (entry) =>
    run(async () => {
      const on = !entry.readVisually
      await store.setReadVisually(entry.id, on)
      await reload()
      setMessage({
        kind: 'ok',
        text: on
          ? `"${entry.title}" will be read visually: an AI Provider that takes PDFs is sent the PDF itself, which suits diagrams and layouts. One that doesn't still gets its text.`
          : `"${entry.title}" will be read as text again.`,
      })
    })

  const downloadOriginal = (entry) =>
    run(async () => {
      const { bytes } = await store.readOriginal(entry.id)
      if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
      download(bytes, entry.filename)
    })

  const copyCitation = (entry) =>
    run(async () => {
      const citation = sourceCitationFor(entry)
      try {
        await navigator.clipboard.writeText(citation)
        setMessage({ kind: 'ok', text: `Copied ${citation}. Paste it into a field where the content draws on "${entry.title}".` })
      } catch {
        setMessage({ kind: 'info', text: `Copy this into a field where the content draws on "${entry.title}": ${citation}` })
      }
    })

  const useAsImage = (entry) =>
    run(async () => {
      const image = await store.useAsImage(entry.id, { uploadedBy: actor })
      setMessage({ kind: 'ok', text: `Copied "${entry.title}" to the images as a new image. Insert it from the Image dialog, or paste ${image.reference}. Removing either one leaves the other alone.` })
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
  const replacedByEntry = replacedByMap(entries)
  const isNewSince = (entry) => Boolean(newSince?.has?.(entry.id)) && !entry.replaces
  // #297: the marks a document carries after the title.
  const marks = (entry) => [
    replacedByEntry.has(entry.id)
      ? html`<span class="stamp review" data-testid="source-replaced-by" title="A newer document replaces this one. This one is kept and can still be cited.">replaced by ${replacedByEntry.get(entry.id).title}</span>`
      : null,
    isNewSince(entry)
      ? html`<span class="stamp new" data-testid="source-new-since" title="Added since the last AI interview. The next interview reads it against what is saved.">New since last interview</span>`
      : null,
  ]
  const replacesPicker = () =>
    live.length > 0 && !readOnly
      ? html`<select class="source-replaces" data-testid="source-replaces" aria-label="This replaces…" value=${replaces} disabled=${busy} onChange=${(e) => setReplaces(e.currentTarget.value)}>
          <option value="" selected=${replaces === ''}>This replaces… (nothing)</option>
          ${live.map((e) => html`<option key=${e.id} value=${e.id} selected=${replaces === e.id}>This replaces… ${e.title}</option>`)}
        </select>`
      : null

  if (compact) {
    return html`
      <div class="source-documents source-documents-compact" data-testid="source-documents-compact">
        ${loadError ? html`<p class="inline-error" role="alert">${loadError}</p>` : null}
        ${list === null && !loadError ? html`<p class="loading">Loading…</p>` : null}
        ${list !== null && live.length === 0 ? html`<p class="muted" data-testid="source-documents-empty">No Source documents yet.</p>` : null}
        ${live.length > 0
          ? html`<ul class="srcdocs" data-testid="source-documents-list">
              ${live.map(
                (entry) => html`<li key=${entry.id} data-source-id=${entry.id}>
                  <span class="srcdoc-title" title=${entry.filename}>${entry.title}</span>
                  <span class="meta">${formatBytes(entry.size)}${entry.text ? '' : ' · no text'}</span>
                  ${marks(entry)}
                  ${sourceFileKind(entry.filename) === 'pdf' && store.setReadVisually
                    ? html`<label class="srcdoc-visual" title="Send the PDF itself to an AI Provider that takes PDFs, instead of its text">
                        <input type="checkbox" data-testid="source-read-visually" checked=${entry.readVisually === true} disabled=${busy || readOnly} onChange=${() => toggleReadVisually(entry)} />
                        Read visually
                      </label>`
                    : null}
                </li>`
              )}
            </ul>`
          : null}
        ${list?.warning ? html`<p class="source-documents-warning" role="status">${list.warning}</p>` : null}
        ${replacesPicker()}
        ${readOnly
          ? null
          : html`<label
              class=${`dropzone${busy ? ' disabled' : ''}`}
              data-testid="source-documents-dropzone"
              onDragOver=${(e) => e.preventDefault()}
              onDrop=${(e) => {
                e.preventDefault()
                const files = [...(e.dataTransfer?.files ?? [])]
                if (files.length) uploadFiles(files)
              }}
            >
              + Add Source document
              <input type="file" multiple accept=${SOURCE_FILE_ACCEPT} aria-label="Add Source documents" data-testid="source-documents-input" style="display:none" disabled=${busy} onChange=${onPick} />
            </label>`}
        <p class=${`source-documents-message ${message ? message.kind : ''}`} role="status" aria-live="polite" data-testid="source-documents-message">${message ? message.text : ''}</p>
      </div>
    `
  }

  return html`
    <details class="source-documents" data-testid="source-documents">
      <summary data-testid="source-documents-summary">Source documents${list ? html` <span class="source-documents-count">(${live.length})</span>` : null}</summary>
      <div class="source-documents-body">
        <p class="guidance source-documents-intro">
          Evidence this Instance's content is drawn from: briefs, requirements, meeting notes, spreadsheets, screenshots. They are kept with the Instance, separate from its images, and Gantry reads the text out of each one when you add it. Word, PowerPoint, spreadsheets, PDFs, Markdown, text and images, up to ${formatBytes(MAX_SOURCE_BYTES)} each.
        </p>
        ${commitNote ? html`<p class="guidance source-documents-commit-note" data-testid="source-documents-commit-note">${commitNote}</p>` : null}
        ${loadError ? html`<p class="inline-error" role="alert" data-testid="source-documents-load-error">${loadError}</p>` : null}
        ${list?.warning ? html`<p class="source-documents-warning" role="status" data-testid="source-documents-warning">${list.warning}</p>` : null}
        ${readOnly
          ? null
          : html`<div class="source-documents-upload">
              <label class=${`btn small${busy ? ' disabled' : ''}`}>
                Upload documents
                <input type="file" multiple accept=${SOURCE_FILE_ACCEPT} aria-label="Upload Source documents" data-testid="source-documents-input" style="display:none" disabled=${busy} onChange=${onPick} />
              </label>
              ${replacesPicker()}
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
                      ${marks(entry)}
                    </td>
                    <td class="source-documents-file">${entry.filename}</td>
                    <td>${formatBytes(entry.size)}</td>
                    <td>${formatWhen(entry.uploadedAt)}${entry.uploadedBy ? html`<br /><span class="muted">${entry.uploadedBy}</span>` : null}</td>
                    <td>
                      ${entry.text
                        ? html`<span class="stamp agreed" title="The text read from this document is kept with it">TEXT READ</span>`
                        : html`<span class="stamp review" title="No text was kept: the AI looks at the original">NO TEXT</span>`}
                      ${entry.readVisually ? html` <span class="stamp review" data-testid="source-visual-stamp" title="An AI Provider that takes PDFs is sent the PDF itself">READ VISUALLY</span>` : null}
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
                            <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => copyCitation(entry)} title="Copy a citation of this document to paste into a field">Copy citation</button>
                            ${readOnly || !canUseSourceAsImage(entry.filename) || !store.useAsImage
                              ? null
                              : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => useAsImage(entry)} title="Copy this picture into the Instance's images">Use as image</button>`}
                            ${readOnly
                              ? null
                              : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => setRenaming({ id: entry.id, title: entry.title })}>Rename</button>
                                  <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => extractAgain(entry)}>Extract text again</button>
                                  ${sourceFileKind(entry.filename) === 'pdf' && store.setReadVisually
                                    ? html`<button type="button" class="btn small ghost" disabled=${busy} data-testid="source-read-visually" aria-pressed=${entry.readVisually === true} onClick=${() => toggleReadVisually(entry)} title="Send the PDF itself to an AI Provider that takes PDFs, instead of its text. Suits diagrams and layouts.">${entry.readVisually ? 'Read as text' : 'Read visually'}</button>`
                                    : null}
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
                    ${marks(entry)}
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
