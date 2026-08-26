# Rich-text affordances are plain-text transforms over CodeMirror

The /instance editor's new formatting toolbar, keyboard shortcuts, Insert dropdown and table tooling all operate by transforming raw markdown text through CodeMirror transactions — using the lezer markdown syntax tree for smart toggling (re-pressing **B** unwraps; empty selection wraps the next typed text). No AST/rich-text editing layer is introduced; this is the direct consequence of ADR-0004's rejection of Tiptap/Milkdown-class editors to protect lossless round-trips against plain-markdown storage.

Tables remain GFM pipe tables. Loop-style behaviour is rebuilt as editor commands: insert via a hover-grid size picker, row/column add/delete and per-column alignment via a contextual control strip when the cursor is inside a table, Tab cycling cells, Enter at the last cell appending a row. The preview (markdown-it + DOMPurify) already renders GFM tables; rendered mode stays strictly read-only with all editing affordances hidden.

## Consequences

- Every new format feature is a deterministic text transform — nothing that can silently rewrite unrelated content.
- Table manipulation must parse pipe-table line ranges itself; malformed tables degrade gracefully (commands no-op) rather than "repairing" user text invisibly.
