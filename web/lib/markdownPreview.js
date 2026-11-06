// #347: the preview of Markdown that the module editor draws, in one place so anything else that shows Markdown the way the editor's preview
// does draws it through the same steps. It was the app shell's (web/app.js) alone; the AI interview's thread now draws the AI's replies with
// it as well. The steps, in order:
//
//   1. asset references are resolved to images (the caller's `resolveAssets`: the stored text keeps `asset:<id>` and `assets/<name>`, see
//      web/lib/assetRefs.js, and only the caller knows the Instance, the Stage and the asset files);
//   2. the text is rendered by Gantry's one Markdown renderer, markdown-it then DOMPurify (web/lib/markdown.js), which also opens every
//      link in a new tab;
//   3. #281: a citation of a Source document, `[Client brief, p. 4](source:client-brief)`, becomes a link that opens the document, or the
//      words the author wrote marked "(removed)" when the document was removed;
//   4. WI #353: each ```mermaid fence is drawn as a diagram;
//   5. an image's `*Source: …*` line is marked as its caption.
//
// Nothing here knows which page it is on: the caller hands in what the Instance's Source documents panel last listed and how to open one.
import { renderMarkdown } from './markdown.js'
import { hydrateMermaidPreview } from './mermaid.js'
import { parseSourceAddress, shortCommit } from './sourceRepository.js'
import { openRepository, openSourceDocument } from './sourceDocumentsPanel.js'

// #319: what follows `source:` in a citation, taken apart: `{ id, path?, commit? }` (a repository citation names a file and a commit).
export const citedRef = (ref) => parseSourceAddress(`source:${ref}`) ?? { id: ref }

/** #281: what a preview needs to know about each Source document a panel listed, `{ <id>: { title, filename, removed, repository? } }`. */
export function citationIndex(entries) {
  const index = {}
  for (const e of entries ?? []) index[e.id] = { title: e.title, filename: e.filename, removed: Boolean(e.removedAt), ...(e.repository ? { repository: e.repository } : {}) }
  return index
}

/**
 * #281: opens what a citation names, from `index` (citationIndex's) and the panel's `store`. A removed document, or an id the Instance has no
 * document for, opens nothing. #319: a repository citation opens the file it names on the Provider, as it was at the commit it names.
 * Rejects with the reason when the file can't be read.
 */
export async function openCitation(store, index, ref) {
  const { id, path, commit } = citedRef(ref)
  const entry = index?.[id]
  if (!entry || entry.removed) return
  if (entry.repository) openRepository(entry, { path, commit })
  else await openSourceDocument(store, { id, ...entry })
}

/**
 * #281: turns each `source:` link drawn in `node` into a citation. `index` is citationIndex's, or null for a kind of workspace that keeps no
 * Source documents (yet), where a citation is left as the words it holds; `open(ref)` opens one. A document that was removed still shows the
 * words the author wrote, marked "(removed)", and is not a link, because its file is gone; so does an id the Instance has no document for.
 */
export function activateSourceCitations(node, { index = null, open = null } = {}) {
  for (const link of node.querySelectorAll('a[href^="source:"]')) {
    const ref = link.getAttribute('href').slice('source:'.length)
    const { id, path, commit } = citedRef(ref)
    if (index === null) {
      const plain = document.createElement('span')
      plain.className = 'source-citation unavailable'
      plain.title = 'Source documents are not kept for this kind of workspace yet'
      plain.append(...link.childNodes)
      link.replaceWith(plain)
      continue
    }
    const entry = index[id]
    if (entry && !entry.removed) {
      link.classList.add('source-citation')
      link.dataset.sourceId = ref
      link.title = entry.repository ? `Open ${path ?? 'the repository'} in "${entry.title}"${commit ? ` as it was at ${shortCommit(commit)}` : ''}` : `Open the Source document "${entry.title}"`
      link.removeAttribute('target')
      continue
    }
    const gone = document.createElement('span')
    gone.className = `source-citation ${entry ? 'removed' : 'missing'}`
    gone.dataset.sourceId = id
    gone.title = entry ? `The Source document "${entry.title}" was removed` : 'No Source document in this Instance has this id'
    gone.append(...link.childNodes, entry ? ' (removed)' : ' (not found)')
    link.replaceWith(gone)
  }
  // One handler on the preview itself, replaced each time it is drawn, so redraws never stack them.
  node.onclick = (event) => {
    const link = event.target.closest?.('a.source-citation')
    if (!link || !node.contains(link)) return
    event.preventDefault()
    open?.(link.dataset.sourceId)
  }
}

/**
 * Draws `text` into `node` as the module editor's preview does (the steps at the top of this file). `resolveAssets(text)` rewrites the
 * asset references (none when left out); `sources` is `{ index, open }` for activateSourceCitations.
 */
export function renderMarkdownPreview(node, text, { resolveAssets = null, sources = {} } = {}) {
  if (!node) return
  const withSources = resolveAssets ? resolveAssets(text ?? '') : (text ?? '')
  node.innerHTML = renderMarkdown(withSources)
  activateSourceCitations(node, sources)
  // WI #353: ```mermaid fences render as diagrams in place. Async and fire-and-forget — a
  // re-render before a diagram finishes just leaves the swap with nothing to replace.
  hydrateMermaidPreview(node).catch(() => {})
  // Caption-styling hook: the citation renders as <p><em>Source: …</em></p>; mark that paragraph so the stylesheet can make it visually subordinate (caption) rather than body text.
  node.querySelectorAll('p').forEach((p) => {
    const em = p.querySelector('em')
    if (em && em.textContent.startsWith('Source:')) p.classList.add('asset-source')
  })
}
