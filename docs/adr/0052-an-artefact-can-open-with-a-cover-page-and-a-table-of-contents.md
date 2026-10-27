# An Artefact can open with a cover page and a table of contents

Follows ADR-0049, which made Document Control switchable per Artefact, and
uses the same pattern for two pieces of front matter Gantry did not produce at
all.

Until now a rendered document opened with its template's H1, then the
Document Control and Review & sign-off tables the pipeline puts straight under
it (WI233), then the body. There was no cover page and no table of contents.

## Why that is no longer enough

Review #191 of a Solution Architecture Document rendered from `design` v2
found that the Word output wasn't production-ready. Reviewers wanted a cover
that says what the document is and how to handle it (classification, title,
version, author, status, purpose) before they start reading, and a table of
contents after Document Control so they can find their way round a long
document. The architect added both by hand before every review.

Neither belongs on every document. A short document sent to a candidate gets
no value from a cover or a contents page. A signed-off document must not
change on re-render because Gantry started adding pages to it.

## Decision

1. **Two opt-in Artefact keys.** `cover-page: true` opens the document with a
   cover page. `table-of-contents: true` adds a "Table of Contents" heading and
   a Word TOC field. Both default to off, so an Artefact without them, or with
   `false`, renders exactly as before. A regression test pins the compiled
   Markdown of every Artefact of design v1 and v2 and recruitment-onboarding
   v1 to v3 to what it was before these keys existed.

2. **The cover.** It shows, in this order and only when there is a value:
   - a classification, read from the Field the Artefact names with
     `cover-classification: <module>.<field>`
   - the title: the instance's display name (its name, or its slug title-cased)
   - the document type: the Artefact's own title
   - version and status: the same values the Document Control table prints,
     so the two never disagree
   - author: the instance's Assignee (ADR-0009)
   - the Artefact's `purpose`.

   A page break follows. The cover reads only the instance record, the
   Artefact spec and the Document Control values. It never shows a diagram or
   section content. The classification is left out when the key is absent or
   the Field is blank; any other missing value is left out rather than printed
   blank.

3. **Where the front matter goes.** With a cover, the cover is the title page.
   Document Control follows it, then the table of contents, then everything the
   template produced, unchanged, its own H1 included. Without a cover, the
   template's H1 is still the document's title, and the front matter goes
   straight under it, where Document Control has always been: Document
   Control, then the table of contents. With `document-control: false` the
   table of contents takes Document Control's place: straight after the cover,
   or first under the title when there is no cover. The table of contents ends
   with a page break so the first section starts on a fresh page.

4. **It is built in the shared compile step.** `compileArtefact` in
   `lib/render.js` adds the front matter to the compiled Markdown. Local,
   Azure DevOps, GitHub, GitLab and Bitbucket renders (both pushes of the
   two-push render), WASM prepare, a Local Workspace, `gantry render` and
   stage approval's auto-render all compile through it, so neither the native
   Pandoc arguments nor the browser's pandoc-wasm options change. The front
   matter is plain Pandoc Markdown. Paragraphs carry a Pandoc `custom-style`,
   so a Definition's reference `.docx` styles them like any other paragraph.
   `Title`, `Subtitle` and `TOC Heading` are built-in Word styles that every
   reference document already has. `Cover Classification`, `Cover Details` and
   `Cover Purpose` are created on the fly, based on Body Text, when the
   reference document doesn't define them. Word-only parts (the page breaks
   and the TOC field) are raw OpenXML blocks, which Pandoc copies into the
   `.docx`.

