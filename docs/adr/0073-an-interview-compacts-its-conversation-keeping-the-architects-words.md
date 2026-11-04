# An interview compacts its conversation, keeping the architect's words

Ticket #329, with #328 (cheaper calls). Builds on ADR-0064 (the decisions log
keeps the architect's words, not the AI's), ADR-0061 (AI Providers belong to the
browser) and ADR-0072 (code repositories read live). Grilled with the product
owner on 2026-11-04.

An AI interview sends the whole conversation with every call: the brief, every
question and answer, and every Source document or repository file the AI has
read. A long session, especially over a code repository, runs to hundreds of
thousands of tokens and will eventually be refused by the AI Provider as too
long. Each AI Provider already records the model's context window, but until now
the interview used it only to size the opening brief.

**Compaction starts a fresh conversation, so the AI forgets some things on
purpose.** The new conversation is built from:

- the system prompt and opening brief, as at the start (still cached);
- the current drafts;
- the session's decisions log entries, as structured facts;
- **the architect's own chat messages, word for word**;
- a short "where we are" summary the AI writes just before. It covers what it
  learned from each Source document and repository (with paths and commits),
  what is settled, what is still open, and what it was about to do.

Everything else is dropped: the AI's earlier replies and the text of files it
read. The AI can read any file again.

**The architect's words are never summarised.** The summary is the AI's words,
and ADR-0064 already holds that the AI's words are not kept. So an answer, a
free-chat message or a decision reaches the new conversation as the architect
gave it, never paraphrased by the summary. The summary is used only as the new
conversation's context. It is not stored in the decisions log, and it adds no
transcript.

**The architect decides, except when there is no choice.**

- When the conversation passes about 60% of the model's context window, the
  interview shows a card offering to compact, with the token count before and
  an estimate after. The architect can say not now.
- **Compact now**, in the rail's Tokens block, does it at any time.
- When the AI Provider refuses a request as too long, Gantry compacts without
  asking and retries once, because the only alternative is a dead end.
- Every compaction leaves one line in the thread:
  `Conversation compacted (612k → 38k tokens)`.

**The same everywhere.** Compaction is Gantry's own and works the same on every
AI Provider, not one vendor's built-in context management, because architects
choose their AI Provider (ADR-0061).

**Cheaper before it is needed (#328).** Two changes keep a session from reaching
compaction so soon:

- **The conversation itself is cached** on AI Providers that take explicit cache
  points.
- **Old reads are shortened.** Once a read is a few AI turns old, its text is
  replaced in batches by a one-line note naming the document or file and commit.
  This covers uploaded and fetched Source documents as well as repository files
  and searches.

Neither touches citations, Out of date or the decisions log. Those record what
was read when it was read.

## Considered options

- **Rebuild from the log and drafts only, with no AI summary.** Deterministic
  and free, but it loses what the AI had learned from its reading and what it
  was about to ask. It is kept as the fallback when the summary call fails.
- **Each vendor's built-in compaction.** It differs across AI Providers and is
  missing on some, so the interview would behave differently depending on the
  model.
- **Compact automatically at the threshold.** Rejected for the threshold: the
  product owner wants to choose when the AI forgets. Kept for a too-long
  refusal.

## Consequences

- A compacted session can re-read a file it read before. That costs a call,
  which is still far less than carrying every read in every call.
- The summary call's tokens count towards the session like any other.
- Outside agents over MCP run their own conversation and are not affected.
