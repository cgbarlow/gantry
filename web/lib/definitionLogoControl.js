// #222 (docs/adr/0059): the Definitions page's **Logo** control — the picture in the page header of
// a Definition's reference documents, shown once for the whole Definition with Download and (on a
// draft) Replace. Shared by the server-hosted editor (web/pages/definition-viewer.js, over
// `/api/definitions/:id/versions/:n/logo`) and a Local Workspace's Definition editor
// (web/pages/local-definition-editor.js, over web/lib/localDefinitionFiles.js), which hand it their
// own I/O:
//
//   load()          → { image: Blob | null, extension, documents: [{ name, hasLogo }] }
//   replace(bytes)  → { updated: [name], withoutLogo: [name] }, throwing an Error to show
//
// `reloadKey` changes whenever what it reads may have changed underneath it (another version, or a
// reference document replaced under **Reference docx**).
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'

function listNames(names) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function DefinitionLogoControl({ editable, load, replace, reloadKey }) {
  const [state, setState] = useState({ loading: true }) // { loading, error, image, extension, documents }
  const [imageUrl, setImageUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true }))
    load()
      .then((result) => { if (!cancelled) setState({ loading: false, ...result }) })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message, documents: [] }) })
    return () => { cancelled = true }
    // eslint-disable-next-line
  }, [reloadKey, generation])

  useEffect(() => {
    if (!state.image) { setImageUrl(null); return }
    const url = URL.createObjectURL(state.image)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [state.image])

  function download() {
    if (!imageUrl) return
    const link = document.createElement('a')
    link.href = imageUrl
    link.download = `logo.${state.extension ?? 'png'}`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function onFile(e) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const result = await replace(new Uint8Array(await file.arrayBuffer()))
      setMessage(result.updated.length
        ? `Logo replaced in ${result.updated.length} reference document${result.updated.length === 1 ? '' : 's'}.`
        : 'No reference document has a logo in its header, so nothing was changed.')
      setGeneration((n) => n + 1)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const documents = state.documents ?? []
  const withoutLogo = documents.filter((d) => !d.hasLogo).map((d) => d.name)
  return html`
    <section class="defn-logo" aria-label="Logo">
      <div class="defn-logo-row">
        <span class="kicker">Logo</span>
        ${state.loading && !imageUrl ? html`<span class="muted">Loading…</span>` : null}
        ${imageUrl ? html`<img class="defn-logo-preview" src=${imageUrl} alt="Current logo" />` : null}
        ${!state.loading && !imageUrl && !state.error
          ? html`<span class="muted defn-logo-none">${documents.length ? 'No reference document has a logo in its page header.' : 'This definition has no reference documents.'}</span>`
          : null}
        <button type="button" class="btn small ghost" disabled=${!imageUrl} onClick=${download}>Download</button>
        ${editable
          ? html`
              <label class=${'btn small' + (busy || !documents.length ? ' disabled' : '')}>
                ${busy ? 'Replacing…' : 'Replace'}
                <input type="file" accept="image/png,image/jpeg" aria-label="Replace logo" style="display:none" disabled=${busy || !documents.length} onChange=${onFile} />
              </label>
            `
          : null}
      </div>
      <p class="muted defn-hint">
        The picture in the page header of every Artefact's reference document. ${editable
          ? 'Replace writes a PNG or JPEG into all of them at once, keeping its proportions in the same space. A reference document you upload later keeps its own logo.'
          : 'It can be replaced on a draft.'}
      </p>
      ${withoutLogo.length && imageUrl
        ? html`<p class="muted defn-hint defn-logo-without">${listNames(withoutLogo)} ${withoutLogo.length === 1 ? 'has' : 'have'} no logo in ${withoutLogo.length === 1 ? 'its' : 'their'} header and ${withoutLogo.length === 1 ? 'is' : 'are'} left as ${withoutLogo.length === 1 ? 'it is' : 'they are'}.</p>`
        : null}
      ${message ? html`<p class="save-status defn-logo-status">${message}</p>` : null}
      ${error || state.error ? html`<p class="inline-error defn-logo-status">${error ?? state.error}</p>` : null}
    </section>
  `
}
