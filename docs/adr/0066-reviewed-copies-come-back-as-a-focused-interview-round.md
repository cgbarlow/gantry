# Reviewed copies come back as a focused interview round, and only Gantry's own tagged renders are accepted

Ticket #251, map #238 (v0.13.0, the AI interview). Builds on the Word review
research in #250, the "Bring up to date" round in #249, ADR-0063 (approvals in
stage order) and ADR-0064 (the decisions log).

A reviewer comments on a Word document Gantry rendered and sends it back. The
architect brings that **Reviewed copy** into Gantry, and the AI works through
the feedback with them the same way it runs the interview, through question
cards, revising the Fields the comments sit on.

**Every Word render is tagged.** Gantry wraps each Field's value while
compiling, so Pandoc writes an invisible bookmark around it, and adds
`gantry-*` document properties naming the Instance, Artefact, Stage,
Definition version, commit and render id. Gantry does the wrapping itself, for
the Word render only, so no Definition or template has to change; Filename
patterns, cover pages and template conditions still see plain values.

**Only tagged renders are accepted.** A document without the `gantry-*`
properties is refused, and the architect is told to upload it as a Source
document instead. One from another Instance or Artefact is refused, naming
where it came from. Bookmarks may be lost (Google Docs scrambles their names)
while the properties survive; Gantry then places comments by matching the text
against the original render, and says so.

**It is a focused round, not a "run until" session.** "Bring in review
comments" sits on the Interview page and in the editor header. Several
Reviewed copies of the same render can come in at once. If a session is
running or paused, the review questions join its next round.

**One question per comment thread.** One commenter's tracked changes in one
Field make one question. "Accept the edit" is recommended only when the Field
is unchanged since the render; otherwise the card shows the old and new text
and the AI proposes a merged wording. Nothing is applied automatically. The
choices are accept or revise, keep as is (with an optional reason in the
architect's words), or can't settle yet, which becomes an open question.
Commenters who disagree share one card. Threads resolved in Word are not
asked. Comments on the cover, Document Control or table of contents, and those
that can't be placed, get their own card: assign to a Field, open question,
or note.

**Which content changes** follows "Bring up to date": in place on local and
server workspaces; on a remote Instance at the current stage, carried forward
from an approved stage, re-opened where ADR-0026 allows, or else an open
question. A stage still awaiting approval takes the change on its own branch,
updating its Pull Request; a drafted-ahead branch never does (ADR-0063).
Accepting a change to an `agreed` module returns it to `draft`.

**The Reviewed copy is kept but is not a Source document.** It is committed on
upload under `reviews/`, one commit on the current stage's branch, 25 MB cap,
listed in `reviews/manifest.yaml` (fixed id, Artefact, Stage, render id and
commit, commenters, date, how many comments are answered). It is never cited.
Each answered thread appends a **review comment answered** entry to the
decisions log of the stage whose content changed, quoting the comment, its
replies and any tracked change word for word, so the entry stands on its own
even on a branch that doesn't hold the file.

**Gantry never writes back.** It doesn't edit the Reviewed copy or reply to
the commenter. It offers a **Review response list** built from the log, which
the architect can download as Word, and a nudge to re-render (ADR-0034).

## Consequences

- The AI sees commenters as "Reviewer 1, Reviewer 2". Real names stay in the
  repo: the Reviewed copy, the manifest and the log.
- Server workspaces have no commit history, so the comparison is against
  today's content, and any Field that differs counts as changed since the
  render.
- The AI still has no part in Request Review (#247). Work-item replies aren't
  tied to a Field. Word comments are the review channel the AI reads.
- Do one manual round trip through desktop Word and Word for the web before
  release; the research tested Word-saved and Google-exported files only.

## Considered options

- **Keep the Reviewed copy as a Source document.** Rejected. It's mostly a
  copy of our own content, and citing it would be circular.
- **Don't keep it.** Rejected by the product owner. The file is the record of
  exactly what came back.
- **Accept untagged documents and place comments by text alone.** Rejected.
  It's too easy to bring in the wrong document, and a document Gantry didn't
  render belongs among the Source documents.
- **Have Definition templates opt in to Field markers.** Rejected. Every
  bundled Definition would need a new version, and custom ones would get
  nothing.
- **One question per Field.** Rejected. Cards would get large, and one
  commenter's thread couldn't be answered on its own.
- **Write replies or resolutions into the Reviewed copy.** Rejected, matching
  "the AI never writes to the PR".
