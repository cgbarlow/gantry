# Reading reviewers' comments back from a Word document Gantry rendered

Research for [#250](https://github.com/cgbarlow/gantry/issues/250), part of map [#238](https://github.com/cgbarlow/gantry/issues/238) (v0.13.0 AI interview). It feeds the design ticket [#251](https://github.com/cgbarlow/gantry/issues/251). Researched 2026-11-02.

**Question.** Can Gantry read a reviewer's comments and tracked changes from a `.docx` it rendered, and trace each one back to the Instance, Stage, Module and Field it sits on? What do pandoc and `officeparser` give back? Does the render already mark where each Field starts, and if not, what could it embed that survives Word, SharePoint and Google Docs? How is a returned document matched to the render it came from, and what happens when content has changed since? What about comments on the cover, Document Control, diagrams, or across Fields?

Claims marked **(tested)** come from hands-on tests in this session, described in [Appendix A](#appendix-a--hands-on-tests). Everything else links to its source.

---

## TL;DR

- **Yes, it can be done, with one small change to the render and a small reader of our own.** Today's render leaves no Field markers. Headings are the only structure, and many Fields share a heading or sit under none.
- **Anchor each Field with a Pandoc Div or Span carrying an identifier.** Pandoc writes it as an invisible Word bookmark around exactly that Field's paragraphs, or around a table cell's text. The output is byte-identical apart from the bookmarks **(tested)**. It works the same in native pandoc 2.17 and pandoc-wasm 3.10 **(tested)**. No change to the `.docx` after Pandoc, so ADR-0056 holds.
- **Label the document with custom document properties**: Instance, Artefact, Stage, Definition version, the commit the content was at, and a render id. Pandoc writes any extra root-level metadata as a custom property ([pandoc manual](https://pandoc.org/MANUAL.html#metadata-variables)) **(tested)**. These survived a real Google Docs import and export **(tested)**. They are invisible in the page but can be seen under File > Properties.
- **Read the returned file ourselves, not through pandoc or officeparser.** Neither returns everything we need:
  - **Pandoc** (`--track-changes=all`) returns comment text, author, date, start and end, and insertions and deletions. It **drops our bookmarks** (orphan anchors are removed), **ignores replies and resolved status**, drops comments that have no range, and moves the cover title into metadata **(tested, and in source)**.
  - **officeparser** 8.4.1 returns comments with author and date. It attaches each comment only to the run where it ends. It **reads tracked insertions as ordinary text and drops deletions**. It gives DOCX comments no reply link. It shows a bookmark only on the paragraph where it starts **(tested, and in its README)**.
  - A small OOXML walker in the browser gets all of it: comment ranges, threads, resolved flag, tracked changes with author and date, bookmark ranges, heading styles and table cells. Gantry already has a browser zip reader (`web/lib/definitionLogo.js`), and the browser has `DOMParser`.
- **Google Docs keeps comments, tracked changes and custom properties. It renames every bookmark to a random id and collapses it to a point. It also dropped a resolved comment thread** **(tested)**. So bookmarks can't be the only anchor. The fallback is to **align the returned text against the original render**, which Gantry can rebuild from the commit stored in the properties. Heading styles survived Google Docs, which helps the alignment **(tested)**.
- **Changed since render:** compare the stored commit with the Stage's current content, Field by Field. An unchanged Field takes the comment as it is. A changed Field shows the comment beside both the text the reviewer saw and today's text.
- **Edge cases have clear homes.** A comment on the cover, Document Control, Review & sign-off or table of contents is about the document, not a Field. A comment that spans Fields belongs to the first and lists the rest. A comment on a diagram or its caption belongs to the Field that holds the diagram's source. A comment on a template heading goes to the Field(s) under it, and the heading text is the Definition's to change.

---

## 1. What the readers give back

Test document: a Gantry-shaped render with a cover title, a Document Control table, two block Fields, a diagram with caption, and an inline Field. Comments were added on each, plus a reply, a resolved thread, a comment spanning two Fields, a comment with no range, tracked insertions, a tracked deletion and a whole inserted paragraph. See [Appendix A](#appendix-a--hands-on-tests).

### pandoc (pandoc-wasm 3.10 in the browser; native 2.17 on the server)

`--track-changes` "Specifies what to do with insertions, deletions, and comments produced by the MS Word 'Track Changes' feature … `all` includes all insertions, deletions, and comments, wrapped in spans with `insertion`, `deletion`, `comment-start`, and `comment-end` classes … Both `accept` and `reject` ignore comments" ([pandoc manual, `--track-changes`](https://pandoc.org/MANUAL.html#option--track-changes)).

| Item | What comes back **(tested, 3.10 and 2.17 alike)** |
|---|---|
| Comment text, author, date | Yes. A `comment-start` span holds the comment's text and carries `id`, `author` and `date`. A multi-paragraph comment comes back joined with a line break. |
| Anchored text | Yes. It is the text between `comment-start` and the matching `comment-end`, even across paragraphs and headings. |
| Replies | **No link.** A reply comes back as one more `comment-start` on the same text, with no parent. The reader reads only `word/comments.xml` ([`Parse.hs` `archiveToComments`](https://github.com/jgm/pandoc/blob/3.10/src/Text/Pandoc/Readers/Docx/Parse.hs#L551)). It never opens `commentsExtended.xml`. |
| Resolved ("done") | **No.** The flag lives in `commentsExtended.xml` (below). |
| Comment with no range (only a `commentReference`) | **Dropped.** The reader starts a comment at `commentRangeStart` ([`Parse.hs` L1200](https://github.com/jgm/pandoc/blob/3.10/src/Text/Pandoc/Readers/Docx/Parse.hs#L1200)). |
| Insertions and deletions | Yes, with author and date. A whole inserted paragraph also gets a `paragraph-insertion` marker. |
| `accept` / `reject` views | Yes. `reject` rebuilds the text as Gantry rendered it, provided every edit was tracked. `accept` gives the reviewer's proposed text. |
| Comment on a table cell | Yes, inside the table cell. |
| Comment on an image, or on a caption | Yes, around the image, or around the caption paragraph. |
| Comment on the cover title | **Moved into `meta.title`.** Pandoc reads a paragraph in the `Title` style (and `Subtitle`) as document metadata, not body text. Gantry's cover uses `custom-style="Title"` and `"Subtitle"` (`lib/render.js` `buildCoverPageMarkdown`). |
| Our bookmarks | **Dropped.** Heading identifiers come back. A bookmark nothing links to is removed ([`removeOrphanAnchors`](https://github.com/jgm/pandoc/blob/3.10/src/Text/Pandoc/Readers/Docx.hs#L887)). The reader keeps only where a bookmark starts, not where it ends ([`Parse.hs` L1177](https://github.com/jgm/pandoc/blob/3.10/src/Text/Pandoc/Readers/Docx/Parse.hs#L1177)). |

### officeparser 8.4.1 (the extractor #240 chose for Source documents)

| Item | What comes back **(tested)** |
|---|---|
| Comment text, author, date, initials, id | Yes, on `node.comments[]` of a text run node ([README, "Extract comments"](https://github.com/harshankur/officeParser#extract-comments)). |
| Anchored text | **Partly.** The comment hangs on the run just before its end marker. A comment spanning two paragraphs appeared only on the second paragraph's run, with no sign of where it began. |
| Replies, resolved | **No** for DOCX. The README gives `parentId` for "a PowerPoint reply" only ([README, capability notes](https://github.com/harshankur/officeParser#per-format-capability-matrix)). |
| Comment with no range | Yes. It is attached to the last run. |
| Tracked changes | **Lost.** "Text a tracked change deleted or moved away (DOCX, ODT) is not read; insertions are" ([README](https://github.com/harshankur/officeParser)). Inserted text comes back as ordinary text, with no author or date. |
| Bookmarks | **Start only.** `metadata.anchorIds` appears on the paragraph where a bookmark starts. Later paragraphs inside the same bookmark carry nothing. |
| Custom properties | Yes, in `metadata.customProperties`. |
| Cover title | Kept as a `heading` node with `style: "Title"`, and its comment is kept. |

officeparser is still right for turning a returned document into text for the AI. It is not enough to place comments and changes on Fields.

### Reading the OOXML directly

All of the data is in a handful of parts, read in document order:

- `word/document.xml`. `w:commentRangeStart` / `w:commentRangeEnd` / `w:commentReference` mark where each comment sits. `w:ins` / `w:del` (with `w:author` and `w:date`) and a paragraph mark's `w:rPr/w:ins` mark tracked changes. `w:bookmarkStart` / `w:bookmarkEnd` give a bookmark's range. `w:pStyle` gives headings, and `w:tbl/w:tc` gives cells.
- `word/comments.xml`. One `w:comment` per comment, with `w:id`, `w:author`, `w:date`, `w:initials` and the body paragraphs.
- `word/commentsExtended.xml` (Word 2013+). One `w15:commentEx` per comment, keyed by the `w14:paraId` of the comment's last paragraph. `w15:paraIdParent` links a reply to its parent, and `w15:done="1"` marks the thread resolved ([MS-DOCX §2.5.3.1 CT_CommentEx](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-docx/); [python-docx comments analysis](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/comments.html)).
- `word/commentsIds.xml` (`w16cid:durableId`) gives each comment an id that stays stable across saves in Word. It is useful to spot the same comment in two uploads. Google Docs doesn't write it **(tested)**.
- `docProps/custom.xml` holds the custom properties.

A walker that keeps a set of "open" bookmarks, comments and changes as it goes gives each comment and change the list of Field bookmarks it overlaps. In the browser this needs the zip reader Gantry already has (`readZip` in `web/lib/definitionLogo.js`, using `DecompressionStream('deflate-raw')`) and `DOMParser`. No new dependency is needed.

---

## 2. Does the render already mark where each Field starts?

**No.** How the render works today:

- An Artefact's `.md.tmpl` (Eta) lays out headings and drops Field values straight in, e.g. `<%~ na(it.modules['hld-submission']['decision-requested']) %>` (`definitions/design/3/templates/hld.md.tmpl`). Pandoc turns that into a `.docx` with the reference document's styles. The native path is `lib/render.js` (`execFileSync('pandoc', …)`); the browser path is `web/lib/pandocWasm.js` (`renderDocxWithWasm`).
- Headings get bookmarks from their identifiers. That is how the table-of-contents prefill links to them (`pandocBookmarkName`, `prefillTableOfContents` in `lib/render.js`). Templates own the headings, not the Fields. Several Fields can share one heading: `hld` puts `nfrs.performance` and `nfrs.availability-and-continuity` under "Non-functional requirements". A Field can also sit straight under an H1 (`proposed-solution.guardrails`), in a table cell (`soap-full`'s `| Epic/Project | <%~ … %> |`), or inside a sentence.
- No custom properties are written today, and the Markdown has no metadata block.
- The paragraph styles are Pandoc's defaults (First Paragraph, Body Text, Compact, Image Caption, Captioned Figure) plus the cover's `Cover Classification`/`Cover Details`/`Cover Purpose`. None of them names a Field.

So the heading a comment sits under gives a section, not a Field.

### What the render could embed cheaply and invisibly

| Option | Invisible? | Survives Word | Survives Google Docs | Cost |
|---|---|---|---|---|
| **Div/Span with an id → bookmark** around each Field value | Yes, unless the reader turns on "Show bookmarks" | Expected to (it is Word's own feature); see the caveat below | **No.** Renamed to random ids and collapsed to points **(tested)** | Small. Wrap values at compile time. Output is otherwise byte-identical **(tested)** |
| **Custom document properties** (render identity) | Yes, unless someone opens File > Properties | Yes. Word's Document Inspector removes them if run ([Microsoft support](https://support.microsoft.com/en-us/office/remove-hidden-data-and-personal-information-by-inspecting-documents-presentations-or-workbooks-356b7b5d-77af-44fe-a07f-9aa4d085966f)) | **Yes (tested)** | Tiny. A metadata key per value |
| A custom paragraph style per Field | Shows in the Styles pane | Yes | No. Google maps unknown styles to Normal text **(tested)** | Pollutes the reference document's style list |
| Content controls (`w:sdt` with a tag) | Shows a box on hover in Word | Yes | Not tested; Google Docs has no equivalent | Pandoc can't write them except as raw OpenXML |
| Hidden text or zero-width markers in the body | Risky: they show in other viewers and get copied | Fragile | Unknown | Pollutes the text the AI and readers see |
| Nothing embedded; align text to the original render | n/a | n/a | Yes | Needs the original render's text and a Field map, which Gantry can rebuild (§3) |

**Recommended: bookmarks plus custom properties, with text alignment as the fallback.**

Details for the bookmarks:

- **How Pandoc writes them.** It wraps a Div's or Span's content in `w:bookmarkStart`/`w:bookmarkEnd` ([`wrapBookmark`](https://github.com/jgm/pandoc/blob/3.10/src/Text/Pandoc/Writers/Docx/OpenXML.hs#L1119)). For a block Field the bookmark runs from before its first paragraph to after its last, including lists, images and captions. For a Span it sits around the runs inside one paragraph or cell **(tested)**.
- **Names.** A Word bookmark name must "begin with a letter" and can include "both numbers and letters, but not spaces", with underscores as separators ([Microsoft support](https://support.microsoft.com/en-us/office/add-or-delete-bookmarks-in-a-word-document-or-outlook-message-f68d781f-0150-4583-a90e-a4009d99c2a0)). Pandoc replaces an identifier longer than 40 characters, or one not starting with a letter, with `X` + SHA-1 (`pandocBookmarkName` in `lib/render.js` mirrors this). Field paths like `hld-submission.authors-and-contributors` contain `-` and `.`, which Word's own dialog would refuse, and can pass 40 characters with a prefix. Use a short name that is valid in Word and the same on every render, e.g. `gf_` + 8 hex characters of a hash of `module/field`. Gantry can recompute it from the Definition, so the document needs no lookup table. Pandoc kept `gf_3f9a1c2e` unchanged **(tested)**.
- **Caveat: not tested in desktop Word or Word for the web.** Pandoc puts a block Div's bookmark at body level, between paragraphs, which the schema allows. Pandoc's own source notes that Word writes a heading's bookmark *inside* the paragraph (OpenXML.hs comments, #11845). Word may move a body-level bookmark when it saves. Range bookmarks are a core Word feature, so this is expected to work, but the build should confirm it with a manual round trip through Word, Word for the web/SharePoint and Google Docs. Deleting all of a bookmark's text deletes the bookmark (Word behaviour; see "select the item, and then press Delete" in the support article above). That case is the "changed" path in §3 anyway.

Details for the custom properties:

- **Writing them.** "Any root-level string metadata, not included in ODT, docx or pptx metadata is added as a *custom property*" ([pandoc manual](https://pandoc.org/MANUAL.html#metadata-variables)). Pass them as `metadata` in pandoc-wasm's options and `-M key=value` on the native command line. The template text doesn't change.
- **Keys.** Suggested: `gantry-instance`, `gantry-artefact`, `gantry-stage`, `gantry-definition` (id@version), `gantry-commit` (the content's commit), `gantry-render` (a render id: timestamp plus random) and `gantry-version` (Gantry's version). Keep values short: one identifier each, not a Field map.
- **What can strip them:** Word's Document Inspector (the "Custom tab" is in the "Document Properties and Personal Information" check, [Microsoft support](https://support.microsoft.com/en-us/office/remove-hidden-data-and-personal-information-by-inspecting-documents-presentations-or-workbooks-356b7b5d-77af-44fe-a07f-9aa4d085966f)); copying the content into a new document; or printing to PDF and converting back.
- **SharePoint** promotes and demotes only "document properties that match list columns that apply to the document" ([SharePoint property promotion and demotion](https://learn.microsoft.com/en-us/previous-versions/office/developer/sharepoint-2010/aa543341(v=office.14))). It leaves `gantry-*` keys alone unless a library has columns with those names. SharePoint does rewrite the package on upload (a [Microsoft Q&A thread](https://learn.microsoft.com/answers/a/12240070) reports changed bytes on re-upload). **So never match a returned file by its hash.**

---

## 3. Matching a returned document to its Instance, Stage and render

| Signal | Trust | Notes |
|---|---|---|
| **Custom properties** (`gantry-instance`, `-artefact`, `-stage`, `-commit`, `-render`) | High | Machine-readable. Survived Google Docs **(tested)**. Lost only if someone strips them or copies the content into a new document. |
| Document Control block (Version, Date, Commit, Status) | Medium | Readable text in a table (`buildDocumentControlMarkdown`). A reviewer can edit it, and it is missing when the Artefact sets `document-control: false` (e.g. an Offer Pack). Useful to confirm a match, or to recover when the properties are gone. |
| Filename (`<Instance name> - <Artefact title>` or the Artefact's Filename pattern) | Low | Reviewers rename files ("HLD v2 – RR comments.docx"), and the name changes with content anyway (ADR-0045). Use it only as a hint. |
| Headings and text | Fallback | Align against each candidate render. Works even with no properties, but is slower and needs the architect to confirm. |

**Recommendation.**
1. Read the properties. If `gantry-instance` isn't the Instance the architect is uploading into, say so and stop, or offer to treat the file as a Source document.
2. With no properties, fall back to the Document Control commit, then the filename, then ask the architect to confirm the Artefact.
3. Rebuild what the reviewer saw by compiling that Artefact's `docxMarkdown`, with Field markers, from the Instance content at `gantry-commit`. For a workspace kept in a repo the content is in git history. That gives the paragraph-to-Field map without storing anything new.
   - **Exception:** a render with no commit. The Document Control commit cell can be blank, and a server-hosted directory instance renders without a commit of its own (`deliverToClient`). Those renders need the render's Field map saved next to the render, or must rely on the bookmarks alone.
   - **Open question:** this is the one case where the planned **Render manifest** (#88) could also record a render id and its Field hashes.

**When content has changed since the render.** Compare each Field's value at `gantry-commit` with its value now:

| Case | What Gantry does |
|---|---|
| The Field is unchanged | Place comments and changes on it as they are. A tracked change can be offered as the proposed edit. |
| The Field changed since the render | Show the comment beside the text the reviewer saw (from the commit) and today's text. The AI asks whether it still applies or has already been handled. Don't apply the reviewer's tracked change automatically; it was made against old text. |
| The Field or Module is no longer in the Artefact, or the Definition version changed and the Field is gone | The comment has no Field. Put it in a "couldn't place" list for the architect. |
| The comment's text can't be found, e.g. after untracked edits and lost bookmarks | Place it by the nearest heading and mark it low confidence. |
| Two reviewers' copies of the same render are uploaded | Same `gantry-render` id: merge them. Remove duplicate comments by `durableId` where present, else by author, date and text. |
| A reviewer edited without Track Changes | Spot it by comparing the `reject` view (or the untracked text) with the original render, and list it as "unmarked edits", with lower confidence than a tracked change. |

---

## 4. Edge cases

| Where the comment is | What it is about | How to place it |
|---|---|---|
| **Cover page**: title (Instance display name), document type (Artefact title), version, status, author (Assignee), purpose (`cover-purpose`) | Instance settings, the Definition, or Gantry's Document Control values. **Not a Field.** | "About the document" list. Exception: an old-style `cover-classification: module.field` cover line *is* a Field (ADR-0058 fallback), so give that line a Span bookmark too. |
| **Document Control / Review & sign-off tables** | Values Gantry supplies (version, commit, status, reviewers). **Not a Field.** | "About the document". The AI explains it can't change these; they follow from the process. |
| **Table of contents** | Generated | "About the document". |
| **Template heading** (e.g. "Decision requested") | The Definition's text | Place it on the Field(s) under that heading; with Field bookmarks, the next Field bookmark. Note that a heading's wording belongs to the Definition's author. |
| **Comment spanning two or more Fields** | Several Fields | The walker gives every Field bookmark the range overlaps. Make the first one the owner and list the others, so it is answered once. Pandoc showed such a comment's start and end correctly across a heading **(tested)**. officeparser lost the start **(tested)**. |
| **Diagram image or its caption** | The Field holding the Mermaid source or the image reference | Both sit inside the Field's bookmark **(tested)**. The caption text "Diagram N. <title>" comes from `numberDiagrams` and the fence's title. The AI has to change Mermaid source or ask for a new image; it can't edit the picture. |
| **Placeholder of a blank Field** (`na()` output) | The empty Field | Put `na()`'s placeholder inside the Field's wrapper so a comment like "please fill this" lands on the blank Field. |
| **Inline Field, or Field in a table cell** | That Field | Use a Span, which becomes a bookmark inside the paragraph or cell. A multi-line value can't go in a pipe-table cell anyway. |
| **List Field** (`forEach` in templates) | The list Field | Wrap the whole list in one Div. The template's loop decides the item markup, so it can't be wrapped per value. |
| **A comment with no range** | Wherever it sits | Word normally anchors a comment to a selection or the word at the cursor. Google anchored our range-less comment to the next character **(tested)**. Treat it as a point and use the enclosing Field. |
| **Replies and resolved threads** | The same Field as the parent | Fold replies into their thread. A thread resolved in Word can be shown as "resolved by the reviewer" and skipped by default. **Google Docs lost the resolved thread entirely (tested)**. |
| **Text in headers or footers** | From the reference document | Not a Field. "About the document". |

---

## 5. What a round trip through each tool keeps

| Tool | Comments | Replies / resolved | Tracked changes | Bookmarks | Custom properties | Heading styles |
|---|---|---|---|---|---|---|
| Pandoc writes (2.17 and 3.10) | n/a | n/a | n/a | Written, names as given **(tested)** | Written **(tested)** | Written |
| **Google Docs** (import, then download as .docx) | Kept; author, date, multi-paragraph text and anchor kept; ids renumbered **(tested)** | **Resolved thread and its reply dropped (tested)**; no `commentsExtended.xml` written | Kept as `w:ins`/`w:del` with author and date, including the paragraph mark **(tested)** | **Names replaced with random 12-character ids; ranges collapsed to points; some moved to paragraph boundaries (tested)** | **Kept (tested)** | Title, Heading 1 and Heading 2 kept; Pandoc's body styles became Normal **(tested)** |
| Word (desktop, web) | Native | Native (`commentsExtended`) | Native | Expected to keep them; **not tested here** | Kept; removed by the Document Inspector ([Microsoft support](https://support.microsoft.com/en-us/office/remove-hidden-data-and-personal-information-by-inspecting-documents-presentations-or-workbooks-356b7b5d-77af-44fe-a07f-9aa4d085966f)) | Native |
| SharePoint library | Not affected | Not affected | Not affected | Not affected | Promotes/demotes only properties that match library columns ([Learn](https://learn.microsoft.com/en-us/previous-versions/office/developer/sharepoint-2010/aa543341(v=office.14))); package bytes may change | Not affected |

---

## 6. What it means for the build

1. **Render (small):**
   - Wrap each Field value in the Word conversion's Markdown (`docxMarkdown` only, never the exported `.md`). A block value gets `::: {#gf_xxxxxxxx}`; a value inside a line or cell gets `[…]{#gf_xxxxxxxx}`. Include `na()`'s placeholder.
   - **Open design point:** templates read `it.modules` directly, so the wrapping needs one of two approaches. Either a helper that templates call (like `na()`), which means touching every Definition's templates. Or wrapping at compile time: compile with marker-wrapped values, then turn markers that occupy a whole block into a Div, one-line inline markers into a Span, and drop the rest. The Filename pattern, cover and conditions must see unwrapped values.
   - Add the `gantry-*` custom properties through metadata on both render paths.
   - Diagram numbering, the TOC prefill and `unnumberedHeadingsForWord` work on the same Markdown, so they need a test that Divs don't disturb them.
2. **Reader (medium):** an OOXML walker in `web/lib/`. Its output is a list of comment threads and tracked changes, each with author, date, anchored text, the Field bookmarks it overlaps, the nearest heading and its place in the document, plus a list of what couldn't be placed. Use pandoc-wasm or officeparser only to turn text into Markdown for the AI, not to place anything.
3. **Fallback alignment (medium):** rebuild the original `docxMarkdown` with markers from `gantry-commit`, and align it paragraph by paragraph with the returned document's `reject` view text. This matters for Google Docs, where the bookmarks are lost.
4. **Matching and the changed-since-render check (small):** read the properties, check the Instance, and compare Field values at the commit with today's.
5. **Tests:** the docs/test fixtures need a Word-saved and a Google-exported `.docx`. Build each once by hand (Appendix A shows how the round trip was done) and commit it as a fixture. Before the build closes, do one manual round trip through desktop Word and Word for the web.
6. **Privacy:** reviewer names and comment text are personal data and will reach the AI Provider. #251 should say whether the uploaded document is kept, and whether author names go to the AI or are replaced with "Reviewer 1".

---

## Appendix A — hands-on tests

Scripts were throwaway, kept in the session scratchpad.

1. **Render.** A Markdown file with a `custom-style="Title"` cover line, a Document Control pipe table, two block Fields wrapped in `::: {#…}` (one named `gf_3f9a1c2e`), a diagram (`![Diagram 1. Context](diag.png)`) inside a Div, an inline Field `[Visa and Mastercard]{#gf.nfrs.schemes}`, and YAML metadata `gantry-instance`, `gantry-stage`, `gantry-render-id`. Converted with pandoc-wasm 1.1.0 (pandoc 3.10) in Node via `convert({from:'markdown',to:'docx'})`, and with native pandoc 2.17.1.1.
   - Both wrote a bookmark per Div or Span. Block Divs got range bookmarks from before the first paragraph to after the last, spanning several paragraphs and the image plus caption. The Span's bookmark sat inside the paragraph.
   - `docProps/custom.xml` held the three `gantry-*` properties.
   - A second check compared a document with Divs and Spans (paragraphs, list, table cell) against the same content without them. Apart from the bookmarks, `document.xml` was identical.
2. **Review markup.** Python edited `document.xml`, `comments.xml` and a new `commentsExtended.xml`. It added: a comment on part of a Field plus a reply (thread marked `done`); a comment from one Field into the next across a heading; comments on the cover title, a Document Control cell, the image and its caption, and the inline Field; a comment with no range; a tracked deletion and insertion; and a whole tracked-inserted paragraph.
3. **pandoc read back.** `--track-changes=all|accept|reject` to Markdown and JSON, on 3.10 and 2.17. The results are in the §1 table. Our `gf*` bookmarks were absent from the AST, and heading ids were present. The cover comment appeared in `meta.title`. Replies had no parent, and the range-less comment was missing.
4. **officeparser 8.4.1** `parseOffice(file)`. The results are in the §1 table.
5. **Google Docs round trip.**
   - Uploaded through the Google Drive API with conversion to a Google Doc, exported as `.docx`, and the test file was trashed afterwards.
   - **Kept:** custom properties; 7 of 9 comments, with author, date and multi-paragraph bodies; the cross-Field range; the image and caption comments; tracked changes with author and date; the Title/Heading 1/Heading 2 styles.
   - **Lost or changed:** the resolved thread (parent and reply); all bookmark names (now `al07iqog7ysd` and similar, as point bookmarks); Pandoc's body styles. The range-less comment gained a range on the next character.
   - **Not established:** whether Google drops resolved comments on import or on export.
