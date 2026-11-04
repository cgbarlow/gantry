// #279 (map #238, decided in #245): the **Source documents** panel in the Instance editor. An architect can upload evidence (a brief, requirements, meeting notes, a spreadsheet, a screenshot) to an Instance, rename it, read its text again, download it and remove it, before connecting any AI Provider. Every rule about the list lives in web/lib/sourceDocuments.js; the text is read out of each document here, in the browser (web/lib/sourceExtract.js); this file draws the panel and runs the steps in order.
//
// The panel is given a `store` with the methods web/lib/sourceDocuments.js's createSourceStore has (`list`, `upload`, `rename`, `remove`, `setText`, `readOriginal`, `fetchAgain`): a Local Workspace's own folder (web/lib/localSourceDocuments.js) or the server's routes (web/lib/serverSourceDocuments.js).
//
// #319 (docs/adr/0072): a **code repository** can be added too, as a pointer: a Provider repository and branch, optionally narrowed to
// folders, read live by the AI. The Gantry server checks that the architect can read it with their own token (web/lib/sourceRepositoryClient.js)
// and the store keeps only the manifest entry. Its row opens the repository on its Provider instead of downloading anything, and
// **Download all** adds a short links file naming each repository, its branch and the commits cited, never its code.
//
// #318 (docs/adr/0071): a document can also be added from a web address. The Gantry server fetches it (web/lib/sourceAddress.js), the text is read here exactly as for an upload, and it is stored through the same `store` with its **origin**. **Fetch again** asks the store to add the page again only when its bytes changed.
import { html } from 'htm/preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  MAX_SOURCE_BYTES,
  SOURCE_FILE_ACCEPT,
  formatBytes,
  canUseSourceAsImage,
  fetchAgainRefusal,
  isFetchedSource,
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
import { storedZip } from './storedZip.js'
import { SOURCE_FETCH_NEEDS_SERVER, fetchSourceAddress, originOf, sourceFetchStatus } from './sourceAddress.js'
import {
  REPOSITORY_LINKS_FILENAME,
  REPOSITORY_PROVIDERS,
  isRepositorySource,
  repositoryLinksText,
  repositoryLocationFields,
  repositoryName,
  repositoryProviderLabel,
  repositoryWebAddress,
  shortCommit,
} from './sourceRepository.js'
import { callRepository, rememberRepositoryToken } from './sourceRepositoryClient.js'

// #318: how the panel asks the Gantry server whether it fetches web addresses, and has it fetch one. Tests pass their own.
const SERVER_SOURCE_FETCH = { status: () => sourceFetchStatus(), fetch: (address) => fetchSourceAddress(address) }

// #319: how the panel asks the Gantry server whether the architect can read a repository (with their own token, or none), and keeps that token.
const SERVER_REPOSITORY_ACCESS = { check: (repository, token) => callRepository('check', repository, {}, { token }), remember: rememberRepositoryToken }

const EMPTY_REPOSITORY_FORM = { provider: 'github', location: {}, branch: '', folders: '', token: '' }

