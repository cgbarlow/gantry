# Word formatting lives in the reference document, and `.unnumbered` headings switch numbering off

#197, part of spec #192 (design v3), from review items GF-003, GF-004, GF-014
to GF-017 and GF-024 in #191. Follows docs/adr/0052 (the cover page and table
of contents, built in the shared compile step without changing either render
path's Pandoc arguments).

A reviewer of a `design` v2 Solution Architecture Document found its Word
output wasn't production-ready. Headings had no numbers. A heading or caption
could be left at the bottom of a page, apart from what it introduced. Table
headers had no styling, and table rows split across page breaks. The architect
fixed all of it by hand before every review.

The spec asked for the fixes to be made in v3's reference Word documents, and
for row-splitting to be tried in the table style first. Only if Word ignores
it there should a mechanism shared by both render paths (native Pandoc for the
CLI and server, pandoc-wasm in the browser) be added, never post-processing.
This records what was needed, and the one thing a style can't do.

## Decision

1. **Every rule is a style in the reference document.** design v3's seven
   reference documents share one `styles.xml` and one `numbering.xml`:
   - Heading 1 to 3 are attached to one multilevel list, `1`, `1.1`,
     `1.1.1`. Heading 4 to 6 aren't numbered. The Word TOC field lists levels
     1 to 3, so it shows the same numbers.
   - Heading 1 to 6, Caption, Table Caption, Image Caption, Figure and
     Captioned Figure keep with the next paragraph.
   - The `Table` style, which Pandoc gives every table, has a dark neutral
     header row (`404040`, white bold text), a light grid, an explicit font
     size, and `<w:trPr><w:cantSplit/></w:trPr>`. `Compact`, the paragraph
     style Pandoc gives table cells, has the same explicit size. Word lets a
     paragraph style's size override a table style's, so both carry it.
   - `TOC Heading`, which is based on Heading 1, has its numbering switched
     off.

   An organisation's own reference document replaces all of it, so a house
   style needs no change to Gantry.

2. **Rows that don't split stay in the table style. No filter is added.**
   ISO/IEC 29500 makes a table style's row properties the default for every
   row in a table of that style: a row with no `cantSplit` of its own takes
   the style's. Word's object model has the same setting on a table style,
   `TableStyle.AllowBreakAcrossPage` ("whether lines in the rows of tables
   formatted with a specified style break across pages"). Pandoc can't mark a
   row either way. Neither Pandoc 3.1.3 nor pandoc-wasm's 3.10 writes
   `cantSplit`, and Pandoc's document tree has no row property a Lua filter
   could set. So a row-level mechanism would have had to post-process the
   `.docx`, which the spec rules out. Header rows already repeat: both
   Pandocs write `tblHeader` on a table's header row. Tests read the `.docx`
   from both render paths and check that every table uses the `Table` style,
   that its first row repeats as a header, that no row allows a split, and
   that the document's own `Table` style says rows can't split.

3. **A heading marked `.unnumbered` is written with its numbering switched
   off.** Numbering attached to Heading 1 to 3 numbers every paragraph in
   those styles. That includes the Document Control and Review & sign-off
   headings, which come before section 1. Pandoc's Markdown already has a way
   to say "don't number this one": the `.unnumbered` class, or its shorthand
   `{-}`. Pandoc's Word writer ignores it, because Pandoc only numbers
   sections with its own `--number-sections` text, never with a Word list.
   So the shared compile step (`compileArtefact` in `lib/render.js`) writes
   each `.unnumbered` ATX heading, in the Markdown for the Word conversion
   only, as the same heading paragraph in raw OpenXML with `numId` 0. Word
   honours that whatever the reference document numbers. This is ADR-0052's
   mechanism: raw OpenXML in the compiled Markdown reaches both render paths
   unchanged, with no change to either's arguments. design v3 ships its own
   `templates/_documentControl.md.tmpl`, the v1 partial with both headings
   marked `{.unnumbered}`. The cover's Title and Subtitle aren't heading
   styles, and `TOC Heading` is switched off in its style, so neither needs
   the class.

   The step applies to every Artefact, because the class means the same
   thing everywhere. Where the reference document numbers nothing, the
   heading looks exactly as before. No bundled template or example except
   design v3's partial uses the class, so v1, v2 and recruitment-onboarding
   convert exactly as they did.

## Consequences

- The exported `.md` keeps the headings as authored, `{.unnumbered}`
  included. Only the Word conversion's Markdown changes.
- An `.unnumbered` heading reaches Word as plain text with no anchor of its
  own. Inline formatting in it (bold, code, a link) shows as typed, and an
  internal link to it has nowhere to land. That is fine for front-matter
  headings. The User Guide tells authors to keep such headings plain.
- Fenced code blocks are skipped, so a heading-like line inside one is left
  alone.
- The tests check what Word reads in the `.docx` (styles, numbering, row
  and paragraph properties), not how Word draws it. Word's page layout isn't
  run in the test suite.

## Alternatives considered

- **A Lua filter shipped beside the reference document.** Rejected. A filter
  edits Pandoc's document tree, which has no row or numbering property to set.
  A Lua custom writer could rewrite the `.docx` inside Pandoc, but that is
  post-processing by another name. It would also need a new definition file
  carried through every copy, publish, promote and Local Workspace flow, and a
  new argument on both render paths.
- **Post-processing the `.docx`** in Node and in the browser to add
  `cantSplit` to every row and `numId` 0 to the front-matter headings.
  Rejected for ADR-0052's reasons: a second step in two runtimes, and the spec
  rules it out.
- **Writing the Document Control headings as raw OpenXML in v3's partial.**
  Rejected. The exported `.md` would lose its `## Document Control` heading.
  The class keeps the Markdown readable and works for any heading an author
  marks.
- **Starting the numbering at Heading 1 only, or giving the front matter a
  non-heading style.** Rejected. Document Control is a Heading 2 before the
  first Heading 1, so Word would number it "0.1". A non-heading style would
  take it out of the navigation pane and change the `.md`.

Status: accepted.
