// #362: "Move to v<N>" in Instance Settings — the row under the Version row and the dialog that shows what the move changes, shared by
// the server-hosted and Local-workspace Instance Settings screens (web/pages/settings.js), plus a Local workspace's own reading and
// writing of its folder. What changes and the files a move writes are web/lib/definitionVersionMove.js's, the same the server uses
// for a server or Provider workspace (`GET`/`POST /api/instance/definition-move`, lib/server.js), so every workspace kind shows the
// same dialog and makes the same move.
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { renderMarkdown } from './markdown.js'
import { readTextFile, writeTextFile, removeFile } from './localWorkspace.js'
import { listLocalDefinitions, readLocalDefinitionStructure, resolveDefinitionStructure } from './localDefinitionFiles.js'
import {
  changelogSection,
  definitionMoveEntry,
  definitionMoveTarget,
  definitionMoveView,
  definitionMoveWrites,
  planDefinitionMove,
  removedFieldModuleIds,
  writeAllOrRestore,
} from './definitionVersionMove.js'

const fieldName = (f) => html`<strong>${f.fieldTitle}</strong> <span class="definition-move-module">(${f.moduleTitle})</span>`
const stageNames = (stages) => stages.map((s) => s.title).join(', ')

/**
 * The dialog: what moving to v<N> removes, what it adds or now requires, what changed type, and the Definition's CHANGELOG section for
 * v<N>. `move` is `definitionMoveView`'s shape; `where` says how the move lands on this workspace ("one commit on the current Stage's
 * branch", ...). `onConfirm` makes the move and throws to say why it failed; the dialog then stays open with the reason.
 */
