# A code repository is searched from a copy the server holds briefly, one per commit

Ticket #338. Amends ADR-0072 (a code repository is a Source document read live
through a pointer). Builds on #325 (token-less limits), #335 (a search finishes
in good time) and #336 (a read survives a temporary failure). Supersedes #337.
Grilled with the product owner on 2026-11-05.

The AI searches a repository to find where something lives before it drafts
from it: the orders service, the retry policy, every caller of an API. A search
that sees only part of the repository is worse than a slow one, because the AI
drafts as if it had seen everything. ADR-0072 had the server read a repository
one file per Provider request. On a large repository, or over a slow link, that
needed a 400-file cap and, from #335, a 30-second cut-off. It also spent the
Provider's rate limit on every search.

Developers, and coding agents such as Claude Code, research a repository on a
complete local copy. They find files by name, search the text of every file,
see the lines around a match, page through long results, and read a file by
line range. On a copy all of that takes well under a second, so a time limit
never decides what was searched.

**One Repository copy per commit, in memory.** The first call at a commit
downloads the repository at that commit as one archive, a single Provider
request. GitHub, GitLab, Azure DevOps and Bitbucket all offer this. The paths
ADR-0072 always skips are left out as it is unpacked, as are binaries and files
over 1 MB. Later finds, searches, listings and reads at that commit use the
copy. A commit's content never changes, so a copy is never stale. A new commit
on the branch means a new copy, and results never mix two commits. Copies live
in the server's memory only. Nothing is written to disk.

**"Nothing is stored" still holds for the Instance.** The Instance keeps the
pointer and the commits cited, as ADR-0072 decided. A copy is the server's
working memory. It is never written into a workspace, never offered for
download, and gone on restart. All copies together stay under 512 MB, and
each repository under 150 MB of kept text; operators can change both. A copy
unused for 2 hours is dropped, and when room is needed the least recently used
goes first.

**The AI's tools work like a developer's.** Four read-only tools, the same for
the in-app AI and an outside agent over MCP:

- `find_repository_files` finds files by name pattern (`**/*.tf`).
- `search_repository` searches contents by plain text, or by regular
  expression when asked, with optional folder and file-type filters. It shows
  up to 5 lines of context, or returns matching files only.
- `list_repository_folder` lists a folder.
- `read_repository_file` reads a file, or a range of its lines.

Results are paged and never cut short: 50 matching lines or 200 paths a page,
and each page says how many there are in all. Every match still names its path,
line and commit, and the citation form is unchanged. A regular expression is
held to a short time budget and a length limit, so a pathological pattern can't
tie up the server; a search that reaches the budget says so.

**The AI's call waits; the architect sees it preparing.** When a copy takes a
while to download, the browser (or the MCP server, for an outside agent) asks
the server again every few seconds. The AI is just given the result, and the
thread shows "Preparing <repository>…". No request is held open past what a
proxy in front of Gantry allows. An interview or Bring up to date on an Instance
with a repository Source document starts downloading its copy straight away, so
the AI's first search rarely waits.

**Asked fresh, but not on every call.** The branch head is asked at most once a
minute per repository and branch, so a burst of searches costs one request
against GitHub's 60-an-hour token-less limit. Out of date's comparison always
asks fresh.

**Too big for a copy.** A repository over the per-repository limit, narrowed
to folders on a Provider that can download just those folders (GitLab, Azure
DevOps), is copied for those folders only. Otherwise it falls back to
ADR-0072's file-by-file reading with #335's limits, and the AI is told to
narrow to a folder. The same fallback happens without fuss when the download
itself can't be made. For example, the server's outbound traffic may not
allow `codeload.github.com` (where GitHub sends the download) or
`bitbucket.org` (Bitbucket's download address). The README names both hosts.

**Nothing readable today becomes unreadable.** A Provider's archive can leave
out files the repository marks as excluded from archives, along with
submodules, and Git LFS files come only as placeholders. A read of a path that
isn't in the copy goes to the Provider as today. Placeholder files are left out
of searches, and a submodule shows as a folder that isn't followed.

**One copy, shared, but each caller proves access.** A copy of a public
repository read without a token is shared. Any other copy is shared by
repository and commit among callers who have each shown, within the last few
minutes and with their own token, that they can read that repository: one cheap
request to the Provider. Nobody reaches content they couldn't read themselves,
and fifteen architects on one private repository need one copy, not fifteen.

## Considered options

- **Keep reading file by file and remember the files read (#337):** repeat
  reads cost nothing, but a first search is still capped, slow and costly on
  rate limits, and still cut short on a large repository.
- **The Provider's own code search (for example GitHub's):** indexed and fast,
  but default-branch only, can't search at a commit, needs a token, and the
  four Providers don't offer it the same way.
- **A search that resumes where it stopped:** no cut-off, but every search
  still costs hundreds of requests, and the AI has to keep asking to finish one.
- **A clone kept on disk for good, updated with `git fetch`:** cheapest on
  repeat, but it stores code on the server indefinitely, needs git and disk
  housekeeping, and goes beyond what ADR-0072 agreed for a pointer.
- **Spilling big copies to a temporary folder:** handles larger repositories,
  but it would be the first time a repository read writes to the server's
  disk. Left for its own issue if a real repository needs it.
- **One copy per token:** no reasoning across callers, but a team on one
  private repository would hold one copy each.
