import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt()

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

const defaultHeadingRenderer =
  md.renderer.rules.heading_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const headingText = tokens[index + 1]?.content ?? ''
  const baseId = slugifyHeading(headingText)
  const seenIds = env?.headingIds ?? new Set()
  let id = baseId
  let occurrence = 1
  while (id && seenIds.has(id)) {
    occurrence += 1
    id = `${baseId}-${occurrence}`
  }
  if (id) seenIds.add(id)
  if (id) tokens[index].attrSet('id', id)
  return defaultHeadingRenderer(tokens, index, options, env, self)
}

// Asset previews use this class to distinguish uploaded images from ordinary markdown images.
const defaultImageRenderer = md.renderer.rules.image
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const src = tokens[index].attrGet('src') ?? ''
  if (src.startsWith('/api/instance/assets/')) tokens[index].attrJoin('class', 'asset-thumb')
  return defaultImageRenderer(tokens, index, options, env, self)
}

// Every link in rendered markdown opens in a new tab, except pure in-page anchors
// (`#heading`, which must stay in-page). Two reasons, one rule: (1) preact-iso's router
// intercepts *every* same-origin anchor click that has no `target` and turns it into a
// client-side route change — so an asset citation's `/api/instance/assets/<id>/file` link
// never reached the server at all, it just pushed an unroutable URL and dropped the user on
// the dashboard; (2) an external reference opening in the same tab navigates away from the
// module editor and loses unsaved edits. `target="_blank"` sidesteps both.
const defaultLinkRenderer =
  md.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = tokens[index].attrGet('href') ?? ''
  if (!href.startsWith('#')) {
    tokens[index].attrSet('target', '_blank')
    tokens[index].attrSet('rel', 'noreferrer')
  }
  return defaultLinkRenderer(tokens, index, options, env, self)
}

// AB#343: DOMPurify's default ALLOWED_URI_REGEXP has no `blob:` in its scheme allowlist, so a
// local-workspace instance's resolved asset URLs (both the `asset:<id>` and `assets/<name>`
// conventions — see web/app.js's ensureLocalAssetUrl, which always produces a
// `URL.createObjectURL()` blob URL) were silently stripped down to a bare `<img>` with no `src`
// attribute at all, DOMPurify treating the scheme as unrecognised/unsafe exactly like it would
// `javascript:`. This extends the default allowlist by one scheme rather than disabling
// sanitisation (`ALLOW_UNKNOWN_PROTOCOLS`) — same set DOMPurify ships, plus `blob:`.
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

export function renderMarkdown(source) {
  // `target` is not in DOMPurify's default attribute allowlist, so the link rule above would be
  // sanitised straight back out without ADD_ATTR.
  return DOMPurify.sanitize(md.render(source ?? '', { headingIds: new Set() }), {
    ALLOWED_URI_REGEXP,
    ADD_ATTR: ['target'],
  })
}