function DefinitionMoveDialog({ move, where, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div class="modal definition-move-dialog" role="dialog" aria-modal="true" aria-label=${`Move to v${move.to}`}>
        <h3>Move to v${move.to}</h3>
        <p class="guidance">
          This Instance is on ${move.definition} v${move.from}. Moving it to v${move.to} is one change, ${where}, recorded in the current
          Stage's decisions log. There is no moving back.
        </p>
        <section data-testid="definition-move-removed">
          <h4>Removed</h4>
          ${move.removed.length
            ? html`<p class="guidance">v${move.to} no longer has these Fields. Their content is removed from the Module files on the move.</p>
                <ul>${move.removed.map((f) => html`<li key=${`${f.moduleId}.${f.fieldId}`}>${fieldName(f)}</li>`)}</ul>`
            : html`<p class="guidance">Nothing: no Field v${move.to} drops has content in this Instance.</p>`}
        </section>
        ${move.added.length || move.newlyRequired.length
          ? html`<section data-testid="definition-move-added">
              <h4>New or now required</h4>
              <p class="guidance">Shown so you know what the next Gate will ask for. The move adds no content.</p>
              <ul>
                ${move.added.map(
                  (f) => html`<li key=${`added:${f.moduleId}.${f.fieldId}`}>${fieldName(f)}: new in v${move.to}${f.requiredAt.length ? `, required at ${stageNames(f.requiredAt)}` : ''}</li>`
                )}
                ${move.newlyRequired.map((f) => html`<li key=${`required:${f.moduleId}.${f.fieldId}`}>${fieldName(f)}: now required at ${stageNames(f.stages)}</li>`)}
              </ul>
            </section>`
          : null}
        ${move.typeChanged.length
          ? html`<section data-testid="definition-move-type-changed">
              <h4>Changed type</h4>
              <ul>
                ${move.typeChanged.map(
                  (f) => html`<li key=${`type:${f.moduleId}.${f.fieldId}`}>${fieldName(f)}: ${f.fromType} to ${f.toType}. Gantry leaves this as it is; check it after the move.</li>`
                )}
              </ul>
            </section>`
          : null}
        ${move.changelog
          ? html`<details class="definition-move-changelog">
              <summary>What changed in v${move.to}</summary>
              <div class="wizard-changelog" dangerouslySetInnerHTML=${{ __html: renderMarkdown(move.changelog) }} />
            </details>`
          : null}
        ${error ? html`<p class="inline-error" role="alert">${error}</p>` : null}
        <div class="modal-actions">
          <button type="button" class="btn" disabled=${busy} onClick=${onClose}>Cancel</button>
          <button type="button" class="btn primary" disabled=${busy} onClick=${confirm}>${busy ? 'Moving…' : `Move to v${move.to}`}</button>
        </div>
      </div>
    </div>
  `
}

/**
 * The row under the Version row when the Instance's Definition has a newer published version: "v<N> is available" and **Move to
 * v<N>…**, or the sentence saying why the move must wait. Nothing when `move` is null or not available, so the Version row reads as
 * it always has. `onMove` makes the move (throwing to say why it failed); `status` is what the screen says after one.
 */
export function DefinitionMoveRow({ move, where, disabled = false, onMove, status = '' }) {
  const [open, setOpen] = useState(false)
  if (!move?.available) return status ? html`<div class="workspace-field-status" data-testid="definition-move-status">${status}</div>` : null
  return html`
    <div class="result-row definition-move-row" data-testid="definition-move">
      <span class="k"></span>
      <span class="v">
        v${move.to} is available
        <button type="button" class="btn small" disabled=${disabled || Boolean(move.blocked)} onClick=${() => setOpen(true)}>Move to v${move.to}…</button>
      </span>
    </div>
    ${move.blocked ? html`<p class="guidance definition-move-blocked" data-testid="definition-move-blocked">${move.blocked}</p>` : null}
    ${status ? html`<div class="workspace-field-status" data-testid="definition-move-status">${status}</div>` : null}
    ${open
      ? html`<${DefinitionMoveDialog}
          move=${move}
          where=${where}
          onClose=${() => setOpen(false)}
          onConfirm=${async () => {
            await onMove(move)
            setOpen(false)
          }}
        />`
      : null}
  `
}

// ---------- a Local workspace ----------

const readOrNull = (handle, path) => readTextFile(handle, path).catch((err) => (err?.name === 'NotFoundError' || err?.name === 'TypeMismatchError' ? null : Promise.reject(err)))

// The latest published version of `definitionId` as this workspace resolves it: its own definitions/ folder when the Definition is
// there (ids are unique across homes, ADR-0036), else the Gantry server's library.
async function latestPublishedVersion(handle, definitionId) {
  const local = (await listLocalDefinitions(handle)).find((d) => d.id === definitionId)
  if (local) {
    for (const version of [...local.versions].reverse()) {
      if ((await readLocalDefinitionStructure(handle, definitionId, version)).status === 'published') return version
    }
    return null
  }
  const res = await fetch('/api/definitions')
  if (!res.ok) return null
  const row = (await res.json()).find((d) => d.id === definitionId)
  return row?.latestPublished ?? null
}

async function changelogFor(handle, definitionId, version) {
  const local = await readOrNull(handle, `definitions/${definitionId}/${version}/CHANGELOG.md`).catch(() => null)
  if (local !== null) return changelogSection(local, version)
  const res = await fetch(`/api/definitions/${encodeURIComponent(definitionId)}/versions/${version}/changelog`).catch(() => null)
  if (!res?.ok) return null
  return changelogSection((await res.json()).changelog, version)
}

/**
 * A Local workspace Instance's move on offer, read from its folder: `{ view, plan }`, or `null` when its Definition has no newer
 * published version. `from` is the structure of the version the Instance is on (Instance Settings has it already).
 */
export async function localDefinitionMove(handle, slug, record, from) {
  const target = definitionMoveTarget(record.definitionVersion ?? 1, await latestPublishedVersion(handle, record.definition))
  if (!target) return null
  const to = await resolveDefinitionStructure(handle, record.definition, target)
  const moduleFiles = {}
  for (const moduleId of removedFieldModuleIds(from, to)) moduleFiles[moduleId] = await readOrNull(handle, `gantry-workspace/${slug}/modules/${moduleId}.md`)
  const plan = planDefinitionMove({ from, to, stageId: record.stage, moduleFiles })
  return { plan, view: definitionMoveView(plan, { changelog: await changelogFor(handle, record.definition, target) }) }
}

/**
 * Makes a Local workspace Instance's move in its folder: the Module files, the decisions log line and instance.yaml, each written in
 * turn and every one put back if a later write fails, so a failed move leaves the folder as it was.
 */
export async function moveLocalInstance(handle, slug, plan) {
  const folder = `gantry-workspace/${slug}`
  const instanceYaml = await readTextFile(handle, `${folder}/instance.yaml`)
  const logText = await readOrNull(handle, `${folder}/interview/${plan.stageId}.yaml`)
  const files = definitionMoveWrites(plan, { instanceYaml, logText, entry: definitionMoveEntry(plan) })
  await writeAllOrRestore(
    files.map(({ path, text }) => ({ path: `${folder}/${path}`, text })),
    { read: (path) => readOrNull(handle, path), write: (path, text) => writeTextFile(handle, path, text), remove: (path) => removeFile(handle, path) }
  )
}
