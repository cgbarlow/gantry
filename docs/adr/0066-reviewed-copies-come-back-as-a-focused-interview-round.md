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

## Amendment (#302): how a Reviewed copy is brought in and listed

Ticket #302 built the part of this decision that needs no AI: bringing a Reviewed copy in and listing
its threads by Field. Where the ticket left a detail open:

- **One upload is up to 25 MB in all**, not 25 MB a file. Several copies of the same render come in
  together and are one commit (remote) or one write per file plus the manifest (local and server).
- **A server refuses the whole upload if any file in it is refused**, so a commit never holds only some
  of what the architect chose. The browser checks each file first and sends only the accepted ones,
  so the architect can still bring in the good copies and leave the refused one out.
- **A document from another Instance** is one whose `gantry-instance` is not this Instance's slug or
  whose `gantry-definition` names a different Definition (two workspaces can both have an Instance
  with the same slug). **From another Artefact** is one whose `gantry-artefact` this Instance's
  Definition does not have. A different Definition *version* is accepted.
- **Placing by text compares each comment with the wording of the Fields**, as they were at
  `gantry-commit` (read from the Provider at that commit) or, with no commit (a server or Local
  workspace keeps no history), as they are today. It does not recompile the whole render. A comment
  is matched on the text it covers as rendered (tracked insertions left out, deletions kept), then on
  its paragraph; text a commenter inserted as a whole new paragraph goes with the paragraph above. A
  match that two Fields share, or that is only loose, is shown as a best guess. The notice above the
  copy says text matching was used and against what.
- **The reader runs in the browser for every kind of Instance**, and the server runs the same code to
  check an upload, so a Local workspace needs no server round trip. The Local workspace writes the
  same `reviews/` files itself.
- **The manifest's `commentsAnswered` starts at 0** and is only raised when the comments are worked
  through (#303).

## Amendment (#303): the review round

Ticket #303 built the AI half: the round itself. Where the ticket left a detail open:

- **A card is a thread, with the same commenter's tracked changes beside it.** A commenter's tracked changes in a Field that has no thread of theirs
  there make a card of their own. Commenters **disagree** when their tracked changes touch the same paragraph of a Field; a comment beside someone
  else's edit is not a disagreement, so those stay separate cards. The shared card offers "Accept <name>'s edit" for each commenter, and recommends
  Revise: no single edit is the obvious answer.
- **"Accept or revise" is two choices.** "Accept the edit" is the reviewer's edit as they tracked it; "Revise" has the AI redraft, and its draft
  meets the keep / use the AI's version / merge card like any change to saved content. Accept is recommended only when the Field is unchanged
  since the render; otherwise Revise is, and the card shows the old and new wording.
- **"Unchanged since the render" is read from the document itself.** Gantry compares the Field's wording under its Word bookmark (the text as it was
  rendered, tracked insertions left out) with what is saved now, ignoring Markdown formatting, which Word does not print as characters. A copy that
  lost its bookmarks uses the content at the render's commit it was placed against, else the words the commenters touched. A server or Local
  workspace has no history, so any difference from the document counts as changed.
- **Gantry makes an accepted edit itself only when it can do so without guessing.** Deleted words must occur once in the Field (replaced by the
  insertion beside them, paired in order), or a whole paragraph the reviewer inserted goes after the paragraph it followed. Otherwise the AI makes
  the edit, and its draft meets the same card. Either way the edit is an unsaved preview until the round is saved.
- **The AI never sees a real name.** Commenters are "Reviewer 1", "Reviewer 2", fixed across the Reviewed copies in the order they were brought in.
  Every text sent to the AI is scrubbed of each commenter's name and of the parts of it ("Ana" for "Ana Reviewer"), including the architect's own
  words and the brief's view of the decisions log, which shows a `review-answered` entry by its outcome alone.
- **"Can't settle yet" is an open question** whose text names the Field and the first words of the comment, with the commenters as "Reviewer N".
  The AI may offer a significant one as a Key decision only where the Key decisions module is mounted on the Stage.
- **Joining a session.** Questions are added to the open round, or open a round of their own when the AI is waiting, or are queued for the next
  round while it is working. A paused session cannot take them, so the page remembers the wish in the tab and the interview that resumes asks
  them in its first round. A focused round ends when its cards are answered, calling the AI only for an answer that needs something written.
- **The manifest's count follows the committed logs.** After a Save, the page raises `commentsAnswered` to the number of threads the Stages' logs
  say were answered (`PUT /api/instance/reviews/answered`: one commit on the current Stage's branch for a Provider, one write for a server
  workspace; a Local workspace writes its own). It only goes up and never past the comments the copy holds.
- **A Save does not render again** and the **Review response list** is #304. The Interview page's summary says render again when reviewers should
  see the changes.

## Amendment (#304): the Review response list

Ticket #304 built the last part: what Gantry offers in place of writing back. Where the ticket left a detail open:

- **It is made in the browser, from the logs, each time it is asked for**, and handed to the browser as a download. It is not stored, not written
  into the Instance's files and not committed, so there is nothing to keep in step with the log. The same builder (`web/lib/reviewResponse.js`) has
  no DOM, so the server or an outside agent (ADR-0067) can make the same list from the same logs.
- **One table for each Reviewed copy**, a row for each answered thread: comment (with replies and tracked change word for word), commenter, Field,
  outcome and reason. A thread answered twice (in two Stages' logs) is one row, the latest answer. The columns are plain Word, so the architect can
  edit the wording before sending it.
- **The reason is the architect's own words, or a dash.** Gantry does not write a reason the architect did not give.
- **The outcome says only what happened.** "Revise" and "Accept the edit" through the AI end in a keep / use / merge card; if the log shows the
  architect then kept what was saved, the row reads "Looked at; the wording stayed as it was". On a shared card, a commenter whose edit was not the
  one accepted reads "Another commenter's edit was accepted instead".
- **Where it is offered:** the Interview page's rail and the card after a round is saved (with the nudge to render again), and the editor's Review
  comments panel once the manifest says a comment is answered. The nudge names the documents the answered comments were made on; re-rendering
  stays a button the architect presses.
