# Stages and artefacts get a `purpose` field, matching modules

`definition.yaml` today gives every module a `purpose` field (a short prose
explanation of what it captures, e.g. `context`'s "Why this initiative
exists and what it is responding to..."), but stages and artefacts carry
only a `title` — no equivalent explanatory text. This was fine while
nothing needed to say more about a stage or artefact than its name, but
WI183/184's User Guide needs reference content explaining what each stage
and artefact *is*, and duplicating that as guide-only prose (disconnected
from `definition.yaml`) would drift the moment a stage or artefact changes.

**Decision**: add an optional `purpose` field to stage and artefact entries
in `definition.yaml`, following the exact same convention modules already
use (short prose, not required/schema-enforced — `lib/definition.js`
doesn't enforce module `purpose` either, it's a plain pass-through). The
User Guide's stage/gate and artefact reference sections read from these
fields directly rather than hand-duplicating the explanation. `design`'s own
stages and artefacts get their `purpose` text filled in as part of
implementing the Guide.

Alternatives considered and rejected:

- **Hand-author stage/artefact explanations only inside the User Guide
  content, no schema change** — rejected: the explanation would live
  disconnected from the definition it describes, with no mechanism forcing
  it to be revisited when a stage or artefact's actual requirements change,
  the same drift risk `purpose` already prevents for modules.
- **Make `purpose` required and schema-validated for every stage/artefact**
  — rejected: modules' own `purpose` isn't enforced either; requiring it
  only for stages/artefacts would be an inconsistent, unmotivated stricter
  rule, and would force retrofitting on any future definition that doesn't
  need one yet.

This field is added solely to support the User Guide's reference content —
surfacing it elsewhere (e.g. in-app tooltips in the module editor) is a
separate, unscoped decision, not implied by this one.

Status: accepted.
