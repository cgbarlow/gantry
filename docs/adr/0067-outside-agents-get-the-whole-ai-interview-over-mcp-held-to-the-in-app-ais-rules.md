# Outside agents get the whole AI interview over MCP, held to the in-app AI's rules

Ticket #254, map #238 (v0.13.0, the AI interview). Builds on ADR-0043 (the
MCP server does everything the web UI can), ADR-0063 (approvals in stage
order, shared modules wait), ADR-0064 (the decisions log) and ADR-0066
(Reviewed copies).

Before v0.13.0, the way to get AI help with an Instance was an **outside
agent**, such as Claude Code, driving Gantry through the **Gantry MCP server**.
The AI interview adds Source documents, the decisions log, Reviewed copies and
interview sessions. ADR-0043 says the MCP server does everything the web UI
does, and that holds here too: an outside agent can read and write all of it,
and can drive an interview session itself.

**Read.** An outside agent lists and reads Source documents (the committed
extracted text, by page; images as images), the decisions log, and Reviewed
copies with their threads and the Field each one traces to.

**Upload.** Uploading a Source document or a Reviewed copy over MCP follows
the same rules as the browser: 25 MB per document, one commit per upload on
the current stage's branch, an optional "replaces" link, the same manifest
entry, and the same `gantry-*` check for a Reviewed copy. In the browser the
text is extracted there. For an MCP upload there is no browser, so
`gantry serve` runs the same extractors (officeparser and Gantry's Word-comment
reader). This doesn't send anything to the server that was meant to stay on
the architect's computer, because the MCP server can't reach local workspaces.

**Sessions.** An outside agent can start, pause and resume a "run until stage
X" session. An interview-brief tool gives it what the in-app AI gets: Gantry's
fixed interview rules, the Definition's Interview instructions, the pinned
grilling and domain-modeling skills, the stage purpose, Field guidance,
budgets and options, and a recap from the log. The agent asks its questions
in its own chat; question cards are web-only. A session moves between the
browser and an outside agent through the last commit. Whichever side resumes
runs Check status once and recaps from the log, and ADR-0064's rule stands: if
the committed log has moved on, a browser working copy is set aside with a
notice.

**Held to the in-app AI's rules.** An outside agent in a session has the
in-app AI's role, so Gantry refuses what it would refuse its own AI, giving
the same reason. It never passes a gate. On remote workspaces it requests
approvals strictly in stage order, and it doesn't edit shared modules while an
earlier stage's Pull Request is open. MCP calls outside a session are like a
person in the web UI, and nothing new is refused.

**Decisions-log entries are labelled.** An outside agent appends entries in
the same shape and under the same append-only rules, each stamped as
**recorded by an outside agent**. ADR-0064 keeps the architect's own words,
and Gantry can't check an agent's quote of them, so the label tells a reader
whose account of the architect the entry is. The session status names "outside
agent" and the model the agent reports. Gantry rebuilds the log's Fields
section from the content's citations and from the entries that name each
Field, so Out of date detection works the same.

**Entries ride on the stage Save.** `update_instance_modules` takes log
entries and the session status, and commits them with the content in one
commit. That happens after the architect confirms the stage summary, or asks
to Pause. Nothing is committed per answer, so "no autosave" still holds.

**Every MCP content write gets the per-Field check**, in a session or not:
select values within the options, word budgets, and every figure cited with
`source:` or marked "(target assumption)". As with today's over-budget notes,
problems come back as notes and never block the save.

**Everything else follows.** `get_instance` shows Out of date Fields, and the
agent keeps or redrafts them on the architect's word, with a labelled entry.
For a Reviewed copy, the agent records an outcome per thread and fetches the
Review response list. Gantry never writes back into the document. Standard
modules and Interview instructions go through the existing Definition tools.
AI Provider settings stay in the browser, because an outside agent is its own
AI.

MCP access control doesn't change. Source documents and Reviewed copies are
files in the same repo, read with the same Workspace PAT, so whoever can reach
an Instance through MCP could already read its content. ADR-0048 stays
proposed.

## Considered options

- **Read only, or out of scope for v0.13.0.** Rejected. An outside agent
  drafting without the Source documents makes up figures, and ADR-0043's
  parity would break.
- **The agent supplies its own extracted text.** Rejected. The committed text
  is the record of what the AI read, and it would become the agent's word.
- **Unlabelled log entries, or none from outside agents.** Rejected. With no
  label, Gantry couldn't tell an agent's account from its own captured words.
  With no entries, facts the architect gave an outside agent would leave no
  record.
- **Guard rails written only in the brief.** Rejected. An outside agent in a
  session would be trusted with more than Gantry's own AI.
- **A record-decision tool that commits each entry.** Rejected. It is
  autosave by another name.
- **An explicit take-over when a session moves sides.** Rejected. Resuming
  from the last commit already works between two browsers. Two sides working
  at the same time is left to #256.
