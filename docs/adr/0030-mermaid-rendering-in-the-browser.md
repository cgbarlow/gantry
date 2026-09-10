# Mermaid diagrams render in the browser, for the preview and for browser-driven docx exports

WI #353. Picks up the follow-up docs/adr/0020 deferred: a markdown field
can already hold a fenced ```` ```mermaid ```` block, but until now the
editor preview showed it as source text and every exported `.docx` carried
it as a code block. The first consumer is the Gantry hosting Full SOAP
(`instances/gantry`, WI #354), which needs six diagrams.

## Decision

- **Where it renders.** The editor preview, and the `.docx` produced by the
  **WASM Pandoc** path (`web/lib/pandocWasm.js`) — local workspaces, local
  instances and Azure DevOps instances alike, since all three convert in the
  browser when the render engine is `wasm` (the default). The CLI and the
  native-Pandoc engine keep the fenced block as a code block; native
  rendering is a later phase, not part of this change.
- **How.** `web/lib/mermaid.js` lazy-imports mermaid's self-contained ESM
  bundle from `/node_modules/mermaid/dist/mermaid.esm.min.mjs` by fixed
  path (never the bare specifier), renders each block to SVG, sanitises it
  with DOMPurify's SVG profile, and:
  - in the preview, swaps the `<pre><code class="language-mermaid">`
    markdown-it emitted for a `<figure class="mermaid-diagram">` holding
    the SVG;
  - for the docx, rasterises the SVG to a **2× PNG** on an off-screen
    canvas and hands the bytes to pandoc-wasm's virtual filesystem, with the
    fence rewritten to an image reference for that conversion only.
- **The exported `.md` keeps the fenced source.** Only the docx gets the
  PNG. The `.md` stays portable and re-renderable.
- **A diagram that fails to parse** keeps its source: the preview adds an
  error note under it; the docx export leaves it as a code block. One bad
  diagram never blocks a render.
- **`htmlLabels: false`** for every diagram type. Mermaid's default wraps
  labels in `<foreignObject>` HTML, which taints a canvas (so `toBlob`
  throws and no PNG can be produced) and is exactly what DOMPurify's SVG
  profile strips. Plain SVG text labels avoid both.

## Why

- **Bare `import 'mermaid'` does not work here.** It resolves through
  `lib/importmap.js` to `dist/mermaid.core.mjs`, which bare-imports around
  twenty further packages, several needing a bundler's `browser`-field
  handling that `resolveEntry` deliberately does not do (docs/adr/0006). The
  `esm.min.mjs` bundle pulls its chunks by relative path and needs nothing
  else, the same trick `pandocWasm.js` uses for `core.js`.
- **Browser rasterisation, not server-side.** ADR-0020 sketched a
  server-side Playwright rasteriser. That would make Chromium a runtime
  dependency of `gantry serve` and of every install, for a capability the
  browser already has for free at the moment the WASM path is converting.
  It also leaves the native path untouched, which is the phase-1 boundary.
- **PNG, not SVG, in the docx.** Pandoc can embed SVG, but Word's SVG
  rendering is uneven across builds and the documents go to people whose
  Word version nobody controls. 2× PNG is crisp at page width and opens
  everywhere.
- **Lazy load.** The bundle is about 3 MB. It is fetched on the first
  Mermaid block only, so a field with no diagram costs nothing.

## Consequences

- A new runtime dependency (`mermaid`, pinned in `package.json`) served from
  `node_modules` like every other front-end library. No CDN, no bundler.
- `renderDocxWithWasm` gains a `files` argument for extra virtual-filesystem
  entries. That is also the seam a future asset-image embedding for the WASM
  path would use (today only `reference.docx` is injected).
- Label markup inside diagrams (`<b>`, `<br/>`) is not supported; use plain
  text and Mermaid's own line-break syntax.
- Native-Pandoc exports still show Mermaid as source. When phase 2 lands it
  should reuse `replaceMermaidBlocks` and produce the same image names.
