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

## Amendment (#205): the cover prints a cover purpose, not `purpose`

Decision 2's last bullet, "the Artefact's `purpose`", is replaced. The
cover's purpose line now comes from a new optional Artefact key,
`cover-purpose`.

**Why.** An Artefact's `purpose` is written for the author (ADR-0022): the
User Guide and the Definitions page show it as an instruction, e.g. "Describe
the complete solution architecture …". Printed on a `design` v3 cover, it read
as an instruction to whoever picked the document up rather than a statement of
what the document is. One string can't serve both readers, so there are now
two.

**Decision.**

- `cover-purpose` is a string: the statement the cover prints under Author,
  written for the reader, e.g. "This document describes the complete solution
  architecture …". Its whitespace is collapsed to one line, like every other
  cover value.
- The cover prints `cover-purpose` when it is set, and **never falls back to
  `purpose`**. With `cover-page: true` and no `cover-purpose`, the cover has
  no purpose line. A fallback was rejected because it would put the
  instruction back on the cover of every Definition that hasn't written a
  cover purpose yet, which is the problem this fixes.
- `purpose` is unchanged. It stays the author-facing text the User Guide and
  the Definitions page show, and the render no longer reads it.
- Validation follows decision 6. `cover-purpose` must be a string with
  something in it. A blank, whitespace-only or non-string value is an
  `invalid-cover-purpose` problem, authoring-only like the other front-matter
  problems: it is reported by `gantry validate`, marked on the Definitions
  page and refused at Save and Publish, but the Definition still loads, and a
  bad value prints no purpose line. The rule lives in
  `web/lib/artefactFrontMatter.js` with the others, shared by
  `lib/definition.js` and the Local Workspace validator.
- Like the other keys (decision 7), it survives save, new draft, clone,
  publish, promote, each Provider's loader and the Library cache. It is a
  **Cover purpose** text box beside the Cover page checkbox on the Definitions
  page and in the Local Workspace definition editor. Emptying the box removes
  the key. It is shown read-only on a published version.
- It has no effect without `cover-page: true`, as `cover-classification` has
  none.

**Consequences.** `design` v3, still a draft, sets a `cover-purpose` on all
six Artefacts, each a "This document …" statement keeping its `purpose`'s
substance. `design` v1 and v2 and `recruitment-onboarding` set no
`cover-page`, so they render exactly as before. A Definition outside this repo
that already turned on `cover-page` loses the purpose line from its cover
until it adds a `cover-purpose`.

## Amendment (#206): the table of contents is filled in when the document is rendered

Decision 5 left the TOC field's result as a one-line placeholder, for Word to
replace when it opens the document. Any viewer that doesn't refresh fields
(previews, web viewers, other editors) showed only that sentence, so the
document read as if it had no table of contents.

1. **The field's result is filled in.** The compile step writes the entries
   Word itself builds when it updates the field, less the page numbers: one
   paragraph per heading at levels 1 to 3, in document order, in Word's
   `TOC 1` to `TOC 3` styles. Each entry is an internal link
   (`w:hyperlink w:anchor`) to its heading's bookmark. The field opens in the
   first entry's paragraph and closes in the last one's, as in a table of
   contents Word has built. It is still marked dirty, so desktop Word still
   rebuilds it, with page numbers, on open. The placeholder is used only when
   there is no heading to list.

2. **It lists what Pandoc will write, under the names Pandoc will give.**
   The entries are built from the Word conversion's Markdown (`docxMarkdown`),
   after the `.unnumbered` rewrite (ADR-0056). A Pandoc heading's bookmark is
   its `{#id}`, or else Pandoc's automatic identifier (with Pandoc's `smart`
   punctuation applied first), made unique the way Pandoc makes it (`-1`,
   `-2`, …). An identifier longer than 40 characters, or one that doesn't
   start with a letter, becomes Pandoc's `X` plus SHA-1 name. An
   `.unnumbered` heading is listed with the text and bookmark its raw
   OpenXML paragraph carries. Heading-like lines in fenced code or HTML
   comments, or that only continue a paragraph, aren't headings to Pandoc
   and aren't listed. Setext headings are listed. Headings inside list items
   or block quotes aren't listed, though Word would list them. Templates and
   Fields don't put headings there, and Word adds them when it updates the
   field.

