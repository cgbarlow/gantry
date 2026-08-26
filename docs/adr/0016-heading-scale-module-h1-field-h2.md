# Document heading scale: module = H1, field = H2

With the markdown formatting toolbar arriving, the document heading hierarchy needed to match what users assume: 'Problem Statement' and the other module titles read as H1. We re-scale stored markdown so module titles are `#`, field headings are `##`, and author-typed content inside fields starts at `###` — the toolbar's Headings dropdown therefore begins at H3, since module/field headings are structural (written by the engine), never authored.

Existing instance files in the old scale (`##` module / `###` field) are lazily migrated on read — known heading levels are bumped and written back in the new scale — following ADR-0010's lazy-migration precedent. Artefact templates and the module-file parser/writer are updated to match.

## Considered options

- **Keep the old scale** (`##`/`###`) — rejected: it contradicts the user-facing hierarchy expectation ('Problem Statement' is not the top of its document) and burns a heading level for no benefit.
- **No migration, accept both scales** — rejected: two coexisting scales means every consumer (parser, templates, preview, toolbar logic) branches forever.
