# Every stage Save checks what changed since it was read, Field by Field

Ticket #256, map #238 (v0.13.0, the AI interview). Amends ADR-0064 (the
decisions log) and builds on ADR-0067 (outside agents).

Before v0.13.0, a stage Save overwrote whatever was there, so the last Save
won without a word. With one person in the editor that was rare. With the AI
interview it isn't. A session keeps drafts in the browser for a whole stage.
A colleague can save in the editor meanwhile, and a second architect or an
outside agent can run an interview on the same stage. Nothing about a running
session lives on the server, so a lock would have nowhere to live.

**No lock; check at the start and at every Save.** Gantry notes the stage's
content when a session starts or resumes, or when the editor opens the stage.
It compares again before every Save and Pause. The same rule covers the
editor, the AI interview and MCP's `update_instance_modules`, in every
workspace kind.

**Clashes are settled Field by Field, three ways.** Gantry compares what the
saver started from, what is committed now, and what the saver has:

- **Only the committed side changed:** theirs is taken. Any later AI draft
  that drew on it is flagged **Out of date**.
- **Only the saver changed it:** theirs is kept.
- **Both changed it:** in an AI session, a round of cards offers keep mine,
  keep theirs, or a merged wording from the AI, and the choice is logged. In
  the plain editor, a dialog shows both versions to pick from or edit.

Nothing is overwritten silently. An upload that changed no Field (a Source
document, a Reviewed copy) moves the branch but raises no clash.

**Two sessions on one stage are allowed, with a warning.** The decisions
log's status keeps one entry per session (ADR-0064 amended). When a session
starts or resumes and another one on the stage isn't Done, a card names when
it last saved and, on remote workspaces, who saved it. It offers Carry on
alongside or Cancel.

**Logs merge.** Entries are append-only and have their own ids, so when two
sessions' logs have both moved on, both sets are kept, in time order. A later
answer to the same question becomes a `replaces` entry. The Fields section is
rebuilt. ADR-0064's "set aside" rule now applies only to one person's own
out-of-date working copy.

**MCP passes the version it read.** `get_instance` returns the stage's
version and `update_instance_modules` takes it. On a mismatch it refuses,
naming the Fields that differ, and the agent re-reads them and settles the
clash with the architect. The version is required in a session. Outside one,
leaving it out works as before, but the response names every Field the call
overwrote, so existing agents keep working.

**When the stage itself has moved on**, because another session requested
approval or advanced it, the second session sees this at its next Save or
Check status and carries on from the new state, as if it had made the move
itself. While approval is pending, its Save lands on the stage branch the way
a person's edit does today. Once the stage has advanced, it saves only where
Gantry already allows edits. Otherwise it offers re-open, or keeps its answers
as open questions.

## Considered options

- **A committed lock when a session starts.** Rejected. It costs a commit,
  and a browser that just closes leaves a stale lock.
- **Live presence on the server.** Rejected. It doesn't reach local
  workspaces or MCP, and the server is stateless.
- **Refusing a second session.** Rejected. It needs a lock to enforce, and
  the Field-by-Field check already keeps both sessions safe.
- **Settling a clash for the whole stage at once.** Rejected. Taking theirs
  loses every unsaved answer, and taking mine overwrites them.
- **Checking only AI saves.** Rejected. A colleague's plain editor Save could
  still overwrite a session's saved work, and the reverse.
- **Requiring the version on every MCP call.** Rejected. Existing agents
  would break.
