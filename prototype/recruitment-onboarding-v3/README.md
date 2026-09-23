# recruitment-onboarding v3 — prototype (reference only, not for merge)

A complete, validated draft of recruitment-onboarding v3 carrying out every recommendation of the
v2 field review. It exists so the v3 tickets can start from a worked answer instead of a blank page.
The tickets and spec on GitHub are the source of truth; where they differ from this prototype, they win.

What is here:
- `definitions/recruitment-onboarding/3/` (repo root): definition.yaml, 14 modules, 8 templates
  (offer-pack replaced by appointment-confirmation; new onboarding-case), reference.docx, CHANGELOG.md.
- `instances/platform-engineer/`: the v2 worked hire with its module headings migrated to v3.
- `rendered/`: every v3 document rendered from that instance (dry run).
- `check.mjs` (validation + per-gate bare-set arithmetic) and `render.mjs` (gate check + dry-run render).

Known gaps, by design:
- `document-control: false`, `satisfies-gate: false` and `read-only-modules:` are not understood by the
  engine on main. Until the engine tickets land they are ignored, and publish/new-draft strip them.
- The rendered documents therefore still carry Document Control tables, and the gate check treats the
  audience documents as satisfying.
- No automated tests; the v3 tickets add them.

Running the harness from the repo root (Node 24):

    S=$(mktemp -d)
    cp -r definitions "$S/definitions"
    cp -r prototype/recruitment-onboarding-v3/instances "$S/instances"
    (cd prototype/recruitment-onboarding-v3 && node check.mjs "$S/definitions" 3 && node render.mjs "$S")
    ls "$S"/out-*.md
