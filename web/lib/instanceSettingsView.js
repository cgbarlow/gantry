// #219 (spec #223, docs/adr/0058): the Preact pieces every surface draws Instance settings with,
// from the one description web/lib/instanceSettings.js gives — so the wizard, Instance Settings and
// the Definitions page (server and Local Workspace) can't drift in how a setting is shown.
import { html } from 'htm/preact'

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