3. **The numbers come from the reference document.** The compile step reads
   the reference document's `word/styles.xml` and `word/numbering.xml`: the
   same file the native render passes as `--reference-doc` and every prepare
   route hands the browser. Pandoc copies both parts into the `.docx`
   unchanged, so they decide the numbers beside the headings. Heading styles
   are found by their built-in names (`heading 1`, …) through `basedOn`, and
   the attached list's level gives the number format, start (including a
   `startOverride`), level text, legal numbering and the separator after the
   number. Headings are counted in document order, as Word counts them. An
   `.unnumbered` heading (numId 0) is listed without a number and doesn't
   advance the count. With no reference document, or one that numbers no
   heading style, entries have no numbers. So design v3 shows `1`, `1.1`,
   `1.1.1` (#197), and an organisation's house style shows its own.

4. **Page numbers stay with the word processor.** A page number depends on
   page layout (fonts, page size, margins, keep-with-next, images and how
   every paragraph wraps), and only a layout engine knows it. Gantry has
   none, and guessing would print wrong numbers in a document that is meant
   to be reviewed and signed off. Word supplies them when it updates the
   field.

5. **ADR-0052's decisions stand.** The entries are raw OpenXML in the
   compiled Markdown, built in `compileArtefact`, so the native Pandoc
   render, the browser's pandoc-wasm, `gantry render` and every Provider get
   them with no change to Pandoc's arguments and no post-processing of the
   `.docx`. Only the Word conversion's Markdown is filled in. The exported
   `.md` keeps the placeholder field, because its anchors for `.unnumbered`
   headings exist only in the Word conversion. An Artefact without
   `table-of-contents: true` compiles exactly as before
   (`tests/frontMatterOffBaseline.test.js`).

Tests read the field's result from `.docx` files produced by native Pandoc
and pandoc-wasm (in Node, and in a real browser). They check it against the
headings and numbers the document itself shows, and check that each link
resolves to a bookmark on its own heading. LibreOffice isn't available in the
test environment and isn't added, so no test renders the document's pages.

## Amendment (#207): the classification in the page header

A design v3 document showed its classification once, on the cover. A
protective marking is normally carried in the page header of every page, as
Word does when a document is marked, so a reviewer reading page 12 can see
how the document must be handled. #207 adds that to design v3. The cover keeps
its classification line, and the footer is unchanged.

### Decision

1. **The header holds a field, not the value.** Pandoc copies a reference
   document's headers into the output byte for byte. That was checked on both
   render paths: the header parts of a design v3 SAD rendered with native
   Pandoc 3.1.3 and with pandoc-wasm's Pandoc 3.10 are identical to the
   reference document's. Raw OpenXML in the compiled Markdown reaches only the
   body, and it can't add a relationship to a new header part (ADR-0056). So a
   header can't carry a different literal value per document. Instead, each
   header holds a `STYLEREF "Cover Classification"` field. It prints the text
   of the cover's Cover Classification paragraph, the one this ADR's cover
   already writes. Word recalculates a STYLEREF field in a header each time it
   lays out the pages, as it does a page number, so it needs no "update
   fields" prompt.

2. **design v3's reference documents carry it.** The field is in the first
   paragraph of each of the three headers the documents define: default,
   first page and even pages. That paragraph is in a new `Header
   Classification` style, based on `Header`: centred, 8pt, grey (`595959`).
   Its other content, the coloured bars, the logo and Word's empty
   label-marking shapes, is unchanged. All seven documents share the same
   header parts and the same `styles.xml`. v3's section doesn't switch on a
   different first page or odd and even pages, so Word uses the default
   header on every page, the cover included. The other two headers carry the
   field so that an organisation that switches them on keeps the marking.
   design v1 and v2 are unchanged.

3. **The field's stored result is empty, and can't be made correct per
   document.** A Word field stores its last result next to its code, and a
   viewer that doesn't update fields shows that stored result. Here the
   stored result is part of the header, which Pandoc copies unchanged, so it
   is the same in every document. It can't be made to hold this document's
   classification without post-processing the `.docx`, which this ADR rules
   out. It is left empty, so a viewer that doesn't update fields shows an
   empty header, never another document's marking. The cover always shows the
   classification. Word, and any viewer that updates fields, shows it on
   every page.

4. **A blank classification still gives the field a paragraph to read.** With
   no paragraph in the `Cover Classification` style, Word prints "Error! No
   text of specified style in document." in place of a STYLEREF field. So,
   for the Word conversion only, an Artefact with `cover-page: true` whose
   `cover-classification` Field is blank opens its cover with a Cover
   Classification paragraph holding a single non-breaking space. The field
   finds it and prints nothing visible. The cover has an empty line where the
   classification would be. The exported `.md` still leaves the
   classification out, as the cover's own rule (decision 2 above) says.
   This is an engine rule, not a design v3 one: any Definition's cover with a
   blank classification gets the empty line in Word, whatever its headers
   hold. design v1 and v2 and recruitment-onboarding have no cover, so their
   documents are unchanged (`tests/frontMatterOffBaseline.test.js`).

### Consequences

- A Definition that uses design v3's reference documents for an Artefact
  without a cover, or without a `cover-classification`, gets Word's error
  text in the header, because nothing in the document has the style. It
  should delete the field from its reference document's headers.
- The tests read the `.docx` XML from both render paths: every page type's
  header has the field, in the Header Classification style, with an empty
  stored result and no other visible text; the body opens with the Cover
  Classification paragraph. Word's own layout isn't run in the test suite, so
  how Word prints the field, including that a non-breaking space prints as
  nothing, rests on Word's documented STYLEREF behaviour.
- An organisation restyles the marking by changing the `Header
  Classification` style, and moves or removes it by editing the headers in
  its own reference document. The same field can be added to a footer.

### Alternatives considered

- **Writing the value into the header after Pandoc runs.** Rejected:
  post-processing the `.docx` in Node and in the browser, which this ADR
  rules out.
- **A `DOCPROPERTY` field, or a content control bound to a document
  property, set from Pandoc metadata.** Rejected. The stored result is still
  the reference document's, so it doesn't fix viewers that don't update
  fields. Word doesn't recalculate a `DOCPROPERTY` field in a header on its
  own, and the value would need a metadata block in the compiled Markdown.
- **An `IF` field that hides Word's error text when there is no
  classification.** Rejected. The error text is in Word's display language,
  so a comparison against the English text fails in any other language.
- **Microsoft Purview sensitivity labels** (`MSIP_Label_*` custom document
  properties). Deferred. A label needs the organisation's tenant-specific
  label IDs, and a wrongly stamped label is a compliance issue. An
  organisation whose labels add their own header marking will see both, and
  should remove one: delete the field, or turn off the label's marking.

Status: accepted.

## Amendment (#209): the classification only in the page header

With #207, a design v3 cover printed its classification twice on the first
page: above the title and in the page header. #209 keeps it only in the
header.

### Decision

1. **The cover keeps its Cover Classification paragraph, printed
   invisibly.** The header's `STYLEREF "Cover Classification"` field
   (amendment for #207) needs a paragraph in that style to read, so the
   engine still writes it. design v3's seven reference documents now define
   the `Cover Classification` paragraph style: white (`FFFFFF`), 1pt, no space
   before or after, on an exact 1pt line. Pandoc uses a reference document's
   style of the same name rather than adding its own, so the paragraph is
   there for the field and shows nothing on the page. The engine and the
   exported `.md` are unchanged. design v1 and v2 don't define the style.

2. **Not hidden text.** Formatting the paragraph as hidden (`w:vanish`) would
   be the obvious way to remove it. It doesn't work: a STYLEREF field that
   finds text formatted as hidden shows blank, and doesn't look for the next
   visible text.

3. **The header field carries `\* CHARFORMAT`.** Its result then takes the
   formatting of the field's first character, which is the `Header
   Classification` style. It never takes the white 1pt of the text it copies.

### Consequences

- A viewer that doesn't update fields already showed an empty header (#207).
  Now it shows no classification anywhere, because the cover line is
  invisible. Word, and any viewer that updates fields, shows it on every
  page.
- The invisible text is still in the document. Copying the cover, searching
  it, or reading it with a screen reader finds the classification. That is
  harmless and arguably useful.
- An organisation that wants the classification above the title as well
  gives `Cover Classification` a visible size and colour in its reference
  documents.

### Alternatives considered

- **Hidden text.** Rejected: STYLEREF shows blank (decision 2).
- **Leaving the paragraph out of the Word conversion, with the header reading
  a document property.** Rejected for the reasons the #207 amendment gives
  against `DOCPROPERTY`: Word doesn't recalculate it in a header on its own,
  and its stored result is still the reference document's.
- **Moving the paragraph off the cover**, for example to the end of the
  document. Rejected: it would still print somewhere, and STYLEREF in a
  header searches from the start of the section, so the placement buys
  nothing.

Status: accepted.

## Amendment (ADR-0058): the classification comes from the Instance

ADR-0058 makes Classification an **Instance setting**: a list of markings
the Definition declares, and one chosen per Instance in the "+ New
Workspace" wizard, Instance Settings or MCP. Once a Definition declares
markings, the cover and the page header print the Instance's marking, and
the Artefact's `cover-classification` pointer is ignored. A Definition that
declares no markings keeps reading the Field `cover-classification` names,
exactly as this ADR describes, so a Definition copied into another Library
repo keeps its markings. The Definitions page stops offering the pointer,
and `invalid-cover-classification` validation stays.

Everything else here is unchanged: the cover's layout, a blank
classification printing nothing, and the header's `STYLEREF` field. #219
records this amendment, and #220 delivers it: the render reads the
Instance's `classification:`, and a cover whose marking is blank still gives
Word the invisible paragraph the header's field reads.
