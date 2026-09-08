// The hand-typeable markdown convention for referencing an instance asset (#80): a normal markdown image whose "URL" is `asset:<id>` rather than a real path — `![<name>](asset:<id>)`. It's never fetched literally; the editor's live preview (web/app.js) rewrites it to the real resolvable file URL before handing the markdown to markdown-it, so the *stored* source stays a portable, host-independent reference. The Pandoc render step (#81) resolves the same convention at render time.
//
// Keep this regex in sync with lib/assets.js's server-side copy — same intentional duplication as web/lib/theme.js vs. web/index.html's bootstrap script (a browser-facing module can't import server code, and vice versa).
export const ASSET_REF_RE = /!\[([^\]]*)\]\(asset:([\w-]+)\)/g

// WI260 repo-as-asset-store: the relative-path convention for workspace-backed assets — `![alt](../assets/<name>)` or `![alt](assets/<name>)`, sibling of `modules/`. Keep in sync with lib/assets.js's REPO_ASSET_REF_RE.
export const REPO_ASSET_REF_RE = /!\[([^\]]*)\]\((?:\.\.\/)?assets\/([^)\s"']+)\)/g

/** Builds the hand-typeable/insertable markdown reference for an asset. */
export function assetReference(asset) {
  return `![${asset.name}](asset:${asset.id})`
}

/**
 * WI #348: a manifest `source` that is not an http(s) URL is a *local* source — the image's own copy stored within the instance (`assets/<filename>`). Keep in sync with lib/assets.js's isLocalAssetSource.
 */
export function isLocalAssetSource(source) {
  return typeof source === 'string' && source.trim() !== '' && !/^https?:\/\//i.test(source.trim())
}

/**
 * Rewrites every `![alt](asset:<id>)` reference in `markdown` to `![alt](<resolveUrl(id)>)`, so a downstream markdown renderer sees an ordinary, fetchable image URL. Leaves everything else untouched.
 * When `resolveSource` is supplied, also emits a caption-styled citation immediately below the image — `*Source: [<label>](<<href>>)*` — for assets that carry a source. `resolveSource(id)` may return the source string (label and link are the same) or `{ label, href }` (WI #348: a local source is labelled by its stored path but linked to the fetchable file URL). No citation is emitted when the asset lacks a source.
 */
export function resolveAssetRefs(markdown, resolveUrl, resolveSource) {
  return markdown.replace(ASSET_REF_RE, (match, alt, id) => {
    const url = resolveUrl(id)
    const base = `![${alt}](${url})`
    if (!resolveSource) return base
    const source = resolveSource(id)
    if (!source) return base
    const { label, href } = typeof source === 'string' ? { label: source, href: source } : source
    return `${base}\n\n*Source: [${label.replaceAll(']', '\\]')}](<${href}>)*`
  })
}

/**
 * WI260 repo-as-asset-store: rewrites every `![alt](../assets/<name>)` or `![alt](assets/<name>)` reference in `markdown` to `![alt](<resolveUrl(filename)>)`, so the browser preview sees a fetchable URL. No citation is emitted for repo assets.
 */
export function resolveRepoAssetRefs(markdown, resolveUrl) {
  return markdown.replace(REPO_ASSET_REF_RE, (match, alt, filename) => {
    const url = resolveUrl(filename)
    return `![${alt}](${url})`
  })
}
