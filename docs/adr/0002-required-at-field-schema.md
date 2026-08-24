# Module field schema: `required-at` for gate-scoped requiredness

A module can be required at more than one gate — `nfrs` and `security` are both required at `hld-tac-approved` and again at `build-ready-checklist`, and are meant to be filled in progressively: lightly at the first gate, completely by the second. Until now that expectation lived only in prose (each module's `purpose:` text, and individual fields' `guidance:` text). A 2026-08-18 gap review against the real Contoso source templates confirmed the prose was accurate intent, but nothing enforced it: the field schema's `required: true|false` is a single value applied wherever the module appears, so a `gantry check --gate hld-tac-approved` and a `gantry check --gate build-ready-checklist` would apply identical requiredness to the same shared field. There was no way for the schema to say "optional here, required there."

We added `required-at: [gate-id, ...]` as an alternative to `required` on a field: the field is required at exactly the listed gates, and optional at any other gate the module is also required at. `required` and `required-at` are mutually exclusive on a field.

Alternatives considered and rejected:

- **Leave it as prose-only convention.** Cheapest, but this is exactly the gap the 2026-08-18 review flagged — an instance could pass `build-ready-checklist` with only the light `hld-tac-approved` version of `nfrs`/`security` filled in, because the schema can't tell the difference from "complete."
- **A full `required` map (`{gate-id: true|false}`) instead of an allow-list.** More symmetrical, but every real case so far is "optional early, required later" — a bare list of the gates it becomes required at says the same thing with less repetition. Revisit if a field ever needs to be required early and optional later, which hasn't come up.
- **Split the field, or the module, per gate** (e.g. `nfrs` / `nfrs-detailed`). Rejected for the same reason `docs/adr/0001` rejected duplicating modules across gates: it re-introduces the restate-with-drift problem Gantry exists to remove, and the `CONTEXT.md` "module completeness by gate, not by authorship" entry already commits to one module, not two.

This repo currently *is* the module-spec schema's definition — there is no separate engine codebase yet (README: "the engine, definition schema and design definition are under active development. Treat the definition schema as unstable until v0.1"). So this is a schema change made directly in the schema's only current home (README.md's "Module specs" section), applied immediately to `nfrs.yaml` and `security.yaml`. `risks.yaml` didn't need it: `risk-register` is required at both gates unchanged (only its expected depth differs, which `required-at` deliberately does not model — see the guidance text for that).

Status: accepted, first-cut. Whatever eventually implements `gantry check` needs to actually read `required-at`, not just `required` — flag this ADR to that implementation work.