5. **The table of contents is a Word field, not Pandoc's TOC option.** The
   field lists heading levels 1 to 3 (`TOC \o "1-3" \h \z \u`). Pandoc's
   `--toc` was ruled out for two reasons. It puts the contents at the start of
   the body, before Document Control. It is also an argument, so it would have
   to be added to both render paths, the native `pandoc` call and the
   browser's pandoc-wasm options. The field is marked dirty
   (`w:dirty="true"`), so Word rebuilds it from the document's headings when
   the document is opened. Pandoc's own TOC uses the same flag. The spec's
   wording was the document-wide `updateFields` setting, but that can't be
   set from the Markdown. Pandoc writes `word/settings.xml` itself and drops
   `updateFields` even from a reference document that has it (checked against
   native Pandoc 3.1.3 and pandoc-wasm's Pandoc 3.9). Adding it would mean
   post-processing the `.docx` in both render paths. Word may ask before it
   updates the field, as it does for any document with fields to refresh.
   Until the field is updated, it shows a one-line placeholder rather than
   nothing, for any viewer that doesn't refresh fields.

6. **Only real values are accepted.** `cover-page` and `table-of-contents`
   take only `true` or `false`. Anything else, such as `"yes"` (also what an
   unquoted `yes` becomes), is an `invalid-cover-page` or
   `invalid-table-of-contents` problem. `cover-classification` must name, as
   `module.field`, a single-valued `select` or `text` Field in the Artefact's
   own `requires`, directly, with `?`, or through a bare module entry.
   Anything else is an `invalid-cover-classification` problem. The
   `requires` rule is the filename pattern's (ADR-0045) and has the same
   reason: a render reads only the Modules its Artefact requires, so any
   other Field would always print blank. The rules live in
   `web/lib/artefactFrontMatter.js`, which both `lib/definition.js` and the
   Local Workspace validator (`web/lib/localStatus.js`) import, so the two
   can't drift. They are reported by `gantry validate`, shown as a marker on
   the Definitions page, reported in a Local Workspace, and refused at Save
   and Publish, locally and on every Provider. The version projection and the
   Local Workspace reader carry a bad value through as it is, so validation
   sees it and Save doesn't silently delete it.

   Unlike ADR-0049's `invalid-document-control`, these problems **don't stop
   a Definition loading** (they are authoring-only, like #149's gate checks).
   ADR-0049 blocked loading because misreading `document-control` prints
   internal tables on a document meant to leave the organisation. Nothing
   here fails that way. The render turns front matter on only for a real
   `true`, and prints a classification only from a Field it can resolve. A
   bad value leaves front matter out. It never adds anything the author
   didn't ask for. So spec #147's preference holds: an instance already
   running on a Definition keeps loading after an upgrade.

7. **The Definitions page shows them.** Each Artefact has a **Cover page**
   checkbox, a **Cover classification** choice and a **Table of contents**
   checkbox, on the Definitions page and in the Local Workspace definition
   editor. Both checkboxes are unticked by default. Ticking stores `true`.
   Unticking removes the key rather than writing `false`, so a Definition
   that never uses them keeps its YAML unchanged. The classification choice
   offers only the Fields validation accepts. All three are read-only on a
   published version. Like every Artefact key since #148, the keys survive
   save, new draft, clone, publish, promote, each Provider's loader and the
   Library cache.

## What this leaves to Definitions

- **A cover document's own title.** With a cover, a template that keeps its
  `#` title line prints it after Document Control and the table of contents,
  as an ordinary Heading 1. A template written for a cover usually leaves the
  title line out. `design` v3 (#196) decides this for its own templates.
- **What the table of contents lists.** It lists every Heading 1 to 3 in the
  document, and the Document Control partial's `## Document Control` and
  `## Review & sign-off` are Heading 2s, so they are listed too. A Definition
  that doesn't want them listed can ship its own `_documentControl.md.tmpl`.
  The `TOC Heading` style in the bundled reference documents is based on
  Heading 1. Heading numbering added to Heading 1 (#197) has to leave it
  unnumbered.
- **The `.md` output** carries the cover and contents as Pandoc Markdown:
  `custom-style` divs and the raw OpenXML blocks for the page breaks and the
  field. It is Pandoc's input, not a document for reading as plain text.

## Alternatives considered

- **Pandoc's own front matter** (`--toc`, and a metadata title block for the
  cover). Rejected. `--toc` places the contents before Document Control and
  is an argument both render paths would need. A metadata title block has no
  place for classification, version, status or purpose, and no page break.
- **Letting each template write its own cover.** Rejected for ADR-0049's
  reason: every Definition would reimplement it. A template also can't put
  its cover before the Document Control block the pipeline injects under its
  H1.
- **Post-processing the `.docx`** to set `updateFields` or insert the contents
  page. Rejected. It would add a step to both render paths, in Node and in
  the browser, and the spec rules out post-processing.
- **A fixed classification Field** (always `classification.classification`,
  say) rather than a pointer. Rejected. It would tie the engine to one
  Definition's Module names. Spec #192 gives `design` v3 a classification
  `select` (ADR-0044), but other Definitions name theirs differently or have
  none.
- **One switch per Definition.** Rejected. A Definition mixes internal
  documents with documents for outside readers (spec #192, story 11), the
  same reason ADR-0049's switch is per Artefact.

Status: accepted.
