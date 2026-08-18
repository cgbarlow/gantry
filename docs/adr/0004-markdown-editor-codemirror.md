# Markdown editing: CodeMirror 6 for the web front-end's rich-text fields

Gantry's planned web front-end needs a markdown-capable editor for
rich-text module fields, and a rendered preview is a hard requirement, not
a nice-to-have. `docs/research/markdown-editor-options.md` compared ten
candidates against primary sources (official docs, GitHub/npm metadata) on
four criteria: clean/unopinionated UX, active maintenance, popularity, and
— weighted above the brief's other three because of how gantry works —
whether the editor's native storage is plain Markdown text or a
proprietary AST/JSON model. Gantry captures content as YAML modules and
renders Word/Excel/PPT artefacts from that same text; an editor whose
`getValue()`/`setValue()` is a plain Markdown string round-trips through
that pipeline with no lossy conversion step, while an AST-based editor
(Tiptap, Milkdown, Lexical, ProseMirror) turns every save/load into a
potentially-lossy serialization.

We will use **CodeMirror 6** (`@codemirror/lang-markdown`) as the editing
core, with the rendered-preview requirement met by a small, independently
composed pipeline rather than a bundled feature: `EditorView.updateListener`
reads the current document text on change, `markdown-it` renders it to
HTML, and `DOMPurify` sanitizes that HTML before it's injected into a
sibling preview pane. All three are MIT/permissively licensed, popular, and
actively maintained in their own right (see the research doc's "Building a
rendered preview" subsection for the verified API details and citations).
CodeMirror's core is framework-agnostic, which matters because gantry
hasn't chosen a front-end framework yet — mature community wrapper packages
exist for React, Vue, Svelte, and Angular, so this choice doesn't foreclose
that decision.

Alternatives considered and rejected:

- **EasyMDE** — the fallback candidate. Also native raw-text, ships a
  preview pane out of the box (no DIY composition needed), but depends on
  legacy CodeMirror 5, which the CodeMirror project itself steers users
  away from in favour of CM6. Reconsider as primary if the CodeMirror
  6 + markdown-it + DOMPurify composition proves more work than its
  benefits justify once front-end work actually starts.
- **Tiptap, Milkdown, Lexical, ProseMirror (raw)** — all AST/JSON-native
  editors with a WYSIWYG editing surface. Rejected primarily for the
  lossy-round-trip risk against gantry's plain-text module pipeline, not
  for lack of maintenance or popularity (Tiptap and Lexical in particular
  are both large, active, and well-maintained).
- **Toast UI Editor** — dual markdown/WYSIWYG mode is arguably the
  cleanest out-of-the-box authoring UX of any candidate evaluated, but no
  release has shipped since 2023-02-17 (~3.5 years), which is disqualifying
  for the "well-maintained" criterion.
- **SimpleMDE** — effectively abandoned (last npm release 2016); superseded
  by its own fork, EasyMDE.
- **`@uiw/react-md-editor`** — native raw text with a built-in preview, but
  React-only, which locks in a framework choice gantry hasn't made yet.
- **Monaco Editor** — no AST, no framework lock-in, but built and shipped
  as a full multi-language code-editing component (~98 MB unpacked); wrong
  shape and weight for a single rich-text field.

Status: accepted, first-cut. Gantry has no front-end code yet — no
framework chosen, no `package.json`. This ADR fixes the editor engine and
preview-rendering approach ahead of that choice; revisit if the eventual
front-end framework has no maintained CodeMirror 6 wrapper (none currently
identified as a risk — see the research doc's community-bindings list) or
if building/maintaining the `markdown-it` + `DOMPurify` preview pane proves
more costly in practice than adopting EasyMDE's built-in one.
