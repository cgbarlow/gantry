# Diagram captions go on the Mermaid fence and in an image's alt text

#195, part of spec #192 (design v3), from review item GF-013 in #191. Builds on
docs/adr/0030 (Mermaid drawn in the browser) and docs/adr/0033 (Visual editing
stays inside CodeMirror).

A reviewer of a `design` v2 Solution Architecture Document found that its
diagrams had no real caption. The browser export labelled each Mermaid picture
"Diagram N" and nothing more, and an uploaded image showed its alt text with no
number. The architect added "Diagram N. <title>" under every figure by hand.

Whatever syntax an author uses to caption a diagram ends up stored in module
files across every Instance. Changing it later means migrating that content, so
the choice is recorded here.

## Decision

1. **A Mermaid block is captioned on its fence**, in Pandoc's own attribute
   syntax:

   ````markdown
   ```mermaid {caption="Security architecture"}
   flowchart LR
     Member --> Portal
   ```
   ````

   The word after the backticks stays `mermaid`, so markdown-it and other
   CommonMark renderers still see a Mermaid block: CommonMark takes the first
   word of the info string as the language, and the rest is not printed. Pandoc
   parses the `{…}` block as the code block's attributes. Single quotes and
   backslash escapes work as Pandoc defines them. A fence written with no space
   before the brace (```` ```mermaid{caption="…"} ````) is read the same way
   everywhere Gantry reads it, including the editor preview.

2. **An image is captioned by its alt text**, the text it already has:
   `![Security architecture](asset:<id>)`. No new syntax. The Image dialog has
   always put the asset's name there.

3. **The Word document shows the figure, then `Diagram N. <title>`.** The
   caption is a paragraph in Pandoc's *Image Caption* style, which is italic,
   directly under a figure paragraph in the *Captioned Figure* style, which
   carries keep-with-next. So the caption is never left on the next page. Both
   styles come from the Artefact's reference document, so an organisation's
   house style decides how a caption looks. Centring the caption is a setting
   on the Image Caption style. It belongs in v3's shared style set (#197), not
   in the engine.

4. **One sequence per document.** Mermaid blocks and figures are numbered
   together, in document order. A figure is an image alone in its paragraph
   with non-empty alt text, which is what Pandoc's `implicit_figures` turns
   into a captioned figure. That includes an image directly under a heading
   line, alt text holding balanced brackets, and CRLF text. An image beside
   other text, an image with empty alt text, and anything inside a code block
   are left alone and take no number. One case is not covered: an image inside
   a block quote (`> ![…](…)`) is still a figure to Pandoc but takes no
   number, so it keeps its bare alt text as its caption.

5. **Numbering is opt-in per Artefact.** An Artefact that sets
   `diagram-captions: true` in its Definition is numbered. Every other
   Artefact is converted from exactly the markdown it was before this change,
   so its Word output is byte-for-byte unchanged. This follows the spec's rule
   that engine options are opt-in per Artefact, as `document-control`
   (ADR-0049) already does. design v3 sets the key on every one of its
   Artefacts in its `definition.yaml`; design v1 and v2, recruitment-onboarding and any organisation's own Definitions do not,
   and are unaffected until their author opts in. The key takes only `true` or
   `false`. Any other value is an `invalid-diagram-captions` problem, reported
   by `gantry validate`, on save and publish and in a Local Workspace, but it
   never stops a Definition loading: the render honours only a real `true`, so
   a bad value leaves the document unnumbered, as it always was. The key is
   kept through every Definition lifecycle operation (save, publish, new
   draft, clone, promote, each Provider, the Local Workspace copy) and
   projected only when set. Like `cover-page` and `table-of-contents`
   (ADR-0052), it is shown in the Definition viewer as a "Diagram captions"
   checkbox on each Artefact, unticked by default: read-only on a published
   version, and on a draft (server-hosted or Local Workspace) ticking it stores
   `true` and unticking removes the key.

6. **The numbering happens in the shared compile step** (`compileArtefact` in
   `lib/render.js`, using `web/lib/diagramCaptions.js`). The step returns two
   markdowns:
   - `markdown` is the exported `.md`, exactly as the author wrote it, caption
     syntax included. ADR-0030 already kept the fenced source there.
   - `docxMarkdown` is what the `.docx` is converted from. For an Artefact
     that opts in, a figure's alt text gains its `Diagram N. ` prefix and each
     Mermaid fence keeps its source and gains a resolved `figure-caption`
     attribute. For any other Artefact it is `markdown` itself.

   The native / CLI conversion and the browser's WASM conversion both start
   from `docxMarkdown`, so every render path numbers the same diagrams the same
   way. The browser turns each fence into its picture and labels it with that
   attribute (`prepareMermaidForDocx`, `web/lib/mermaid.js`). The CLI will do
   the same when it can draw Mermaid (#198).

7. **The caption is also the alt text.** Pandoc gives a figure's image the
   caption as its description, so a screen reader announces "Diagram 2.
   Security architecture".

8. **An uncaptioned diagram renders as before.** In an Artefact that opts in,
   an uncaptioned Mermaid block is still labelled plain "Diagram N" in the
   browser export. It takes its place in the shared sequence, so the numbers
   after it stay correct. An opted-in document with no caption anywhere
   produces the same Word output it did before this change. In an Artefact
   that does not opt in, every Mermaid block keeps today's per-block "Diagram
   N" and every image keeps its bare alt text as its caption.

9. **The editor shows the caption.** The preview, and Visual view, draw a
   captioned fence with its caption under the picture. They show the title
   only, with no number, because an editor shows a field, not a whole
   document. Visual view's **Edit diagram text** pop-over edits only the
   diagram text, so the fence line and its caption are saved exactly as
   written (ADR-0033).

## What changes for existing documents

Nothing, unless a Definition author opts an Artefact in. Spec #192 story 41
asks that users of design v1 and v2, and of every other Definition, see no
change. The first version of this ADR numbered every Artefact, so every image
with alt text in an existing document, including the eight in the example
SAD, would have gained a "Diagram N. " prefix on its next render. Review
rejected that, and the opt-in in decision 5 replaced it. Tests pin it: the
unmodified example SOAP and SAD, on design v2, convert to the same
`word/document.xml` as the compiled markdown handed straight to Pandoc.

For an Artefact that opts in, an image that already has alt text renders as
"Diagram N. <alt text>". The alt text then needs to read as a caption. An
image uploaded without a name has its filename as alt text, so it renders as
"Diagram 3. context.png" until someone gives it a better name.

Until #198 lands, `gantry render` and the Native Pandoc engine still show a
Mermaid block as source text, with no caption. In an Artefact that opts in,
the block still takes its number, so the images after it are numbered as they
are in the browser export. (#198 has landed for `gantry render` when the
optional headless Chromium is installed: see docs/adr/0055. The server's
Native Pandoc engine still shows the source.)

## Alternatives considered

- **A Mermaid `title` or `accTitle` inside the diagram.** Rejected. Mermaid
  draws a `title` inside the picture, so it would appear twice. Not every
  diagram type supports either directive. It would also put document
  structure inside the diagram source that the pop-over edits.
- **An HTML comment above the fence** (`<!-- caption: … -->`). Rejected.
  Nothing ties a comment to the next block once someone edits around it.
  markdown-it and Visual view would need their own parser for it, and it is
  not Pandoc syntax.
- **A caption paragraph after the diagram** (`Diagram: Security
  architecture`, or Pandoc's `: caption` line as used for tables). Rejected.
  It shows as body text in every renderer that doesn't know the convention,
  including GitHub and the exported `.md`. It also separates from its diagram
  when content is moved.
- **The fully Pandoc form** (```` ```{.mermaid caption="…"} ````). Rejected.
  CommonMark renderers would read the language as `{.mermaid`. The diagram
  would stop drawing in the editor and on GitHub.
- **An image's title** (`![alt](asset:id "caption")`) as its caption, separate
  from its alt text. Rejected. It is a second place to type the same words,
  the Image dialog doesn't write it, and the spec asks that the caption be the
  alt text.
- **Numbering every Artefact, with no switch.** Rejected in review. It
  changed existing v1 and v2 documents without their authors asking (spec
  #192 story 41).
- **A Definition-level switch.** Rejected. Every other engine option in the
  spec is per Artefact, and a Definition may want captions on its design
  documents but not on a one-page letter.
- **Word `SEQ` fields for the numbers**, so Word renumbers and could build a
  table of figures. Rejected for now. Pandoc's Markdown has no way to emit
  them without raw OpenXML on both render paths. A rendered document is
  always regenerated from source, so static numbers can't drift.

Status: accepted.
