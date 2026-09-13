# Visual editing stays inside CodeMirror, not a second WYSIWYG engine

WI #372. Gantry is adding a **Visual** view mode (Word/Loop-style editing over
module markdown, replacing the read-only Rendered mode, with the Split preview
pane editable too — see `CONTEXT.md`, *View mode*). The options analysis in
`docs/research/visual-editor-options.md` compared Milkdown, Tiptap, Lexical,
raw ProseMirror and a CodeMirror 6 live-preview approach on five criteria. The
decisive finding: every tree-based engine regenerates the whole document from
its own model on save — bullet and emphasis markers, backslash escapes, table
padding — with no "preserve untouched source" option, so keeping Pull Request
diffs clean would require a Gantry-written splice layer whose correctness we'd
own forever. CodeMirror is the only route where an unedited page saves
byte-identical by construction.

We chose the CodeMirror route: Visual mode is CodeMirror 6 decorations and
widgets that hide markdown syntax and render blocks inline (tables, images,
Mermaid) while the raw text remains the one document. This keeps ADR-0004 and
ADR-0017 in force rather than superseding them, and adds essentially no new
dependencies to the importmap. The cost, accepted knowingly: the Word-like
table experience — typing in cells, Tab between cells, add/remove rows and
columns, alignment — is built by us as widget-hosted editing over the existing
line-scanned table engine (ADR-0018), not bought; the one existing CM6
live-preview library is alpha with a single maintainer, so it is reference
material, not a dependency.

Status: accepted. Revisit only if the prototype (WI #373) shows widget-hosted
table editing cannot reach the Loop/Word bar set in `CONTEXT.md`.
