// #219 (spec #223, docs/adr/0058): the Preact pieces every surface draws Instance settings with,
// from the one description web/lib/instanceSettings.js gives — so the wizard, Instance Settings and
// the Definitions page (server and Local Workspace) can't drift in how a setting is shown.
import { html } from 'htm/preact'
import { useRef, useState } from 'preact/hooks'
import {
  definitionInstanceSettings,
  instanceSettingsDeclaration,
  classificationMarkings,
  withInstanceSettingDefault,
  withoutInstanceSetting,
  withClassificationMarkingAdded,
  withClassificationMarkingRenamed,
  withClassificationMarkingRemoved,
  withClassificationMarkingMoved,
} from './instanceSettings.js'

/**
 * The `<select>` for one Instance setting (`setting` from `definitionInstanceSettings`), labelled by
 * its name for assistive tech. An optional setting with no default (#220's Classification) opens with
 * "None", the blank value, so nothing has to be chosen.
 */
export function InstanceSettingSelect({ setting, value, id, disabled = false, onChange }) {
  return html`
    <select id=${id} class="wizard-input" aria-label=${setting.label} disabled=${disabled} value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
      ${setting.optional ? html`<option key="" value="">None</option>` : null}
      ${setting.choices.map((choice) => html`<option key=${choice.value} value=${choice.value}>${choice.label}</option>`)}
    </select>
  `
}

/**
 * The Definitions page's read-only view of the Instance settings a Definition offers: for each, why
 * it is offered, its choices and its default. `settings` is `definitionInstanceSettings(...)`; an
 * empty list renders nothing, so a Definition without Instance settings shows no section.
 */
export function InstanceSettingsSummary({ settings }) {
  if (!settings?.length) return null
  const labelOf = (setting, value) => setting.choices.find((choice) => choice.value === value)?.label ?? value
  return html`
    <div class="instance-settings-summary">
      ${settings.map(
        (setting) => html`
          <div key=${setting.id} class="instance-setting-summary" data-setting=${setting.id}>
            <h3>${setting.name} <code>${setting.id}</code></h3>
            <p class="guidance instance-setting-offered">Offered because ${setting.offeredBecause}.</p>
            <p>
              <span class="field-label">Choices</span>
              <span class="instance-setting-choices">${setting.choices.map((choice) => choice.label).join(' · ')}</span>
              ${setting.fixedChoices ? html` <span class="muted defn-hint">set by Gantry</span>` : null}
            </p>
            <p><span class="field-label">Default</span> <span class="instance-setting-default">${setting.default ? labelOf(setting, setting.default) : 'None'}</span></p>
          </div>
        `
      )}
    </div>
  `
}

// The box and button that add a marking to the end of Classification's list; on a Definition that
// declares no markings, the first one declares Classification. Blank text adds nothing.
function AddMarking({ first, onAdd }) {
  const [text, setText] = useState('')
  const add = () => {
    if (text.trim() === '') return
    onAdd(text.trim())
    setText('')
  }
  return html`
    <div class="instance-setting-add-marking">
      <input class="wizard-input" aria-label="New marking" placeholder=${first ? 'e.g. IN-CONFIDENCE' : 'Another marking'} value=${text}
        onInput=${(e) => setText(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          add()
        }} />
      <button type="button" class="btn small ghost" disabled=${text.trim() === ''} onClick=${add}>${first ? '+ Declare markings' : '+ Add marking'}</button>
    </div>
  `
}

/**
 * #221 (docs/adr/0058 §7): a draft's Instance settings on the Definitions page (server and Local
 * Workspace), each edited the same way — its choices and its default. `definition` is the draft
 * (anything `definitionInstanceSettings` reads); `onChange` gets the new `instance-settings`
 * declaration, for the draft to carry as `instanceSettings`.
 *
 * - **Target size**, while some Field declares word targets: its three choices are Gantry's, shown
 *   but not editable; its default is one of them.
 * - **Classification**, always, so a Definition without markings can declare its own: markings are
 *   added, renamed, reordered and removed in place, with an optional default.
 *
 * It edits the declaration as the draft holds it, blanks and repeats included, so a problem stays
 * where the author made it (the page lists it, from its own validator) rather than the setting
 * vanishing because a malformed one isn't offered.
 */
