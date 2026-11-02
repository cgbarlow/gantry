# The decisions log is per stage, append-only, and keeps the architect's words

Ticket #248, map #238 (v0.13.0, the AI interview). Builds on #239 (per-stage
logs for drafting ahead), #246 (what the AI follows) and #247 (session
states).

The AI interview turns an architect's answers into module content. Content
from a Source document carries a `source:` citation. Content the architect
gave is written as plain fact, so something else has to show where it came
from. That record is the **decisions log**. It is also what a paused session
resumes from, possibly in another browser, because AI Providers and their
keys belong to the browser (ADR-0061) and nothing about a session lives on
the server.

**One YAML file per stage**, `interview/<stageId>.yaml`, committed on that
stage's branch. Stacked stage branches (ADR-0014) never touch each other's
log, so drafting ahead and changes requested on an earlier stage never
conflict over it. YAML because Gantry has to read it back reliably on resume;
an Owner can still read it in the Pull Request diff.

The file has three parts:

- **Status**: the run's target stage, this stage's state, the Artefact aimed
  for, the last AI save, and the Interview instructions version. It also
  lists each model used on this stage, by AI Provider type and model (never a
  key, address or custom name), with that model's input, cached and output
  tokens (#255), so a switch between turns shows and a session resumed in
  another browser keeps its totals. There's no money figure. Updated in
  place. On resume Gantry runs Check status once, and whatever the Provider
  reports overrides the file.
- **Fields**: for each drafted Field, what it was drafted from (Source
  documents and pages, earlier Fields), each with a fingerprint, and the
  entries that fed it. The AI names these inputs in its draft-field step, and
  Gantry adds anything it saw the AI read that turn. Overwritten on redraft.
  This is what finds stale drafts after an earlier stage or a Source document
  changes.
- **Entries**: **append-only**. Changing an answer appends an entry that
  `replaces` the old one, and an open question is closed by an entry that
  `resolves` it. Nothing in Gantry edits or deletes an entry. "Start this
  stage over" appends a restart marker, and the AI ignores earlier answers
  from then on.

**The architect's words are kept, and the AI's are not.** Free-chat messages
that fed something are stored word for word on the entry they fed. The AI's
replies, and messages that fed nothing, are not stored. There is no
transcript.

**Committed with each Save.** That covers the stage Save, the Waiting-card
save and a new **Pause**, which saves the log and drafts so far. The browser
keeps a working copy in between. If the committed log has moved on since that
copy began, the committed log wins and the copy is set aside with a notice.

## Consequences

- A session started in one browser resumes in another after Pause or any
  Save. Answers given since the last Save survive only in the browser they
  were given in.
- Pause adds Saves partway through a stage, but only when the architect asks,
  so "no autosave" still holds.
- On resume the AI has the log and the saved content, not the conversation.
  It recaps from the log and carries on with the next round.
- The log is read in the Pull Request diff, in a read-only Decisions log
  panel in the editor, and on the Interview page. It never appears in a
  rendered Artefact. Open questions are answered by resuming the interview.
- The log grows with every changed answer. History is visible on request.
  The editor and the AI use the latest answers.

## Considered options

- **Markdown, or YAML plus a generated Markdown copy.** Rejected. Reading
  prose back in breaks easily, and two files drift apart.
- **One session file for the whole Instance.** Rejected. Stages live on
  several stacked branches, and one file would have to sit on one of them.
- **Edit entries in place.** Rejected. The trail would be buried in commits.
- **Commit the full transcript.** Rejected. It's mostly AI prose, it's long,
  and it would sit in a client repo. **An AI summary of the chat** was also
  rejected, because the record would be a paraphrase.
- **Commit after every round.** Rejected as autosave by another name.
  **Commit only at stage end** was rejected because answers would be lost on
  a change of machine.
- **Assume every later Field drew on everything earlier.** Rejected. One
  typo fix would mean a keep / redraft card for every later Field.
