# Rendered artefacts name themselves from instance content

Amends the stable-output-path rule stated in `lib/render.js` and relied on by
ADR-0014.

A rendered artefact is named `<Instance name> - <Artefact title>` (WI226),
built by `renderedArtefactBasename` and used identically by the local path and
by every provider push. Every render of the same artefact on the same instance
overwrites the previous one, and `lib/render.js` gives the reason: "the repo's
own history is the audit trail — no reason to also keep every past render as a
distinct file." ADR-0014 leans on the same property from the other side — the
approver's pull request shows the regenerated document *changing*, next to the
module data that changed it. (The doc comment on
`renderArtefactFromAzureDevOps` still describes the pre-WI226
`out/<artefactId>.docx` scheme and is stale; correcting it belongs with this
work.)

That scheme is right in shape and too coarse in practice. Both halves of the
name are properties of the *instance and the definition* — never of the
content. Every offer pack an organisation ever renders is called
`<role> - Offer Pack.docx`, which is fine inside a repository where the
instance directory disambiguates it, and not fine anywhere else. These
documents leave the repository: an offer pack is downloaded, attached to an
email and filed by a candidate, next to offers from other employers; a manager
handover is forwarded to a hiring manager who has never heard of Gantry. The
fact that identifies the document to those people — whose offer it is, which
start date it assumes — is in the instance's module data, and the naming
scheme cannot reach it. So the first thing anyone does is rename the file by
hand, which is the point at which the generated document stops being the
generated document.

**Decision**: an artefact may declare a `filename:` pattern, resolved against
the instance's own content at render time. `<Instance name> - <Artefact title>`
remains the default for any artefact that declares no pattern, so every
existing definition renders exactly what it renders today.

1. **`filename:` is a new key on the artefact in `definition.yaml`**, beside
   the `requires` list it depends on. Its value is a literal string
   containing `{module.field}` tokens. Tokens are field references only — no
   expressions, no logic, no Eta. That is what lets the pattern be checked
   when a definition is published rather than at render time, on the branch,
   with someone waiting for a document.

2. **Tokens may reference `select`, `text` and `date` fields only**
   (ADR-0044), plus three built-ins: `{instance.name}`, `{instance.slug}` and
   `{today}`. A token pointing at a `markdown` or `list` field is a
   validation error, not a truncation.

3. **`{today}` is the date of *this* render.** A date stamp answers "when was
   the thing I am holding produced"; frozen at first render it would claim a
   date that is not the document's own. The cost is that re-rendering on a
   later day changes the name.

4. **Every field a `filename:` references must appear in that artefact's own
   `requires` list**, enforced at definition validation. This is what makes
   §5 safe: the gate already enforces `requires`, so a document cannot reach
   sign-off half-named. It also falls out correctly — an artefact rendered
   before a candidate exists cannot name itself after one, and validation
   says so instead of a human noticing later.

5. **An empty token is dropped, with its surrounding separators tidied.**
   `{selection.candidate-name} - Offer Pack` renders as `Offer Pack.docx`
   until the name is filled — which is exactly what Gantry produces today.
   Rendering is on demand (ADR-0034) and drafts are rendered throughout a
   stage against half-filled modules; refusing to render because a name has
   not been typed yet would break the workflow that decision was made to
   support.

6. **The resolved name is human-readable and sanitised** by the existing
   `sanitiseRenderFilename`: the author's spacing and capitalisation are
   preserved, path-hostile characters (`/ \ : * ? " < > |`) are replaced,
   whitespace runs collapse, and the result is trimmed. This decision adds a
   length cap so the repository path stays within limits on every platform,
   and otherwise adopts the rule Gantry already applies to every rendered
   document. `lib/slug.js` is not reused: it makes *identifiers*, and
   `jane-smith-offer-pack.docx` reads like a build artefact and invites
   exactly the manual rename this decision exists to prevent.

7. **A render whose name differs from the previous one writes the new file
   and deletes the superseded one in the same commit.** Gantry records which
   file was each artefact's last render in a small manifest under `out/`.
   Without it, a corrected candidate name or a moved start date — and
   `contract.yaml` expects start dates to move — leaves two offer packs in
   `out/` with nothing saying which is live.

   This is not a problem `filename:` introduces; it makes an existing one
   common. Renaming an instance already changes `<Instance name> - <Artefact
   title>` and already strands every document rendered under the old name,
   with no cleanup anywhere in the codebase. The manifest fixes that case
   too.

**What this amends.** One artefact still resolves to exactly one current
document, and `out/` still holds exactly the current set; the audit trail is
still the repository's history. What changes is that a rendered document's
path can now move in response to *content* changing, where previously it moved
only when an instance was renamed. So where ADR-0014's pull request diff
usually showed a document modified in place, a rename now shows as a delete
plus an add, and does so more often. The diff still carries the regenerated
document alongside the module data that changed it, which is the property
ADR-0014 actually depends on. ADR-0014 and ADR-0034 otherwise stand.

All naming stays behind one function. `renderedArtefactBasename` is already
the single place a rendered file's name is decided, for the local path and
every provider push alike; pattern resolution is added there rather than
beside it, so there is no second way a document can get named.

Alternatives considered and rejected:

- **Eta expressions in `filename:`**, consistent with template bodies —
  rejected: unvalidatable before render, and arbitrary JavaScript in a file
  path.
- **The pattern in template frontmatter** — rejected: splits an artefact's
  configuration across two files and hides it from definition validation.
- **Slugified filenames** — rejected, as in §6.
- **Leaving superseded renders in place** — rejected: no manifest and no
  delete logic, but `out/` accumulates near-duplicates and a reader has to
  work out which document is current, which is the confusion the original
  overwrite rule was written to avoid.
- **Keeping the existing instance-and-title scheme in the repository and
  applying the content-derived name only on download and client delivery**
  — rejected, though it
  is the cheapest option and preserves every existing property. The repository
  is where most people meet these documents, including in the provider's web
  UI and in the pull request an approver reads; two names for one document is
  a subtlety that has to be explained forever.
- **Refusing to render while a token is empty** — rejected, as in §5.
- **`{today}` frozen at first render** — rejected, as in §3.

Costs accepted knowingly: noisier branch history, since any change to a name —
including the day rolling over under `{today}` — shows as a delete plus an add;
and one tracked manifest file in `out/` that is Gantry's bookkeeping rather
than anybody's content.

Status: accepted.
