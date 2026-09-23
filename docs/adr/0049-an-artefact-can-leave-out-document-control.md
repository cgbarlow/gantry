# An Artefact can leave out Document Control

Relaxes the rule, set when the Document Control block replaced the old
commit footer (WI233), that every rendered document carries that block.

Since WI233, `compileArtefact` in `lib/render.js` puts two tables straight
under every rendered document's title: **Document Control** (version, date,
the commit the render was pushed as, gate status) and **Review & sign-off**
(one row per review and sign-off, or a single `Pending` row). The code's own
comments state the rule and the reason for it. The block is "pipeline-injected
for *every* definition", and even a dry run with no commit to name "still
inject[s] a block so the artefact never loses its commit reference site". The
block replaced the footer that used to record the render's commit, so leaving
it out meant losing the document's link back to the repository history that
serves as its audit trail.

The only way out has been per Definition. A Definition that ships an empty
`templates/_documentControl.md.tmpl` renders an empty block, so none of its
documents carries the tables. Nothing could turn the tables off for one
Artefact.

## Why that is no longer enough

Spec #147's review of `recruitment-onboarding` v2 found Artefacts written for
readers outside the process owner's team. The clearest case is the Offer Pack,
which goes to the candidate. For those documents both tables are wrong:

- **Document Control** is internal bookkeeping. It shows a commit hash that
  links to a repository the reader can't open, and it says "Status: Draft" on
  a document the organisation has already agreed to send.
- **Review & sign-off** lists the organisation's own reviewers and approvers.
  That is internal process, and before sign-off it is an empty `Pending` row.

HR has to delete both by hand before the document can go out. The per-Definition
opt-out can't help. The internal Artefacts in the same Definition, such as the
Appointment Case and the Hire Record, are the ones that need the tables most.

## Decision

1. **An Artefact can set `document-control: false`.** A render of that
   Artefact has neither the Document Control table nor the Review & sign-off
   table. The H1 and everything the template produces below it are unchanged.
   The key defaults to `true`, so an Artefact without it, or with `true`,
   renders exactly as before, and existing Definitions are unaffected.
2. **It holds on every render path.** That covers local, Azure DevOps, GitHub,
   GitLab and Bitbucket renders (both pushes of the two-push commit-learning
   render), WASM prepare, `gantry render` and stage approval's auto-render.
   They all compile through `compileArtefact`, which is where the key is
   honoured, so no path can drift. A Provider render still pushes twice and
   still learns its commit. That commit just isn't printed in the document.
3. **The per-Definition opt-out stays.** An empty `_documentControl.md.tmpl`
   still clears the block for every Artefact in the Definition. The two
   combine: an Artefact is rendered without the tables if either says so.
4. **Only a real boolean is accepted.** Anything else, such as `"no"`, `0` or
   the string `"false"`, is an `invalid-document-control` problem. Unquoted
   `no` is the likeliest slip: YAML 1.2 reads it as the string `"no"`. The
   problem is reported by `gantry validate`, blocks Save and Publish (local
   and every Provider), shows as a marker on a Provider draft on the
   Definitions page, and is reported in a Local Workspace. The render only
   honours a real `false`. A near-miss that was silently read as `true` would
   print both tables on a document meant to leave the organisation clean. So
   the version projection and the Local Workspace reader carry a non-boolean
   value through as it is, rather than dropping it as if the key were absent.
   Dropping it would hide it from validation and delete it on the next Save.

   A Definition on disk with this problem **does not load**, and neither do
   its instances. Like the other load-blocking problems, it also stops the
   Definitions list for that directory, so every Definition beside it stops
   listing until the value is fixed. That goes against spec #147's wish that
   newly detected problems not stop existing instances loading, and it is
   deliberate. Loading anyway would render the document with both tables,
   which is the leak the key exists to prevent, and guessing at the author's
   meaning is what this decision rules out. The cost is small. The key had no
   effect before this change, so no live Definition depends on a misspelt
   value, and the load error names the Artefact and the value to fix. This
   holds on every Provider too: an instance's Definition is always loaded from
   the server's disk (the packaged Definition, the server workspace or the
   Library-repo mirror), and that load validates, so a Provider instance
   refuses to load or render rather than printing both tables. Only the
   Provider's own read of a draft for the Definitions page skips validation,
   and that shows the marker. Save and Publish refuse the value everywhere.
5. **The Definitions page has a checkbox for it.** Each Artefact has a
   Document Control checkbox, ticked by default. It is editable on a draft and
   read-only on a published version. Unticking it stores
   `document-control: false`. Ticking it again removes the key rather than
   writing `true`, so a Definition that never uses the switch keeps its YAML
   unchanged. #148 made the key survive save, new draft, clone, publish,
   promote and the Library cache.

## What an opted-out document gives up

The rendered document no longer names its own commit, so a reader holding
only the `.docx` can't trace it back to the repository. The trace still
exists outside the document. Every Provider render is a commit on the
Instance's branch, and the Artefact's file in `out/` has its own history. The
approval request still lists and links the document. Leaving the tables out
removes internal information from the document. It does not remove the audit
trail.

This is why the key is per Artefact and defaults to on. A Definition author
turns it off for a document that is sent outside the organisation, not for
one the organisation keeps for itself.

## Alternatives considered

- **Per-Artefact partials** (a `_documentControl-<artefact>.md.tmpl` the
  render looks for first). Rejected: an empty file is an unclear way to say
  "off", it can't be shown on the Definitions page as a switch, and it would
  not survive the Definition lifecycle the way a key does.
- **Letting the template decide** (exposing the block to Eta so a template
  places or drops it). Rejected: every existing template would need an edit
  just to keep today's behaviour. It would also turn a pipeline guarantee
  into something each template author must remember.
- **Two keys, one per table.** Rejected for now. No Artefact in the review
  needs one table without the other, and a single switch is easier to
  explain.

Status: accepted.