/** #319: opens a code repository on its Provider, at its branch, or a file of it at a commit (`at` is `{ path, commit }`). */
export function openRepository(entry, at = {}) {
  const address = repositoryWebAddress(entry.repository, at)
  if (address) window.open(address, '_blank', 'noopener')
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
  if (isRepositorySource(entry)) {
    openRepository(entry)
    return
  }
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
 * `store` is described above. `actor` is the name stamped on uploads and removals ('' when unknown). `readOnly` hides every control that changes the list (an archived Instance). `commitNote` is shown under the introduction when each change is committed to a repository as it is made (an Azure DevOps or GitHub workspace, #280). `extract(filename, bytes)` is the text reader; tests and the app use the default. `archiveName` is the file **Download all** saves (#310). `compact` draws the list as the Interview page's narrow rail does (#286): titles, a "+ Add Source document" button and a drop zone, with no table; `onList(list)` is told whenever the list has been read (after a load or a change). `sourceFetch` (#318) is `{ status(), fetch(address) }`, the Gantry server's by default: adding by address is offered only when `status()` says the server has it on. `repositoryAccess` (#319) is `{ check(repository, token), remember(repository, token) }`, the Gantry server's and the browser's credential store by default; `citedCommits(id)` lists the commits the Instance's content cites a repository at, for the links file **Download all** adds.
 */
export function SourceDocumentsPanel({ store, actor = '', readOnly = false, commitNote = '', extract = extractSourceText, onList = null, compact = false, newSince = null, archiveName = 'Source documents.zip', sourceFetch = SERVER_SOURCE_FETCH, repositoryAccess = SERVER_REPOSITORY_ACCESS, citedCommits = () => [] }) {
  const [list, setList] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(null)
  // #297: the older document the next upload replaces ('' for none).
  const [replaces, setReplaces] = useState('')
  // #318: whether the Gantry server fetches web addresses (null while asking), and the address being typed.
  const [fetchStatus, setFetchStatus] = useState(null)
  const [address, setAddress] = useState('')
  // #319: the "Add a code repository" form, null while it is closed.
  const [repoForm, setRepoForm] = useState(null)

  useEffect(() => {
    let current = true
    Promise.resolve(sourceFetch?.status?.() ?? { enabled: false })
      .then((status) => current && setFetchStatus(status))
      .catch(() => current && setFetchStatus({ enabled: false, unreachable: true }))
    return () => {
      current = false
    }
  }, [sourceFetch])

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

  // #318: the Gantry server fetches the address; the text is read here, as for an upload, and the document is stored with its origin.
  const addFromAddress = (given) =>
    run(async () => {
      const wanted = given.trim()
      if (!wanted) return
      setMessage({ kind: 'info', text: `Fetching ${wanted}…` })
      const fetched = await sourceFetch.fetch(wanted)
      setMessage({ kind: 'info', text: `Reading ${fetched.title}…` })
      const extraction = await extract(fetched.filename, fetched.bytes)
      const older = replaces ? entries.find((e) => e.id === replaces) : null
      const { entry } = await store.upload({
        filename: fetched.filename,
        bytes: fetched.bytes,
        text: extraction.text ?? undefined,
        title: fetched.title,
        uploadedBy: actor,
        origin: originOf(fetched),
        ...(replaces ? { replaces } : {}),
      })
      setAddress('')
      setReplaces('')
      await reload()
      const replacing = older ? ` It replaces "${older.title}", which stays in the list and can still be cited.` : ''
      setMessage(
        extraction.text !== null
          ? { kind: 'ok', text: `Added "${entry.title}" from ${fetched.finalAddress} and read its text.${replacing}` }
          : { kind: extraction.problem ? 'warn' : 'ok', text: `Added "${entry.title}" from ${fetched.finalAddress}. ${noTextNote(extraction)}${replacing}` }
      )
    })

  // #319: the Gantry server checks the architect can read the repository with the token they gave (none for a public one) and finds its
  // branch; only then is the pointer kept, and the token with it. Nothing from the repository is stored.
  const addRepository = (form) =>
    run(async () => {
      const location = Object.fromEntries(Object.entries(form.location).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v))
      const wanted = { provider: form.provider, location, ...(form.branch.trim() ? { branch: form.branch.trim() } : {}) }
      const missing = repositoryLocationFields(form.provider).filter((f) => !f.optional && !location[f.key])
      if (missing.length) throw new Error(`Give the repository's ${missing.map((f) => f.label.toLowerCase()).join(' and ')}.`)
      setMessage({ kind: 'info', text: `Checking you can read ${repositoryName(wanted)}…` })
      const token = form.token.trim() || null
      const checked = await repositoryAccess.check(wanted, token)
      const folders = form.folders.split(',').map((f) => f.trim()).filter(Boolean)
      const repository = { ...wanted, branch: checked.branch, ...(folders.length ? { folders } : {}) }
      const { entry } = await store.addRepository({ repository, uploadedBy: actor })
      repositoryAccess.remember?.(repository, token ?? '')
      setRepoForm(null)
      await reload()
      setMessage({
        kind: 'ok',
        text: `Added "${entry.title}", the ${checked.branch} branch of ${repositoryName(repository)}${folders.length ? ` (${folders.join(', ')})` : ''}. Nothing from it is kept here: the AI reads it live, and each read records the commit it saw (now ${shortCommit(checked.commit)}).`,
      })
    })

  // #318: **Fetch again**, only ever when the architect asks. Identical bytes add nothing; changed ones are added as a new document that replaces this one, which flags the Fields that drew on it Out of date.
  const fetchAgain = (entry) =>
    run(async () => {
      setMessage({ kind: 'info', text: `Fetching ${entry.origin.address} again…` })
      const fetched = await sourceFetch.fetch(entry.origin.address)
      const result = await store.fetchAgain(
        entry.id,
        { filename: fetched.filename, bytes: fetched.bytes, uploadedBy: actor, origin: originOf(fetched) },
        { extract: async () => (await extract(fetched.filename, fetched.bytes)).text ?? undefined }
      )
      if (result.unchanged) {
        setMessage({ kind: 'ok', text: `"${entry.title}" is unchanged since ${formatWhen(entry.origin.fetchedAt)}. Nothing was added.` })
        return
      }
      await reload()
      setMessage({
        kind: 'ok',
        text: `"${entry.title}" has changed since ${formatWhen(entry.origin.fetchedAt)}. The new copy is added and replaces the old one, which stays in the list and can still be cited. Fields that drew on it are flagged Out of date.`,
      })
    })

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
      // #319: a repository is opened on its Provider at its branch: there is nothing of it here to download.
      if (isRepositorySource(entry)) {
        openRepository(entry)
        return
      }
      const { bytes } = await store.readOriginal(entry.id)
      if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
      download(bytes, entry.filename)
    })

  // #310: every live document in one zip (the originals, not their text), so a set of evidence, such as the bundled example's pack, can be taken to another Instance and uploaded there.
  const downloadAll = () =>
    run(async () => {
      const files = []
      for (const entry of live) {
        if (isRepositorySource(entry)) continue
        const { bytes } = await store.readOriginal(entry.id)
        if (!bytes) throw new Error(`The file for "${entry.title}" is missing from this Instance's sources folder.`)
        files.push({ name: entry.filename, bytes })
      }
      // #319: the repositories go in as one short text file of their addresses, branches and the commits cited, never their code.
      const links = repositoryLinksText(live, citedCommits)
      const repositories = live.filter(isRepositorySource).length
      if (links) files.push({ name: REPOSITORY_LINKS_FILENAME, bytes: new TextEncoder().encode(links) })
      download(storedZip(files), archiveName)
      const documents = files.length - (links ? 1 : 0)
      const linked = repositories ? ` and the links to ${repositories} code ${repositories === 1 ? 'repository' : 'repositories'} in ${REPOSITORY_LINKS_FILENAME}` : ''
      setMessage({ kind: 'ok', text: `Saved ${documents} ${documents === 1 ? 'document' : 'documents'}${linked} in ${archiveName}. Upload them to another Instance to start it with the same evidence.` })
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
      setMessage({
        kind: 'ok',
        text: isRepositorySource(entry) ? `Removed "${entry.title}". The repository itself is untouched; its name stays in the list.` : `Removed "${entry.title}". Its file and text are deleted; its name stays in the list.`,
      })
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
  // #318: adding by address is offered once the Gantry server says it fetches; a Local Workspace whose server can't be reached says why it isn't.
  const offersAddress = !readOnly && fetchStatus?.enabled === true
  const canFetchAgain = (entry) => offersAddress && Boolean(store.fetchAgain) && !fetchAgainRefusal(entry, replacedByEntry)
  const addressForm = () =>
    offersAddress
      ? html`<form
          class="source-documents-address"
          data-testid="source-address-form"
          onSubmit=${(e) => {
            e.preventDefault()
            addFromAddress(address)
          }}
        >
          <input
            type="url"
            inputmode="url"
            placeholder="https://… a web page or document"
            aria-label="Web address of a Source document"
            data-testid="source-address-input"
            value=${address}
            disabled=${busy}
            onInput=${(e) => setAddress(e.currentTarget.value)}
          />
          <button type="submit" class="btn small" disabled=${busy || !address.trim()} data-testid="source-address-add">Add from address</button>
        </form>`
      : !readOnly && fetchStatus?.unreachable
        ? html`<p class="muted source-documents-address-note" data-testid="source-address-unreachable">${SOURCE_FETCH_NEEDS_SERVER}</p>`
        : null
  // #319: adding a code repository is offered wherever the store can keep a pointer and the list can be changed.
  const offersRepository = !readOnly && Boolean(store.addRepository)
  const setLocation = (key, value) => setRepoForm((form) => ({ ...form, location: { ...form.location, [key]: value } }))
  const repositoryForm = () => {
    if (!offersRepository) return null
    if (repoForm === null) {
      return html`<button type="button" class="btn small ghost source-documents-add-repository" data-testid="source-repository-open" disabled=${busy} onClick=${() => setRepoForm({ ...EMPTY_REPOSITORY_FORM })}>+ Add a code repository</button>`
    }
    return html`<form
      class="source-documents-repository"
      data-testid="source-repository-form"
      onSubmit=${(e) => {
        e.preventDefault()
        addRepository(repoForm)
      }}
    >
      <p class="guidance">A pointer to a repository and branch the AI reads live, not a copy: nothing from it is kept with the Instance. Give a token only for a private repository; it is kept in this browser, as a workspace's is.</p>
      <label>Provider
        <select data-testid="source-repository-provider" value=${repoForm.provider} disabled=${busy} onChange=${(e) => setRepoForm({ ...repoForm, provider: e.currentTarget.value, location: {} })}>
          ${REPOSITORY_PROVIDERS.map((p) => html`<option key=${p.id} value=${p.id} selected=${repoForm.provider === p.id}>${p.label}</option>`)}
        </select>
      </label>
      ${repositoryLocationFields(repoForm.provider).map(
        (f) => html`<label key=${f.key}>${f.label}${f.optional ? ' (optional)' : ''}
          <input type="text" data-testid=${`source-repository-${f.key}`} value=${repoForm.location[f.key] ?? ''} disabled=${busy} onInput=${(e) => setLocation(f.key, e.currentTarget.value)} />
        </label>`
      )}
      <label>Branch
        <input type="text" data-testid="source-repository-branch" placeholder="its default branch" value=${repoForm.branch} disabled=${busy} onInput=${(e) => setRepoForm({ ...repoForm, branch: e.currentTarget.value })} />
      </label>
      <label>Folders (optional)
        <input type="text" data-testid="source-repository-folders" placeholder="e.g. services/orders, infra" value=${repoForm.folders} disabled=${busy} onInput=${(e) => setRepoForm({ ...repoForm, folders: e.currentTarget.value })} />
      </label>
      <label>Token (only for a private repository)
        <input type="password" autocomplete="off" data-testid="source-repository-token" value=${repoForm.token} disabled=${busy} onInput=${(e) => setRepoForm({ ...repoForm, token: e.currentTarget.value })} />
      </label>
      <div class="source-documents-repository-actions">
        <button type="submit" class="btn small primary" disabled=${busy} data-testid="source-repository-add">Add repository</button>
        <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => setRepoForm(null)}>Cancel</button>
      </div>
    </form>`
  }
  const repositoryLink = (entry) =>
    html`<a class="source-documents-origin" data-testid="source-repository-link" href=${repositoryWebAddress(entry.repository)} target="_blank" rel="noopener noreferrer" title=${`${repositoryProviderLabel(entry.repository.provider)}, read live`}>${repositoryName(entry.repository)}</a>`
  const repositoryWhere = (entry) => `${entry.repository.branch} branch${entry.repository.folders ? ` · ${entry.repository.folders.join(', ')}` : ''}`

  const originLink = (entry) =>
    html`<a class="source-documents-origin" data-testid="source-origin" href=${entry.origin.address} target="_blank" rel="noopener noreferrer" title=${`Fetched ${formatWhen(entry.origin.fetchedAt)} from ${entry.origin.finalAddress}`}>${entry.origin.address}</a>`
  const replacesPicker = () =>
    live.length > 0 && !readOnly
      ? html`<select class="source-replaces" data-testid="source-replaces" aria-label="This replaces…" value=${replaces} disabled=${busy} onChange=${(e) => setReplaces(e.currentTarget.value)}>
          <option value="" selected=${replaces === ''}>This replaces… (nothing)</option>
          ${live.filter((e) => !isRepositorySource(e)).map((e) => html`<option key=${e.id} value=${e.id} selected=${replaces === e.id}>This replaces… ${e.title}</option>`)}
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
                  <span class="srcdoc-title" title=${isRepositorySource(entry) ? repositoryWebAddress(entry.repository) : isFetchedSource(entry) ? `${entry.origin.address}, fetched ${formatWhen(entry.origin.fetchedAt)}` : entry.filename}>${entry.title}</span>
                  <span class="meta">${isRepositorySource(entry) ? `code repository · ${repositoryWhere(entry)}` : `${formatBytes(entry.size)}${entry.text ? '' : ' · no text'}`}</span>
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
        ${addressForm()}
        ${repositoryForm()}
        <p class=${`source-documents-message ${message ? message.kind : ''}`} role="status" aria-live="polite" data-testid="source-documents-message">${message ? message.text : ''}</p>
      </div>
    `
  }

  return html`
    <details class="source-documents" data-testid="source-documents">
      <summary data-testid="source-documents-summary">Source documents${list ? html` <span class="source-documents-count">(${live.length})</span>` : null}</summary>
      <div class="source-documents-body">
        <p class="guidance source-documents-intro">
          Evidence this Instance's content is drawn from: briefs, requirements, meeting notes, spreadsheets, screenshots. They are kept with the Instance, separate from its images, and Gantry reads the text out of each one when you add it. Word, PowerPoint, spreadsheets, PDFs, Markdown, text and images, up to ${formatBytes(MAX_SOURCE_BYTES)} each${offersAddress ? ', or a web page or document from its address: the Gantry server fetches a copy and keeps where it came from' : ''}${offersRepository ? '. A code repository is added as a pointer the AI reads live, never a copy' : ''}.
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
        ${addressForm()}
        ${repositoryForm()}
        ${live.length > 0
          ? html`<div class="source-documents-pack"><button type="button" class="btn small ghost" disabled=${busy} data-testid="source-documents-download-all" onClick=${downloadAll} title="Save every document, as uploaded, in one zip">Download all (.zip)</button></div>`
          : null}
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
                    <td class="source-documents-file">${isRepositorySource(entry) ? html`${repositoryLink(entry)}<br /><span class="muted">${repositoryWhere(entry)}</span>` : entry.filename}${isFetchedSource(entry) ? html`<br />${originLink(entry)}` : null}</td>
                    <td>${isRepositorySource(entry) ? '' : formatBytes(entry.size)}</td>
                    <td>${isFetchedSource(entry) ? `fetched ${formatWhen(entry.origin.fetchedAt)}` : formatWhen(entry.uploadedAt)}${entry.uploadedBy ? html`<br /><span class="muted">${entry.uploadedBy}</span>` : null}</td>
                    <td>
                      ${isRepositorySource(entry)
                        ? html`<span class="stamp agreed" data-testid="source-repository-stamp" title="Nothing from the repository is kept: the AI reads it live, and each read records the commit it saw">READ LIVE</span>`
                        : entry.text
                        ? html`<span class="stamp agreed" title="The text read from this document is kept with it">TEXT READ</span>`
                        : html`<span class="stamp review" title="No text was kept: the AI looks at the original">NO TEXT</span>`}
                      ${entry.readVisually ? html` <span class="stamp review" data-testid="source-visual-stamp" title="An AI Provider that takes PDFs is sent the PDF itself">READ VISUALLY</span>` : null}
                    </td>
                    <td>
                      ${confirmRemove === entry.id
                        ? html`<div class="source-documents-actions source-documents-confirm" role="group" aria-label=${`Remove ${entry.title}`}>
                            <span>Remove "${entry.title}"? ${isRepositorySource(entry) ? 'Only the pointer goes: the repository itself is untouched.' : 'Its file and text are deleted.'}</span>
                            <button type="button" class="btn small primary" disabled=${busy} onClick=${() => removeConfirmed(entry)} data-testid="source-documents-confirm-remove">Remove</button>
                            <button type="button" class="btn small ghost" onClick=${() => setConfirmRemove(null)}>Cancel</button>
                          </div>`
                        : html`<div class="source-documents-actions">
                            <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => downloadOriginal(entry)} title=${isRepositorySource(entry) ? `Open ${repositoryName(entry.repository)} at its ${entry.repository.branch} branch on ${repositoryProviderLabel(entry.repository.provider)}` : undefined}>Download</button>
                            <button type="button" class="btn small ghost" disabled=${busy} onClick=${() => copyCitation(entry)} title="Copy a citation of this document to paste into a field">Copy citation</button>
                            ${readOnly || !canUseSourceAsImage(entry.filename) || !store.useAsImage
                              ? null
                              : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => useAsImage(entry)} title="Copy this picture into the Instance's images">Use as image</button>`}
                            ${readOnly
                              ? null
                              : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => setRenaming({ id: entry.id, title: entry.title })}>Rename</button>
                                  ${isRepositorySource(entry) ? null : html`<button type="button" class="btn small ghost" disabled=${busy} onClick=${() => extractAgain(entry)}>Extract text again</button>`}
                                  ${canFetchAgain(entry)
                                    ? html`<button type="button" class="btn small ghost" disabled=${busy} data-testid="source-fetch-again" onClick=${() => fetchAgain(entry)} title=${`Fetch ${entry.origin.address} again. A changed page is added as a new document that replaces this one; an unchanged one adds nothing.`}>Fetch again</button>`
                                    : null}
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
