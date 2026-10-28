// #224 (spec #223, docs/adr/0058 amendment for #224, docs/adr/0059 amendment for #224): an
// Instance's own **Logo** — the picture its rendered documents show in their page header, in place
// of the Definition's logo (#222). It sits in the Instance settings group, under the same heading in
// the wizard and in Instance Settings, but it is file-shaped rather than "choices plus a default":
// its default is the Definition's logo, and its choice is an optional upload. So it is described
// here, beside web/lib/instanceSettings.js, rather than as one of that module's `MEMBERS`.
//
// The image is stored with the Instance, in its `assets/` folder as `instance-logo.png` (or
// `.jpeg`), and the Instance record names it under `logo:`, written only when one was uploaded. A
// render of a given commit therefore always shows the same logo. The logo shown is, in order: the
// Instance's own, else the Definition's (its reference documents' header picture), else whatever
// the reference document ships with. The Logo setting is offered only when the Definition's
// reference documents carry a header logo picture; whether they do is read from the documents
// themselves (lib/instanceLogo.js on the server, web/lib/localDefinitionFiles.js in a Local
// Workspace), so it isn't decided here.
//
// Pure and dependency-free, like web/lib/instanceSettings.js, so `lib/` imports it directly.

/** The Instance record key that names the Instance's own logo. */
export const INSTANCE_LOGO_KEY = 'logo'

/** How every surface names and explains the Logo setting. */
export const INSTANCE_LOGO_SETTING = {
  id: INSTANCE_LOGO_KEY,
  label: 'Logo',
  name: 'Logo',
  guidance:
    'The picture in the page header of every document this instance renders. Without one of its own, documents show the Definition\'s logo. ' +
    'A PNG or JPEG keeps its proportions in the space the Definition\'s logo takes up.',
}

/** The note beside the wizard's Logo upload: this logo is for this instance only. */
export const INSTANCE_LOGO_NOTE_BEFORE_LINK = 'This logo is used for this instance only. To change the logo for every new instance, change the Definition\'s logo on the '
export const INSTANCE_LOGO_NOTE_LINK = 'Definitions page'

// `assets/<one segment>.png|.jpg|.jpeg`: what a `logo:` value must look like to be read at all, so a
// hand-edited record can never point a render or a read outside the instance's own assets folder.
const LOGO_PATH_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g)$/i

/** The file an Instance's own logo is stored as, in its `assets/` folder, for an image of `extension` (`png` or `jpeg`). */
export function instanceLogoFileName(extension) {
  return `instance-logo.${extension === 'png' ? 'png' : 'jpeg'}`
}

/** The `logo:` value (a path relative to the instance's own folder) for an image of `extension`. */
export function instanceLogoRecordPath(extension) {
  return `assets/${instanceLogoFileName(extension)}`
}

/**
 * The path, relative to the instance's own folder, of the logo `record` (an `instance.yaml`'s
 * contents) names, or `null` when it names none or names something that isn't an image in its
 * `assets/` folder.
 */
export function instanceLogoPath(record) {
  const value = record?.[INSTANCE_LOGO_KEY]
  return typeof value === 'string' && LOGO_PATH_RE.test(value) && !value.includes('..') ? value : null
}

/**
 * What Instance Settings and `GET /api/instance` (and so MCP `get_instance`) report about the logo
 * of an Instance whose record is `record`: `{ own, source }` — `own` whether it has its own logo,
 * and `source` the logo its documents show, `'instance'` or `'definition'`.
 */
export function instanceLogoStatus(record) {
  const own = Boolean(instanceLogoPath(record))
  return { own, source: own ? 'instance' : 'definition' }
}

/** `record` with its `logo:` set to `path`, or removed when `path` is `null`. Every other key is kept. */
export function withInstanceLogoPath(record, path) {
  const next = { ...record }
  if (path) next[INSTANCE_LOGO_KEY] = path
  else delete next[INSTANCE_LOGO_KEY]
  return next
}

/** Why an Instance of `definition` (`{ id, version }`) can't store a logo of its own: its reference documents carry no header logo. */
export function instanceLogoNotOfferedMessage(definition) {
  return `Definition "${definition?.id}" v${definition?.version ?? 1} has no logo in its reference documents' page header, so its instances have no Logo setting`
}