export function InstanceSettingsEditor({ definition, onChange }) {
  const declaration = instanceSettingsDeclaration(definition)
  const offered = definitionInstanceSettings(definition)
  const size = offered.find((setting) => setting.id === 'size')
  const classification = offered.find((setting) => setting.id === 'classification')
  const markings = classificationMarkings(declaration)
  const classificationDefault = declaration?.classification?.default ?? ''
  // The default's options: each marking once, blanks left out — plus the declared default when the
  // list no longer holds it, so the select still says what is declared while its problem is shown.
  const defaultOptions = [
    ...new Set([...(markings ?? []).filter((marking) => typeof marking === 'string' && marking.trim() !== ''), ...(classificationDefault ? [classificationDefault] : [])]),
  ]
  // The marking the default belonged to when its author cleared that marking's text, so retyping it
  // brings the default back: a blank marking can't be a default, so renaming one to nothing drops
  // it, and without this, deleting a marking's text to type a new name would lose the default. Any
  // other edit forgets it.
  const blankedDefault = useRef(null)
  const change = (edit) => {
    blankedDefault.current = null
    onChange(edit(declaration))
  }
  const rename = (index, marking) => {
    const was = blankedDefault.current
    blankedDefault.current = null
    let next = withClassificationMarkingRenamed(declaration, index, marking)
    if (marking === '' && classificationDefault !== '' && markings?.[index] === classificationDefault) blankedDefault.current = index
    else if (was === index && marking !== '' && next.classification?.default === undefined) next = withInstanceSettingDefault(next, 'classification', marking)
    onChange(next)
  }
  return html`
    <div class="instance-settings-editor">
      ${size
        ? html`
            <div class="instance-setting-summary instance-setting-editor" data-setting="size">
              <h3>${size.name} <code>size</code></h3>
              <p class="guidance instance-setting-offered">Offered because ${size.offeredBecause}.</p>
              <p>
                <span class="field-label">Choices</span>
                <span class="instance-setting-choices">${size.choices.map((choice) => choice.label).join(' · ')}</span>
                <span class="muted defn-hint"> set by Gantry: every field's word targets are written against them</span>
              </p>
              <p>
                <label class="field-label" for="instance-setting-default-size">Default</label>
                <select id="instance-setting-default-size" class="wizard-input instance-setting-default-select" aria-label="Target size default" value=${size.default}
                  onChange=${(e) => change((d) => withInstanceSettingDefault(d, 'size', e.currentTarget.value))}>
                  ${size.choices.map((choice) => html`<option key=${choice.value} value=${choice.value}>${choice.label}</option>`)}
                </select>
              </p>
              <p class="muted defn-hint">The size an instance works to until its author chooses one, and the one the wizard pre-selects.</p>
            </div>
          `
        : null}
      <div class="instance-setting-summary instance-setting-editor" data-setting="classification">
        <h3>Classification <code>classification</code></h3>
        ${markings === null
          ? html`
              <p class="guidance instance-setting-offered">Not declared, so this Definition's instances have no Classification and their documents print no marking.</p>
              <${AddMarking} first=${true} onAdd=${(marking) => change((d) => withClassificationMarkingAdded(d, marking))} />
            `
          : html`
              ${classification ? html`<p class="guidance instance-setting-offered">Offered because ${classification.offeredBecause}.</p>` : null}
              <span class="field-label">Markings</span>
              <ol class="instance-setting-markings">
                ${markings.map(
                  (marking, i) => html`
                    <li key=${i} class="instance-setting-marking">
                      <input class="wizard-input" aria-label=${`Marking ${i + 1}`} value=${typeof marking === 'string' ? marking : String(marking ?? '')}
                        onInput=${(e) => rename(i, e.currentTarget.value)} />
                      <button type="button" class="btn small ghost" aria-label=${`Move marking ${i + 1} up`} disabled=${i === 0} onClick=${() => change((d) => withClassificationMarkingMoved(d, i, -1))}>↑</button>
                      <button type="button" class="btn small ghost" aria-label=${`Move marking ${i + 1} down`} disabled=${i === markings.length - 1} onClick=${() => change((d) => withClassificationMarkingMoved(d, i, 1))}>↓</button>
                      <button type="button" class="btn small ghost" aria-label=${`Remove marking ${i + 1}`} onClick=${() => change((d) => withClassificationMarkingRemoved(d, i))}>Remove</button>
                    </li>
                  `
                )}
              </ol>
              <${AddMarking} first=${false} onAdd=${(marking) => change((d) => withClassificationMarkingAdded(d, marking))} />
              <p>
                <label class="field-label" for="instance-setting-default-classification">Default</label>
                <select id="instance-setting-default-classification" class="wizard-input instance-setting-default-select" aria-label="Classification default" value=${classificationDefault}
                  onChange=${(e) => change((d) => withInstanceSettingDefault(d, 'classification', e.currentTarget.value))}>
                  <option value="">None</option>
                  ${defaultOptions.map((marking) => html`<option key=${marking} value=${marking}>${marking}</option>`)}
                </select>
              </p>
              <p class="muted defn-hint">With no default, the wizard and Instance Settings offer None beside the markings.</p>
              <button type="button" class="btn small ghost instance-setting-undeclare" onClick=${() => change((d) => withoutInstanceSetting(d, 'classification'))}>Stop declaring Classification</button>
            `}
      </div>
    </div>
  `
}
