# `gantry render` draws Mermaid in an optional, CLI-only headless Chromium

#198, part of spec #192 (design v3), from review item GF-013 in #191. This is
phase 2 of docs/adr/0030 (Mermaid diagrams render in the browser) and replaces
that ADR's closing note that native-Pandoc exports "still show Mermaid as
source". It builds on docs/adr/0053 (Diagram captions).

Until now, `gantry render` left every Mermaid block in the Word document as
source text. The browser export drew the same block as a picture with a
`Diagram N. <title>` caption. A document rendered from the command line was
therefore incomplete, and different from the one rendered in the browser.

## Decision

1. **The CLI runs the browser's own Mermaid code in headless Chromium.**
   `gantry render` opens Playwright's headless Chromium on a blank page,
   serves that page `web/lib/mermaid.js` and its dependencies from the Gantry
   install, and calls the same `prepareMermaidForDocx` the browser's WASM
   export calls (`lib/mermaidChromium.js`). The page makes no network
   requests: every request is answered from local files, and anything else is
   refused. It hands back the markdown with each block replaced by its image
   reference, plus the PNGs. Native Pandoc then converts that markdown, with
   the PNGs found through `--resource-path` (`lib/render.js`,
   `renderArtefactWithDiagrams`).

   So the CLI gets the same Mermaid settings (`htmlLabels: false`, the
   neutral theme), the same 2× PNG, the same `mermaid-diagram-N.png` image
   names and the same `Diagram N. <title>` captions and alt text as the
   browser export. ADR-0030 asked for exactly this reuse.

2. **Chromium is an optional, CLI-only dependency.**
   - `playwright` moves from `devDependencies` to `optionalDependencies`. A
     normal `npm install` installs the package. The browser itself is a
     separate, deliberate step: `npx playwright install chromium`.
   - `npm install --omit=optional` leaves the package out. The server
     container images (`ContainerFile`'s runtime stage and
     `ContainerFile.demo`) install with `--omit=dev --omit=optional`, so they
     carry neither the package nor a browser. `gantry serve` never imports
     it.

3. **Without Chromium, the render still succeeds.** If the package or its
   browser is missing, or Chromium fails to start or to draw, `gantry render`
   prints one warning and leaves every diagram as source text, as it always
   did. The warning names the install command:
   `npx playwright install chromium`, preceded by
   `npm install --include=optional` when the package itself is missing.
   Diagrams keep their numbers either way, so the images after them are
   numbered as in the browser export (ADR-0053).

4. **Chromium starts only when there is something to draw.** A dry run, an
   `.md` render and a document with no Mermaid block never start it and never
   warn. A block Mermaid can't parse stays as source with no warning, as it
   does in the browser export.

5. **Only the CLI draws.** The server's Native Pandoc engine (the Settings
   toggle and its automatic fallback) and the stage-approval auto-render
   still convert Mermaid as source. Drawing there would need Chromium on the
   server, which this decision rules out. The browser export draws the
   diagrams for anyone using the web UI.

## Why

- **Lean server, parity on request.** ADR-0030 rejected server-side
  rasterising because it made Chromium a runtime dependency of `gantry serve`
  and of every install. That still holds: the browser path stays lean, with
  no headless browser in the server or its image. People who render from the
  command line can opt in to get the same output as the browser.
- **Mermaid needs a browser engine.** Mermaid lays out a diagram by measuring
  text in a real page. There is no supported way to run it in Node alone, so
  "draw it in the CLI" means "run a browser". Playwright is already this
  repository's test browser, so it adds no new tool.
- **One copy of the rendering code.** Running the browser module unchanged
  means a change to the Mermaid settings, the scale, the image names or the
  caption format reaches both paths at once. A Playwright test renders one
  instance through both and compares every figure: caption, alt text, image
  name and PNG size (`tests/cliMermaid.playwright.test.js`).
- **The CLI stays synchronous where it was.** Drawing is asynchronous, but
  `renderArtefact` and its callers are not. `renderArtefactWithDiagrams`
  compiles the Artefact twice: a dry run to get the markdown to draw, then
  the real render converting the drawn markdown. Both compile the same files
  at the same commit. This keeps the change out of every server render path.

## Consequences

- A CLI render of any Definition's Artefact with a Mermaid block now carries
  the picture when Chromium is installed. This includes design v1 and v2. It
  matches what their browser export has drawn since ADR-0030, labelled plain
  `Diagram N` unless the Artefact opts in to captions. Without Chromium, the
  output is unchanged.
- A drawn diagram depends on the fonts of the machine that drew it, in the
  CLI as in the browser. Two machines can produce PNGs of slightly different
  sizes.
- `docker run gantry render …` leaves diagrams as source, with the warning.
  The image is a server image. Anyone who wants pictures from the command
  line installs Gantry and Chromium locally.
- Starting Chromium adds about a second to a render that has diagrams.

## Alternatives considered

- **Chromium in the server image, so Native Pandoc draws too.** Rejected for
  the reasons in ADR-0030: hundreds of megabytes and a browser's attack
  surface in every deployment, for something the user's own browser already
  does.
- **A Node-only renderer** (`@mermaid-js/mermaid-cli`, jsdom). Rejected.
  mermaid-cli is itself a Puppeteer wrapper with its own Chromium, its own
  settings and its own image output, so it would duplicate the rendering code
  this ADR keeps single. jsdom can't measure text, so its layouts are wrong.
- **SVG in the docx instead of PNG.** Rejected for the reason in ADR-0030:
  Word's SVG support varies between builds.
- **Failing the render when Chromium is missing.** Rejected. A document with
  diagrams as source is still a useful document, and every server install is
  in this state on purpose.

Status: accepted.
