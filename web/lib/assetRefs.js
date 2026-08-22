// The hand-typeable markdown convention for referencing an instance asset
// (#80): a normal markdown image whose "URL" is `asset:<id>` rather than a
// real path — `![<name>](asset:<id>)`. It's never fetched literally; the
// editor's live preview (web/app.js) rewrites it to the real resolvable
// file URL before handing the markdown to markdown-it, so the *stored*
// source stays a portable, host-independent reference. The Pandoc render
// step (#81) resolves the same convention at render time.
//
// Keep this regex in sync with lib/assets.js's server-side copy — same
// intentional duplication as web/lib/theme.js vs. web/index.html's
// bootstrap script (a browser-facing module can't import server code, and
// vice versa).
export const ASSET_REF_RE = /!\[([^\]]*)\]\(asset:([\w-]+)\)/g

/** Builds the hand-typeable/insertable markdown reference for an asset. */
export function assetReference(asset) {
  return `![${asset.name}](asset:${asset.id})`
}

/**
 * Rewrites every `![alt](asset:<id>)` reference in `markdown` to
 * `![alt](<resolveUrl(id)>)`, so a downstream markdown renderer sees an
 * ordinary, fetchable image URL. Leaves everything else untouched.
 */
export function resolveAssetRefs(markdown, resolveUrl) {
  return markdown.replace(ASSET_REF_RE, (match, alt, id) => `![${alt}](${resolveUrl(id)})`)
}
