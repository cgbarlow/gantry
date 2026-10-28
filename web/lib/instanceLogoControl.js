// #224 (docs/adr/0058 amendment for #224): the two Preact pieces an Instance's own **Logo** is drawn
// with, under the Instance settings heading (web/lib/instanceLogo.js describes the setting).
//
// - `InstanceLogoPicker` — the "+ New Workspace" wizard's optional upload, with a preview and the note
//   that the logo is for this instance only. It holds the picked image; the wizard stores it with the
//   new instance.
// - `InstanceLogoControl` — Instance Settings' control: the logo the instance's documents show, whether
//   it is the instance's own or the Definition's, with Download, Replace and Remove. Shared by the
//   server-hosted screen (over `/api/instance/logo`) and a Local Workspace's (over its own folder),
//   which hand it their own I/O, as web/lib/definitionLogoControl.js's two editors do:
//
//     load()          → { image: Blob, extension, source: 'instance' | 'definition' }
//     replace(bytes)  → resolves once stored, throwing an Error to show
//     remove()        → resolves once removed
import { html } from 'htm/preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { logoImageInfo, logoImageProblem } from './definitionLogo.js'
import { INSTANCE_LOGO_SETTING, INSTANCE_LOGO_NOTE_BEFORE_LINK, INSTANCE_LOGO_NOTE_LINK } from './instanceLogo.js'

function useObjectUrl(blob) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!blob) { setUrl(null); return }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

function downloadUrl(url, filename) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/**
 * The wizard's Logo upload. `value` is the picked image (`{ bytes, contentType, extension }`) or
 * `null`; `onChange` receives the next one (`null` to clear). A file that isn't a PNG or JPEG is
 * refused on the spot, as Instance creation would refuse it. `definitionsHref` links the note's
 * "Definitions page" to where the Definition's own logo is changed, when the app has such a page.
 */
export function InstanceLogoPicker({ value, onChange, definitionsHref }) {
  const [error, setError] = useState(null)
  const previewUrl = useObjectUrl(useMemo(() => (value ? new Blob([value.bytes], { type: value.contentType }) : null), [value]))

  async function onFile(e) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const problem = logoImageProblem(bytes)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    const { contentType, extension } = logoImageInfo(bytes)
    onChange({ bytes, contentType, extension })
  }

  return html`
    <div class="instance-setting instance-logo-picker" data-setting=${INSTANCE_LOGO_SETTING.id}>
      <label class="wizard-label">${INSTANCE_LOGO_SETTING.label} <span class="muted">(optional)</span></label>
      <div class="instance-logo-row">
        ${previewUrl
          ? html`<img class="instance-logo-preview" src=${previewUrl} alt="Chosen logo" />`
          : html`<span class="muted instance-logo-none">The Definition's logo</span>`}
        <label class="btn small">
          ${value ? 'Choose another' : 'Choose a logo'}
          <input type="file" accept="image/png,image/jpeg" aria-label="Instance logo" style="display:none" onChange=${onFile} />
        </label>
        ${value ? html`<button type="button" class="btn small ghost" onClick=${() => onChange(null)}>Use the Definition's logo</button>` : null}
      </div>
      <p class="guidance instance-logo-note">
        ${INSTANCE_LOGO_NOTE_BEFORE_LINK}${definitionsHref
          ? html`<a href=${definitionsHref} target="_blank" rel="noopener">${INSTANCE_LOGO_NOTE_LINK}</a>`
          : INSTANCE_LOGO_NOTE_LINK}.
      </p>
      ${error ? html`<p class="inline-error instance-logo-status">${error}</p>` : null}
    </div>
  `
}

/** Instance Settings' Logo control (see the module comment for `load`, `replace` and `remove`). */
export function InstanceLogoControl({ disabled = false, load, replace, remove, reloadKey }) {
  const [state, setState] = useState({ loading: true }) // { loading, error, image, extension, source }
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [generation, setGeneration] = useState(0)
  const imageUrl = useObjectUrl(state.image ?? null)

  useEffect(() => {
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true }))
    load()
      .then((result) => { if (!cancelled) setState({ loading: false, ...result }) })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message }) })
    return () => { cancelled = true }
    // eslint-disable-next-line
  }, [reloadKey, generation])

  async function run(action, done) {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      await action()
      setMessage(done)
      setGeneration((n) => n + 1)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function onFile(e) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const problem = logoImageProblem(bytes)
    if (problem) {
      setMessage(null)
      setError(problem)
      return
    }
    await run(() => replace(bytes), 'Logo replaced. Documents rendered from now on show it.')
  }

  const own = state.source === 'instance'
  return html`
    <div class="instance-setting instance-logo" data-setting=${INSTANCE_LOGO_SETTING.id} aria-label="Logo" role="group">
      <h3>${INSTANCE_LOGO_SETTING.label}</h3>
      <p class="guidance">${INSTANCE_LOGO_SETTING.guidance}</p>
      <div class="instance-logo-row">
        ${state.loading && !imageUrl ? html`<span class="muted">Loading…</span>` : null}
        ${imageUrl ? html`<img class="instance-logo-preview" src=${imageUrl} alt="Current logo" />` : null}
        ${!state.loading && !state.error
          ? html`<span class="muted instance-logo-source">${own ? "This instance's own logo" : "The Definition's logo"}</span>`
          : null}
      </div>
      <div class="workspace-field-row">
        <button type="button" class="btn small ghost" disabled=${!imageUrl} onClick=${() => downloadUrl(imageUrl, `logo.${state.extension ?? 'png'}`)}>Download</button>
        <label class=${'btn small' + (busy || disabled ? ' disabled' : '')}>
          ${busy ? 'Saving…' : 'Replace'}
          <input type="file" accept="image/png,image/jpeg" aria-label="Replace instance logo" style="display:none" disabled=${busy || disabled} onChange=${onFile} />
        </label>
        <button
          type="button"
          class="btn small ghost"
          disabled=${busy || disabled || !own}
          title=${own ? '' : "This instance already uses the Definition's logo"}
          onClick=${() => run(remove, "Logo removed. Documents show the Definition's logo again.")}
        >
          Remove
        </button>
      </div>
      ${message ? html`<p class="save-status instance-logo-status">${message}</p>` : null}
      ${error || state.error ? html`<p class="inline-error instance-logo-status">${error ?? state.error}</p>` : null}
    </div>
  `
}
