# Changelog

Release notes for Gantry itself — one section per tagged release, newest first.
Written for the people who *run* Gantry, including anyone who never reads the
repository and has no Azure DevOps access to read instead.

Not to be confused with `definitions/<id>/<n>/CHANGELOG.md`, which is a different
thing entirely: those describe changes to a *design definition* (modules renamed,
sections restructured) for the people authoring against it, and are surfaced in
the app. This file describes changes to the application.

**Maintaining it is a release requirement, not a courtesy.** Every version bump
adds a section here in the same commit, and `tests/changelog.test.js` fails the
build if the version in `package.json` has no entry. See
`docs/agents/release-process.md` for the full convention.

Versions are the `package.json` version; each is tagged `v<version>` on its merge
commit on `main`.

## 0.8.3-beta — 2026-09-23

### Fixed

- **A GitHub-linked design now shows the issue it hangs off, instead of an empty "#".** Gantry
  records the parent it links a design to using each provider's own vocabulary — an issue number for
  GitHub, a work item id for Azure DevOps — and has always written both correctly. Every screen that
  *displayed* one only knew the Azure DevOps spelling, so for a GitHub-linked design the Work item
  details panel showed a bare "#" with nothing after it, Instance Settings showed "#undefined"
  beneath an "Azure DevOps work item" heading and three blank rows, and the dashboard's "Track Work
  Item" link was hidden altogether. All four now read whichever the design actually has, link
  straight through to the issue, and label it the way that provider does — "Parent issue" over an
  owner and repository for GitHub, "Parent work item" over an organization and project for Azure
  DevOps. GitHub issues have no work-item type and no longer pretend to: that row is simply absent
  rather than blank. A design with no parent at all now reads as "—" rather than as a broken link.

## 0.8.2-beta — 2026-09-23

### Fixed

- **The dashboard no longer goes blank when a GitHub- or GitLab-backed workspace has designs to
  show.** With 0.8.1-beta, entering a credential finally made those designs reachable — and reaching
  them was the first time the dashboard had ever had to draw one. It couldn't: it looked for a display
  name on a field only a server-hosted workspace carries, found nothing, and threw while sorting the
  list, which took down every row on the page rather than mislabelling the one. The visible result was
  a workspace stuck reporting "Can't read this workspace" while the browser console filled with
  errors — the designs had in fact arrived, and the crash happened on the way to drawing them. A
  GitHub- or GitLab-backed workspace now shows its repository name, with its owner or namespace
  beneath, and a workspace shape this version has never seen falls back to something sortable instead
  of taking the page with it.

- **The MCP server builds and deploys again.** A check added in 0.8.1-beta, guarding against the
  renamed environment variables reappearing, read a file that is deliberately not copied into the
  container image. The check failed there for that reason alone, and because the MCP server's build
  runs its tests as a build step, the whole deploy failed with it. The check now skips a file that
  isn't present in a given build, while still failing loudly if it ends up with nothing at all to
  check.

- **Two equivalent checks in the Gantry image had been failing silently since 0.8.0-beta.** They read
  files the image deliberately excludes, and the Gantry image's test stage reports results rather than
  halting on them, so a broken check looked exactly like a passing one. Both now behave in a container
  the same way they do in a checkout.

## 0.8.1-beta — 2026-09-23

### Fixed

- **Entering a credential in the browser for a Provider-backed workspace now actually fills that
  workspace in on the main screen.** What you saw before: you opened the workspace's Settings, pasted
  a Personal Access Token, saved it — and went back to the dashboard to find the workspace still
  reporting that nothing was registered in it. Not briefly, either: it stayed that way through
  reloads, through re-entering the token, indefinitely, with nothing anywhere to say why. The reason
  was invisible from the outside. The dashboard's listing request asks for every workspace at once, so
  there is no single workspace whose credential it could attach, and it attached none — and with no
  credential the server can neither discover a Provider-backed workspace's designs nor read them back.
  Put plainly: until this release, a deployment with no shared credential configured could not show a
  Provider-backed workspace at all, whatever you typed into the browser. The dashboard now follows up
  with one extra listing request per workspace that it holds a credential for and could not otherwise
  show anything for — naming that workspace, carrying only that workspace's credential — and folds the
  designs it finds into the main listing, replacing the "nothing registered yet" row. A credential the
  Provider turns down is now reported as rejected in Settings rather than looking like an empty
  workspace, and correcting it re-tries immediately instead of needing a page reload. Nothing extra is
  requested for a purely local dashboard, for a deployment that already shares that workspace's
  credential, or for a workspace the main listing could already show.

- **A malformed credential-map environment variable no longer echoes part of its own value into the
  deploy log.** Set `GANTRY_SHARED_WORKSPACE_PATS` (Gantry) or `GANTRY_MCP_WORKSPACE_PATS` (the MCP
  server) to something that isn't valid JSON — pasting a bare token where the workspace-id-to-token
  map was expected being the easiest way to do it — and the startup error used to quote the JSON
  parser's own complaint, which embeds the first several characters of what it was given. On a hosted
  deployment that put a prefix of your token into whatever log your platform keeps. Both services now
  state the shape they expected instead, and say outright that the value is being withheld because it
  holds credentials.

### Changed

- **The MCP server's `GANTRY_WORKSPACE_PATS` and `GANTRY_BASE_URL` are renamed to
  `GANTRY_MCP_WORKSPACE_PATS` and `GANTRY_MCP_BASE_URL`, with no aliases for the old names.** These
  are the *MCP server's* variables, not the Gantry server's — the MCP server is a separate process
  with its own deployment and its own environment, and this rename changes nothing about the variables
  `gantry serve` itself reads. If you run the MCP server, you must rename these two wherever you set
  them before you upgrade it: the old names are not read at all, so the server exits at startup saying
  `GANTRY_MCP_BASE_URL` is missing, and if it gets past that, every Provider-backed workspace fails
  with `missing_workspace_pat`. The values and their shapes are unchanged, only the keys. The reason
  for the churn is the mistake the old names invited: they read as though they belonged to the Gantry
  web service, and an operator who set them there got no error, no warning and no effect at all —
  silence, and a workspace that never showed its designs. An alias would have kept the confusable name
  in circulation, which is the thing being fixed.

### Added

- **Each service now tells you at startup about any `GANTRY_`-prefixed variable it doesn't read.** One
  line per variable, in the deploy log, at the moment you are still looking at it. A variable that
  belongs to the other service is named as such — "it belongs to the Gantry MCP server, a separate
  process. Set it there instead." — and a name that has been retired is answered with the name that
  replaced it, which covers anyone upgrading past this release's rename or 0.8.0-beta's. A near-miss
  on a real name gets the name you probably meant. This is a warning and never anything more: it does
  not block startup, because setting your own variables on your own deployment is legitimate. It never
  prints a value, only a name — several of these variables hold credentials, and a startup check that
  leaked one would be worse than the silence it replaces. A correctly configured deployment prints
  nothing at all.

## 0.8.0-beta — 2026-09-22

### Changed

- **`GANTRY_BOOTSTRAP_PATS` is renamed to `GANTRY_SHARED_WORKSPACE_PATS`, with no alias for the old
  name.** If you already set `GANTRY_BOOTSTRAP_PATS` on a deployment, you must rename it to
  `GANTRY_SHARED_WORKSPACE_PATS` when you upgrade — the old name is not read any more, silently or
  otherwise, so a deployment left on the old name simply stops discovering and sharing that workspace.
  The value and shape are unchanged, only the key. The rename reflects what the variable now does: it
  used to be a boot-time discovery shortcut, and now it is also the credential a shared workspace is
  actually read with on every unauthenticated request — a bigger claim than the old name let on, so the
  name had to say so.

### Added

- **A workspace can be declared shared, so a deployment can serve it to visitors with no credential of
  their own.** Add its id to `GANTRY_SHARED_WORKSPACE_PATS` and anyone who opens that workspace with no
  PAT of their own still sees its designs and instances, read from the deployment's own stored
  credential rather than being turned away. This is reading only: every edit still resolves the
  visitor's own credential, and before an editing surface is offered at all, that credential is checked
  against the Provider and confirmed to actually carry write access there — a personal PAT that happens
  to be sitting in the browser but grants nothing on this particular repo is treated as read-only, not
  as license to edit. A rejected credential and a merely-read-only one are kept visibly distinct, so a
  visitor is never told their token is bad when it simply isn't a writer here.

- **Every registered workspace now shows up on the main screen, including ones nothing could be read
  from yet.** Previously a workspace with no readable instances — nothing registered in it yet, or
  nothing the current request's credential could read — was left off the dashboard entirely, silently,
  indistinguishable from a workspace that was never registered at all. It now gets its own row either
  way, labelled to match what's actually true of it — nothing registered yet, or registered but
  unreadable with the credential in hand — each paired with the action that fixes it: add a credential.

- **A workspace's Settings can now be opened directly, by its workspace id, rather than only by way of
  one of its instances.** `/settings/workspace?id=<workspaceId>` resolves straight to that workspace,
  which matters most for exactly the workspace that needs it most — one with no instance yet to route
  through, the same workspace this release's dashboard and shared-browsing changes now surface for the
  first time. The existing `?slug=<instance-slug>` entry point is unchanged and still wins for an
  instance's own "Workspace Settings" link.

- **Shared-workspace reads are now cached, kept fresh by detecting change rather than by a timer.** A
  shared workspace's content is served from a per-branch cache instead of calling the Provider on every
  visitor's every read, so Provider read traffic no longer scales with how many people are looking —
  only with how often the content actually changes. Freshness is a cheap check against the branch's
  current commit, not a wait: an architect's own edit updates the cache immediately from the write
  itself, and anything pushed outside Gantry is picked up the moment the branch ref moves. The
  boundary is structural, not incidental — a request that brings its own credential never touches this
  cache at all, and nothing about it changes how a write behaves.

### Fixed

- **A GitHub- or GitLab-backed instance could have several of its own routes silently read or write the
  wrong data, or fail outright.** The synced-fields panel, gate checks, work-item linking, tag repair
  and stage-advancement routes all used to recognise only "Azure DevOps, or else assume local" — so a
  GitHub- or GitLab-backed instance sharing a slug with an unrelated local directory could have that
  local directory read or written instead of its real data, and a genuinely unresolvable registry entry
  could be mistaken for an ordinary local one rather than reported as broken. These routes now dispatch
  by the instance's actual registered provider, the same way every other single-instance route already
  did.

## 0.7.9-beta — 2026-09-22

### Added

- **A Provider-backed workspace now shows its id in Settings, with a Copy button.** Open the
  workspace's settings and the id sits directly under the repository location, as selectable
  monospace text you can copy in one click. That id is the key both credential maps are keyed by —
  the server's `GANTRY_BOOTSTRAP_PATS` and the MCP server's `GANTRY_WORKSPACE_PATS` — so on a hosted
  deployment you can now read it off the screen and paste it into your platform's environment
  settings without a shell, without devtools, and without digging it out of a deploy log. It
  identifies the workspace and is not itself a credential, which the note beside it says plainly.
  If the browser refuses the copy — plain-http `gantry serve` is not a secure context, so the
  clipboard is simply unavailable there — it tells you so and points at the id, which never leaves
  the screen. This is the browser-only counterpart to 0.7.8-beta's `gantry workspace-id` command,
  for anyone who does have a shell. Local and server-directory workspaces have no registry id and
  need no credential-map entry, so nothing is shown for them rather than something invented.

- **Settings now reports which version of Gantry the server is actually running.** A quiet line at
  the foot of the global Settings page, answered by the server itself on each visit rather than
  baked into the page you may have cached, so it is the version of the build serving you right now.
  Two things that were previously guesswork: confirming a redeploy really went out, and telling
  whether a fix you have just read about in these notes is in the build you are on. A server that
  cannot read its own package version says exactly that instead of showing a placeholder number,
  because a confidently wrong version here would be worse than none.

## 0.7.8-beta — 2026-09-22

### Added

- **A workspace's id can now be read straight off the command line, without booting a server.**
  `GANTRY_BOOTSTRAP_PATS` and the MCP server's `GANTRY_WORKSPACE_PATS` are both keyed by workspace
  id, and until now the only way to find one was to set the workspace up, start the server, read
  the id back out of the API, then restart with the credential map filled in. `gantry workspace-id
  --provider github --owner <owner> --repository <repo>` prints that id directly — the same id the
  server derives, on any machine, with no server and no registry file involved. Run it with no
  location at all and it reads your existing `GANTRY_BOOTSTRAP_WORKSPACES` declaration and prints
  one id per workspace; add `--json` and it emits a ready-to-paste `GANTRY_BOOTSTRAP_PATS` skeleton
  that you only have to fill the tokens into. No PAT is read, printed, or logged by the command —
  it deals in ids only.

- **`gantry serve` now names each bootstrapped workspace and its id at startup.** One line per
  workspace, giving the provider, the location, and the id it is actually registered under — so on
  a hosted deployment where you have no shell, the deploy log alone is enough to key
  `GANTRY_BOOTSTRAP_PATS`. Prefer that line over the command on a server that already has
  workspaces registered: `gantry workspace-id` prints the id a declaration *would* derive, while a
  workspace already registered at that location keeps the id it was first registered under.

## 0.7.7-beta — 2026-09-22

### Added

- **A Provider-backed workspace can now be declared in the environment and re-registers itself on
  every server start.** The new `GANTRY_BOOTSTRAP_WORKSPACES` variable names a GitHub, GitLab or
  Azure DevOps workspace once; from then on, every time the server boots, that workspace is
  registered automatically rather than relying on whatever happened to survive in the registry.
  Its id is derived from the provider and repo location it was declared with, so it's the same id
  across restarts — a fully wiped registry comes back looking exactly like it did before, and
  anything that referenced the workspace by id keeps working. The bundled Examples workspace isn't
  a Provider-backed workspace and is unaffected either way.

- **A redeclared workspace's instances now find their way back on their own.** Once a workspace is
  registered — whether freshly bootstrapped or already there — its instances are discovered from
  its repo automatically the first time a request carrying a working credential for it arrives, so
  a restart no longer leaves a workspace looking empty until someone manually re-syncs it.

- **Optionally, instance discovery can also run at boot, not just on first request.** The new
  `GANTRY_BOOTSTRAP_PATS` variable is off by default; set it to map a bootstrapped workspace's id to
  a credential, and that workspace's instances are discovered at startup instead of waiting for the
  first authenticated visitor — useful for an unattended deployment, such as the hosted demo, where
  nobody logs in right after a restart. Deployments that don't set it see no change in behaviour.

## 0.7.6-beta — 2026-09-22

### Added

- **`recruitment-onboarding/2` is published.** 0.7.5-beta shipped it as a `draft`, pending
  process-owner sign-off on its new dropdown wording — that sign-off is given, and it's now the
  process's published, immutable second version. v1 stays published and unchanged, so Instances
  already in flight against it are unaffected.

- **The bundled `platform-engineer` example is now on v2.** Its content is migrated onto the new
  typed Fields — dropdowns, a candidate name, a start date — with every piece of its original
  detail kept, moved into whichever Field still takes prose where a typed Field replaced it. One
  value, an identity-verification check with no matching dropdown option, is kept and flagged
  rather than dropped, exactly as a hand-typed value outside a Field's option list always is.

- **The Gantry MCP server can list a Provider-backed workspace's own Definitions.**
  `list_definitions` now accepts an optional workspace, so an agent working against an Azure
  DevOps, GitHub or GitLab workspace can discover what Definitions live there instead of needing
  to already know a Definition's id.

## 0.7.5-beta — 2026-09-21

### Added

- **Dropdowns, single-line text and date pickers, as Field types a Definition can declare —
  including authoring them in the Definition editor.** Until now every Field was either a
  paragraph or a bullet list, even where the Definition's own guidance already named the only
  valid answers — an engagement type, an offer status, a vetting outcome. A Field can now be
  `type: select`, offering a dropdown of the answers a Definition author has decided are valid
  (optionally several at once, as tick-boxes, with an optional default), `type: text` for a short
  single-line fact such as a name, or `type: date` for a calendar date entered through your
  browser's own date picker rather than typed. The Definition editor's Field type picker offers
  all three directly — adding, reordering and removing a select's options is a few clicks, no YAML
  editing required. A value that no longer matches a select's option list — hand-edited, or left
  behind by a changed Definition — is kept and flagged rather than silently discarded.

- **Rendered documents can be named from their own content — and the editor helps you write the
  pattern.** An Artefact may now declare a `filename:` pattern such as
  `{selection.candidate-name} - Offer Pack - {contract.start-date}`, resolved against the
  Instance's own data at render time — so a document that leaves your organisation identifies
  itself (`Jane Smith - Offer Pack - 2026-11-03.docx`) instead of arriving named only after the
  process that produced it. An Artefact with no pattern renders exactly what it always has. The
  Definition editor shows which Fields are eligible as tokens for each Artefact and flags a
  pattern immediately if it references a Field that doesn't exist, isn't the right type, or isn't
  required by that Artefact. When a render's resolved name changes — a corrected candidate name, a
  moved start date, an Instance renamed — the previously rendered document under the old name is
  now removed automatically, so `out/` holds exactly one current document per Artefact rather than
  an accumulating pile of near-duplicates.

- **A second version of Recruitment and Onboarding**, `recruitment-onboarding/2`, built on both
  features above — seven Fields whose answers v1's own guidance already enumerated are now
  dropdowns, two become tick-box multi-selects, a candidate's name and a start date are split out
  of prose into their own typed Fields, and every rendered document is named from the Instance's
  own content. v1 is completely unmodified — Instances already in flight against it keep
  rendering exactly what they always did. v2 ships as a `draft`, not `published`: every option
  list it introduces is traceable to wording already in v1's own guidance, but confirming that
  wording with the process owner before locking it into an immutable published version is a
  manual follow-up, not part of this release.

### Notes

- **A Field's type is fixed by the Definition, not editable per Instance.** If a dropdown's
  choices look wrong, that's a change for whoever maintains the Definition, not something an
  Instance author can work around by typing something else.

## 0.7.4-beta — 2026-09-21

### Added

- **A second process definition ships with Gantry: Recruitment and Onboarding.** Until now the
  only definition in the box was Solution Design, which made Gantry look like a tool for
  architecture practices. It is not — the engine runs any staged, gated process, and this is the
  proof. One instance is one hire: it opens when a vacancy is identified and closes on the
  starter's first day, through four stages — Requisition, Selection, Appointment, Provisioning —
  each owned by a different part of the organisation and each with its own sign-off.

  It produces seven documents, from the requisition brief that makes the case for recruiting,
  through the selection report and the offer pack, to a complete hire record that is the file you
  keep. Create an instance from it the same way you would for a design initiative; nothing about
  running it is different.

- **A worked example you can read before you commit to anything.** The bundled Examples workspace
  now includes a completed hire — a Contoso Platform Engineer — filled in across all four stages,
  and the "Populate example text" button on every field draws from it. It is deliberately not a
  tidy run: payroll validation failed once and cost five days, the hardware was non-standard with
  no agreed way of deciding that, and the building pass turned up the day after the new starter
  did. That is what the definition is for.

### Notes

- **Recruitment and Onboarding records the process as it is, not as it should be.** Where the
  process has known weak points — payroll details requested by an email that nothing notices
  going unread, account credentials sent to a personal mailbox, two steps nobody has ever written
  down — the definition asks you to record what actually happened rather than quietly assuming
  the better version. Filling those fields in honestly is how the case for changing any of it
  gets made.

- **It does not ask for candidate bank details, and it never will.** Payroll fields record that
  details were requested, supplied and validated, and what went wrong if anything did — not the
  details themselves. Vetting records which checks applied and whether they cleared, not what
  they found. Instance content is stored as plain files in your repository, and none of that
  belongs there.

- **Approvals stay where they already are.** The definition has no "approved by" field for you to
  fill in. Approving a stage is what the sign-off on that stage already does, and that record is
  the one that counts.

## 0.7.3-beta — 2026-09-21

### Fixed

- **Pages no longer go blank, or load only partly, on a busy or constrained
  server.** Every page load asked the server to re-check all ~40 bundled
  third-party libraries, every single time — around forty separate requests
  fired off at once, on top of everything else the page needs. A server under
  any strain could drop some of them, and because the app is assembled from
  those pieces in the browser, losing even one left a blank screen with nothing
  to explain it. Those libraries are now downloaded once and kept, so a repeat
  visit asks for none of them. Gantry still picks up a new version
  immediately — upgrading changes what the browser asks for, so there is no
  stale-cache trap and no hard reload to remember. Nothing to do; it applies
  from the first page load after upgrading.

## 0.7.2-beta — 2026-09-19

### Changed

- **Renamed "TAC (Technical Architecture Committee)" to "ARB (Architecture Review Board)"** as the `design` definition's own name for the governance body that approves the HLD — a more generic, industry-recognisable term already used by some of the real source material. Updated everywhere gantry's own content and documentation named the committee: the HLD-approval gate, the glossary, the user guide, and the two bundled example instances. The actual real reference document's own title ("2026 TAC Architecture High Level Solution Design Template") is unchanged — that's a citation, not gantry's own vocabulary. See `definitions/design/2/CHANGELOG.md`'s "Round five" entry for the full scope.

## 0.7.1-beta — 2026-09-19

### Fixed

- **Settings and the "+ New Workspace" wizard no longer assume every workspace is on Azure DevOps.** The Advanced-mode description, the Workspace Settings "no workspace" message, and the wizard's adopt-by-URL guidance now speak generically across all four Providers instead of naming only Azure DevOps.
- **Removed the leftover "Default ticketing system" setting** (Settings, and its per-workspace override) — a pre-Provider-model control that only ever did anything for Azure DevOps and had become actively misleading now that Jira support genuinely exists through Atlassian. The Provider chosen per workspace has fully decided the work-item tracker since GitHub shipped; this setting was never cleaned up afterward.
- **The "+ New Workspace" wizard's parent-work-item link step is now reachable for GitHub, GitLab and Atlassian workspaces.** It was silently skipped for every Provider except Azure DevOps due to a check against the setting removed above — a real gap, not just stale copy.
- Removed the stale `Contoso-Production` placeholder pre-filled into the Organization field when registering a new Azure DevOps workspace.

## 0.7.0-beta — 2026-09-19

### Added

- **GitHub, GitLab and Atlassian (Bitbucket + Jira) as Providers** (docs/adr/0041, docs/adr/0042): alongside Azure DevOps, a workspace or library repo can now live on GitHub, on GitLab (gitlab.com or self-hosted CE/EE, with a configurable base URL), or on Atlassian (Bitbucket Cloud for the repo, Jira Cloud for work items). Each gets the full set of existing capabilities: stage branches, pull/merge-request-gated sign-off, work-item linking, Request Review, Promote to a library repo, and repo adoption. An Atlassian workspace is entered with two Personal Access Tokens (one for Bitbucket, one for Jira) rather than one, since they're separate products.
- **Reviewer/sign-off states are read natively per Provider**: GitHub's Approved/Changes Requested/Commented, GitLab's approve-toggle-plus-discussion-threads (with Premium/Ultimate Approval Rules honoured where configured), and Bitbucket's own Approved/Changes Requested states each map onto Gantry's own approved/changes-requested/pending reading, so "Request approval" and "Check status" behave consistently regardless of which Provider a workspace is on.

### Notes

- GitHub, GitLab and Atlassian support is new in this release and has not yet been fully exercised in UAT. Azure DevOps remains the most extensively used path. Teams adopting one of the three newer Providers should validate their own stage sign-off, work-item sync and Promote workflows before relying on them for anything business-critical, and report anything unexpected.

## 0.6.8-beta — 2026-09-14

### Added

- **Promote** (WI #387): a published workspace definition version can now be
  promoted back to any number of configured library repos in one step. For
  each repo you pick, Gantry opens a new `definition/<id>-v<n>` branch off
  its default branch, pushes the full version folder (definition, modules,
  templates, reference document, changelog) as a single commit, and opens a
  Pull Request with that repo's configured code owner attached as a required
  reviewer — Gantry never writes to a library repo directly; the code
  owner's own review and merge in Azure DevOps is what actually publishes
  it. Promoting to several repos at once is independent per repo, so one
  repo being unreachable doesn't stop the others. The Definitions page shows
  each promotion's Pull Request link and status underneath the definition,
  refreshed by a new **Check status** button rather than polled. Each
  library repo can now carry an optional **code owner** in Settings,
  editable at any time. This completes Feature #380 (First-class Definition
  Editor) across all seven phases.

## 0.6.7-beta — 2026-09-14

### Added

- **Local-workspace definitions** (WI #384): a local workspace (one opened
  straight from a folder on your own machine, with no gantry server
  involved in storing it) can now hold its own definitions alongside its
  instances, the same way a server or Azure DevOps workspace already could.
  Open a local workspace on the dashboard and follow its "Local
  definitions" link to create, edit and publish one — saved straight to
  that workspace's own `definitions/` folder as you go, never sent to or
  stored by the gantry server. The "+ New Instance" wizard now offers a
  local workspace's own definitions alongside the library when you pin an
  instance to one, and that instance's status, gate checks and renders all
  work exactly as they would for a library definition — validation,
  publish checks and rendering run through the same stateless, nothing-
  stored request the server already uses for local-workspace instances.
  Because the server can't see what other local workspaces are doing, a new
  definition's id is only checked against the shared library at creation
  time, not against other people's local workspaces — pick a distinctive
  id to avoid a same-id collision nobody but you can be warned about.

## 0.6.6-beta — 2026-09-14

### Added

- **Library repos** (WI #386): Global Settings can now list additional Azure
  DevOps repos as read-only sources for the server library, alongside the
  built-in `definitions/` directory. A definition from a library repo shows
  up everywhere the packaged library's own definitions do — the Definitions
  switcher (grouped by repo), the docked Library panel as a copy source, and
  as a pinnable target for a new instance — but it can't be edited directly:
  it's viewable, copyable-from, and clonable into a workspace, never
  archivable or publishable in place. Content is read with the server's own
  PAT and cached to disk; the cache is re-read at server startup, the moment
  a repo is added, and on the Definitions page's new Refresh button — never
  polled. If a library repo goes unreachable, anything already cached
  (including a running instance pinned to one of its definitions) keeps
  working from that cache rather than failing. If two sources define the
  same id, the first one configured wins and the clash is reported as a
  problem on the Definitions page rather than blocking everything else.

## 0.6.5-beta — 2026-09-14

### Added

- **Workspace definitions** (WI #383): a server workspace or an Azure DevOps
  workspace can now hold its own definitions, alongside — never instead of —
  the server library. A definition's home works exactly like the library
  already does: draft/published versions, an archive marker, the same
  editor. Definition ids are unique across the library and every workspace,
  so creating one with an id already in use elsewhere is refused rather than
  silently shadowing it. Saving or publishing a definition in an Azure
  DevOps workspace commits straight to that workspace's `main` — one commit
  per save, no review branch.
- The Definitions page switcher now groups definitions by home ("Server
  library" / "Workspace: `<name>`"), and creating a new definition lets you
  choose which one to create it in. Copying stages, artefacts, modules and
  fields between definitions (WI #382) now also offers other definitions in
  the *same* workspace as sources, alongside the library — other workspaces
  stay private. The "+ New Workspace" wizard's definition picker now also
  lists the definitions already available in the workspace you're creating
  an instance in.
- An instance pinned to a workspace definition resolves it from that
  workspace first, falling back to the library only if it isn't found
  there — matching how the server has always resolved an instance's own
  data.

## 0.6.4-beta — 2026-09-14

### Added

- **Replace and Download for an artefact's reference `.docx`**, from the
  artefact focus pane in the Definitions editor (WI #385). Previously the
  only way to change the Word styling template an artefact renders into was
  to edit the file directly in the definitions folder. Replace checks the
  upload really is a `.docx` (not just its file extension) before accepting
  it, and — like every other edit in the Definitions editor — only works on
  a draft; a published version offers Download only, with a clear error if
  something tries to replace it anyway. Currently covers definitions in the
  server library; workspace-hosted definitions (server/Azure DevOps and
  local) get the same treatment once those homes exist (WI #383/#384).
- **Copy elements from another definition, with provenance** (WI #382). The
  Definitions page's docked Library panel is no longer read-only: drag a
  stage, artefact, module or field out of it onto the outline, the map, or a
  focus-pane drop list, or use the new "From another definition…" option next
  to any "+ Add…" control. Before anything lands, a confirm panel shows
  exactly what's coming along — copying a stage brings the modules you don't
  already have, copying an artefact brings its template and every module its
  requirements need — and, if the id already exists in your definition,
  offers rename (keep both), replace, or merge, per element kind. A copied
  element is completely independent afterwards (never a live link back to
  where it came from) and carries a "from `<id>` v`<n>`" badge in the outline
  and focus pane so you can always see its origin.
- Dropping a field onto an artefact adds it as a requirement (bringing its
  module along too, if you don't have it yet) — the same "field visibility
  per artefact" model artefacts already use for their own fields.

## 0.6.3-beta — 2026-09-14

### Added

- **Definitions page rebuilt as a first-class editor** (WI #381), replacing the
  old rudimentary screen. One `/definitions` route (the "experimental"
  `/definition-editor` alias is gone) opens straight into an editor built
  around two switchable navigation views over one focus pane: **Outline**
  (the default) lists Stages, Artefacts and Modules as three flat groups;
  **Map** lays the pipeline out spatially, with each stage as a column of
  module chips and its gate's artefacts hanging underneath. Your choice is
  remembered next time.
- **Every field is directly editable on a draft** — no separate Edit mode.
  A module's fields are compact rows; click one to expand, edit and collapse
  it again, one at a time. Stages, artefacts, modules and fields can all be
  reordered, or moved between a stage/artefact/module, either by dragging or
  with an equivalent button (Move up/down, "+ Add module…", "+ Add
  requirement…", "Move to module…") — every drag has a working button next
  to it.
- **Live validation markers.** The toolbar shows a running problems count —
  checked against the exact same rules Save and Publish already enforce — and
  clicking it jumps straight to the affected stage, artefact or module, which
  also carries its own marker in the Outline or Map.
- **Template editing opens as its own view**, on a proper markdown editor
  instead of a plain textarea.
- **New definition: Blank or Clone**, from the definition switcher.
- **Save now follows the stage-editor convention**: one Save for everything
  changed since the last save, and a Save / Discard / Cancel prompt if you
  try to switch definition or version with unsaved changes still on screen.
- A docked **Library** panel lists another definition's elements for
  reference alongside whatever you're editing (still read-only — pulling
  items from it arrives in a later release).

## 0.6.2-beta — 2026-09-13

### Fixed

- **Mode, Artefact and Navigation open the same kind of list** (WI #379).
  Artefact used the browser's own list, which sat flush against the box and
  looked different; it now opens Gantry's menu, below its button with the same
  gap, border and shadow as Navigation, and Mode's list matches it too. The
  current choice is marked the same way in Mode and Artefact.
- **One text size across all three dropdowns**, both the buttons and their
  lists.
- **Only one dropdown is open at a time.** Opening one now closes any other,
  instead of leaving Navigation's list open underneath.

## 0.6.1-beta — 2026-09-13

### Fixed

- **The Save button lines up with Mode** (WI #377). It sat lower than the
  **Mode** dropdown beside it, with an oversized gap between them; it is now
  level with it, spaced like the rest of the toolbar.

### Changed

- **Mode, Artefact and Navigation look like one set of controls** (WI #378).
  Mode now has an upper-case **MODE** label to its left, like **ARTEFACT**, and
  its button shows just the current view (for example "Visual ▾"). The Artefact
  selector has the same button style as Mode and Navigation.

## 0.6.0-beta — 2026-09-13

### Changed

- **One Save button for the whole stage** (WI #376). A disk button now sits at
  the top left of the editor toolbar, beside **Mode**, and saves every module
  on the stage that has changed. It turns blue only while something differs
  from what's saved — undo back to the saved text and it greys out again.
  `Ctrl+S` (`⌘S` on a Mac) does the same. The Save button at the bottom of each
  module card is gone; each card still shows its "Saved — complete" or
  "Saved — outstanding" line.
- **You are asked before unsaved work is lost.** Switching stage, switching
  instance, following a header link or pressing browser Back with unsaved
  changes asks **Save / Discard / Cancel**, and so do **Render**, **Advance**
  and **Request Sign-off**. Closing or refreshing the tab shows the browser's
  own warning.
- **Saving no longer re-renders documents** on Azure DevOps-backed instances
  (ADR-0034). One Save is now one commit containing just the changed module
  files, instead of a commit per module plus two per document. Documents are
  rendered and committed only when you click **Render**, so render before
  requesting sign-off if the Pull Request should include up-to-date documents.

### Fixed

- **Horizontal rules show as a rule in Visual view** instead of `---`. The
  markdown still appears on the line your caret is on, so you can edit it.

## 0.5.1-beta — 2026-09-13

### Changed

- **You can always see which pane you are typing in** (WI #375). The editor
  pane that has focus now carries a thick frame — including while you are
  typing in one of its Visual table cells — and in Split view the other pane
  fades back, so it is obvious whether you are editing the Markdown or the
  Visual side.

## 0.5.0-beta — 2026-09-13

### Added

- **Visual view: edit a field the way it reads** (WI #374). Markdown fields now
  open in a new **Visual** view, where headings, bold and italic, code, quotes,
  links, images and Mermaid diagrams are drawn as they will appear and edited in
  place. Tables are real grids: click any cell to type, Tab between cells (Tab
  from the last cell adds a row), hover a table's top or left edge for column
  and row handles that insert, delete, re-align and — by dragging — move columns
  and rows, and use the corner handle to delete the whole table. A diagram's
  text is edited from an **Edit diagram text** pop-over. Nothing about how your
  content is stored changes: a field you open and save without editing is
  written back byte for byte, and editing one table cell changes only that row.
- **Undo and Redo on the formatting toolbar**, covering every change in a field
  whichever view it was made in.

### Changed

- **The view switcher is now a Mode ▾ dropdown: Visual, Split, Markdown**, with
  Visual the default. Split now shows the raw Markdown beside the Visual view,
  both editable, with one formatting toolbar that acts on whichever side you are
  working in. `Ctrl+Shift+V` cycles the three views in that order.
- **Rendered view is gone** — Visual replaces it. Editing controls are now hidden
  only on an archived instance, which is read-only in every view.
- In **Markdown** view the table button strip still appears while the caret is
  in a table; Visual and Split use the table's own handles instead.

## 0.4.10-beta — 2026-09-11

### Fixed

- **Gantry's commands now work wherever you run them** (WI #371). `gantry
  definitions` reported "No definitions found." and `gantry new design
  my-initiative` failed with "Definition "design" has no version 1" unless the
  directory you happened to be standing in was a copy of the Gantry source
  repository. The definitions that ship with Gantry are now found from any
  directory, the way `gantry serve` already found them. If the directory you're
  in has a `definitions/` folder of its own it still takes precedence, so
  working inside a Gantry checkout is unchanged, and `--definitions-dir <path>`
  names one explicitly.
- **A missing definitions folder says so** (WI #371), instead of reporting the
  definition itself as having no version 1 — which sent you looking at the
  definition when the problem was that Gantry never found a definitions folder
  at all.

## 0.4.9-beta — 2026-09-11

### Fixed

- **The command line can see your instances again** (WI #370). `gantry
  instances` reported "No instances found." in a directory that plainly had
  them, and `gantry status`, `gantry check` and `gantry render` failed outright
  on any instance you hadn't pointed them at by hand. Gantry 0.4 moved where
  instance data is stored — into a workspace folder, one level deeper than
  before — and the web app was taught the new layout while the command line was
  not, so the two disagreed about the very same directory. They now share one
  answer, and the command line lists exactly what the dashboard does.
- **An instance you create on the command line survives starting the web app**
  (WI #370). `gantry new` wrote its instance in the old location; the first
  `gantry serve` moved it to the new one; after that the command line could no
  longer find the instance it had just made. `gantry new` now creates instances
  where the web app already puts them, so nothing is moved and nothing goes
  missing. Instances made before this change are picked up automatically.
- **`gantry validate --version` and `gantry new --version` work again**
  (WI #370). Since 0.4.8-beta these were being read as a request for Gantry's
  own version number: the command printed `0.4.8-beta` and did nothing else.
  They once again mean the *definition* version, and `gantry --version` still
  reports the build you're running.
- **`gantry backfill-numeric-refs` now runs against the directory you point it
  at** (WI #370). It always used the pre-0.4 location regardless of
  `--workspaces-dir` or `GANTRY_WORKSPACES_DIR`, so it reported nothing to do
  while leaving real instances unnumbered.
- **Errors read like errors** (WI #370). A mistyped instance or definition name
  printed a page of internal Node detail. It now prints one line saying what
  was wrong — and, when an instance isn't found, which ones do exist. Set
  `GANTRY_DEBUG=1` if you want the full technical detail back.
- **`gantry serve` no longer leaves uncommitted changes behind** in a Git
  checkout of Gantry itself (WI #370).

### Added

- **`gantry definitions`** (WI #370) — previously a placeholder that printed
  "not yet implemented". It lists the definitions available to you with their
  stages and versions, and takes `--json` like the other listing commands.
- **Workspace-qualified names on the command line** (WI #370). Instances are
  now listed as `workspace/slug`, and any command taking an instance name
  accepts that form. It matters when the same name exists in two workspaces:
  previously one was picked silently, and now Gantry says which two it found
  and asks you to be specific.

## 0.4.8-beta — 2026-09-11

### Added

- **`gantry --version`** (WI #369). There was no way to ask Gantry which build
  you were running — the flag simply didn't exist — which made "did my upgrade
  take effect?" surprisingly hard to answer. `gantry --version` (or `-V`) now
  reports it, and reports it for the install actually being run, even when
  that's a symlink on your PATH invoked from somewhere else entirely.
  `gantry new --version` and `gantry validate --version` are unchanged and
  still refer to a *definition* version.

## 0.4.7-beta — 2026-09-11

### Fixed

- **Upgrading Gantry no longer leaves an open browser tab running the old
  version** (WI #368). If you had Gantry open in a tab, upgraded the server and
  carried on in that same tab, the page could keep running the *previous*
  version's code against the new server — with no sign anything was wrong, and
  no fix other than a hard reload nobody knew to do. It also made "did my
  upgrade actually take effect?" impossible to answer from the outside. Pages
  and scripts now tell the browser to check with the server before reusing
  them, so an upgrade is picked up on the next navigation. Unchanged files are
  still not re-downloaded, so this costs nothing in day-to-day use.

## 0.4.6-beta — 2026-09-11

### Fixed

- **Diagrams you upload are no longer missing from rendered Word documents**
  (WI #367). An image looked right in the Gantry preview but came out of the
  .docx blank — silently, with the render reporting success. Mermaid diagrams
  were unaffected, which made it look like a content problem rather than a
  rendering one. The cause was the browser-based render engine: it was told
  where each image lived on the *server's* disk, which means nothing inside a
  browser, so Word documents were built with the pictures left out. The images
  now travel to the browser with the document text. Nothing to change in your
  own instances, and anything you rendered without its diagrams just needs
  rendering again. This affected server-hosted instances from 0.4.1-beta
  onward, and Azure DevOps-backed instances for longer.

## 0.4.5-beta — 2026-09-11

### Fixed

- **Instances in different workspaces can now share a slug** (WI #366). Two
  workspaces each holding an instance with the same name used to break: the
  server looked a slug up by searching every workspace for it, and when more
  than one matched it gave up rather than choosing, so that instance could not
  be opened at all and there was no way to say which one you meant. The server
  now resolves an instance within the workspace it actually belongs to, so
  identical slugs in different workspaces are no longer a collision. Nothing to
  change in your own workspaces — existing links, bookmarks and numbered
  references keep working exactly as before.
- **The log no longer fills with deprecation notices you could not act on**
  (WI #366). Running Gantry logged `resolved via a bare, workspace-unqualified
  slug (deprecated, WI #356)` on essentially every request, recommending a
  `<workspace>/<slug>` form that the server did not actually accept. That form
  now works, the app uses it, and the notice is back to meaning what it says —
  something addressed the old way and can be moved to the new one.

## 0.4.4-beta — 2026-09-10

### Changed

- **The built-in "Gantry hosting" example now says what Gantry's own build
  pipeline does and does not check for security** (WI #365). This is the
  example text the Solution Design editor offers at the SOAP stage, so it is
  the wording other people start from. It previously said nothing about the
  assurance behind the container image the proposal runs, which invited the
  assumption that a pipeline-built image had been security reviewed. It has
  not been: the build gates every merge on the full test suite, coverage
  thresholds and a successful render, and performs no static analysis, no
  dependency vulnerability scan and no image scan. The example now states
  that plainly — including the hardening that *is* real (production
  dependencies only, non-root runtime, no public endpoint) — carries the
  missing scanning as an estimate caveat, and raises it as an open question
  owned by the network and security team rather than presenting it as
  something already done.

## 0.4.3-beta — 2026-09-10

### Fixed

- **The "Source:" citation under a diagram now opens the file it names**
  (WI #364). Clicking the citation beneath an embedded diagram appeared to do
  nothing useful: the address bar changed to the asset's file address, but the
  Workspaces home screen came up instead of the image — and any unsaved edits
  in the module you were in went with it. The click was never leaving the
  browser: the app was treating the link as a move to another screen, found no
  screen at that address, and fell back to the dashboard. The file itself was
  being served correctly the whole time. Citations now open in a new tab, so
  the file loads and you keep your place — and your unsaved edits — in the
  module editor. Any other link in a module's text behaves the same way; only
  in-page links to a heading still jump within the page.


## 0.4.2-beta — 2026-09-10

### Fixed

- **The Full Solution on a Page no longer carries the HLD's committee footer**
  (WI #363). Every page of a Full SOAP rendered to Word was footed
  "Technical Architecture Committee – High Level Solution Design" — a
  governance body that document never goes to, on a document people were
  circulating for a decision. The Full SOAP now uses the same neutral footer
  as the Solution on a Page (page number and the Contoso strapline); the HLD is
  still footed with the Technical Architecture Committee, which is correct
  for it. Re-render any Full SOAP you have already produced to pick up the
  corrected footer — the fix is in the template, not the document. This
  affects both the installed-Pandoc and the in-browser render, and both
  published versions of the Solution Design definition.
- **A new artefact can no longer silently inherit another artefact's footer.**
  The shared fallback template every artefact falls back to when it has no
  template of its own no longer names any committee, and the build now fails
  if an artefact is added without its own Word template — so the next
  artefact cannot repeat this.

## 0.4.1-beta — 2026-09-10

### Added

- **A docx/md toggle in the Render dialog** (WI #359). A new radio choice sits
  immediately left of the Render button, defaulting to docx. Choosing md
  renders only the Markdown — no `.docx` is produced at all — and choosing
  docx (the default) no longer leaves a stray `.md` file behind next to it;
  the Markdown is still compiled as an internal step (Pandoc needs it), but
  it's no longer written anywhere. This applies across every instance kind
  and both render engines. Mermaid diagrams keep rendering correctly either
  way — as an image in the docx, as the original fenced code in the md.

### Changed

- **Rendering a server-hosted instance now downloads the file to your browser
  instead of saving it into the repository** (WI #360). Previously, clicking
  Render on an instance stored under a `workspaces/<workspace>/` directory on
  the server wrote the result into that instance's own `out/` folder, the
  same way an Azure DevOps-backed instance's render is pushed to its repo.
  That made sense for Azure DevOps, where `out/` is the shared, durable
  record — but for a server-hosted instance there was no equivalent reason to
  persist it there, and it meant this second copy is what a browser download
  now replaces. Nothing changes for an Azure DevOps-backed instance (still
  pushed to the repo) or a local workspace opened in the browser (still
  written into the folder you picked) — this is specific to the server-
  hosted case introduced by the workspace-directories work (WI #355-358,
  0.4.0-beta).

## 0.4.0-beta — 2026-09-10

### Added

- **Server workspace directories** (WI #355/#356/#358, `docs/adr/0031-server-workspace-directories.md`).
  A server-hosted instance's data now lives inside a **server workspace** — a
  folder with its own `workspace.json` (the same format a Local workspace
  already uses, plus an optional `description`), holding one or more
  instances — instead of the old flat `instances/<slug>` layout with no
  grouping above it. Two different server workspaces can each have an
  instance with the same slug; the dashboard shows one row per workspace,
  with every instance — server workspace or Local workspace alike — getting
  the same full status card (stage, complete/incomplete badge, assignee,
  updated, Edit/Check).
- **`GANTRY_WORKSPACES_DIR` / `--workspaces-dir`** replace `GANTRY_INSTANCES_DIR`
  / `--instances-dir` as the primary way to point Gantry at its data,
  default `workspaces/`. The old names keep working everywhere, resolving
  to the same value with a one-line deprecation notice logged — nothing
  breaks for an existing install that hasn't switched yet.
- **Automatic migration.** The first time `gantry serve` starts against a
  pre-0.4 flat data directory, every bare instance directory it finds moves
  into a new, reserved `default` server workspace, preserving every
  instance's numbered reference and archived state exactly — a bookmarked
  or linked `w0i1`-style URL keeps working unchanged. `gantry migrate-workspaces
  --dry-run` shows the same mapping first, without touching anything.
- The bundled example data moves onto the new shape: `workspaces/examples/`
  now holds both `kiwi-cover-mutual` (the Kiwi Cover Mutual worked example,
  previously the single `examples` instance) and `gantry` (Gantry's own
  hosting SOAP, WI #354) — one workspace, two instances, matching what the
  dashboard shows.

### Changed

- CLI commands (`new`, `status`, `check`, `render`, `instances`, `serve`)
  all resolve their data directory through the new `--workspaces-dir` /
  `GANTRY_WORKSPACES_DIR` precedence, with `--instances-dir` /
  `GANTRY_INSTANCES_DIR` kept working as deprecated aliases.

## 0.3.1-beta — 2026-09-10

### Changed

- **The bundled `gantry` example now proposes Azure Container Apps instead of
  virtual machines** (WI #354). Engineering review pointed out that Container
  Apps provides the load balancing, health probing, always-on replicas,
  revision-based deployment and log collection that the VM design would have
  assembled by hand, so the Full SOAP's overview, topology diagrams, feature
  breakdown, dependencies, sequencing, caveats and open questions were rewritten
  around it. The VM design stays in the Alternatives sketch as the rejected
  option. No application behaviour changes in this release.

## 0.3.0-beta — 2026-09-10

### Added

- **Mermaid diagrams render in the preview and in exported Word documents**
  (WI #353). Put a fenced ```` ```mermaid ```` block in any markdown field
  and the editor preview shows the diagram instead of the source. When you
  Render with the default WASM engine, the `.docx` carries the diagram as an
  image; the `.md` written beside it keeps the Mermaid source so it stays
  editable. A block Mermaid cannot parse stays as source with a short error
  note under it, and never stops the rest of the render. Two limits to know
  about: the Native Pandoc engine and the `gantry render` command still
  export the block as source text, and HTML markup inside diagram labels is
  not supported.

## 0.2.3-beta — 2026-09-09

### Removed

- **The zip-release install path has moved off `main`** (WI #352). `install.cmd`,
  `run.cmd` and the pipeline that packaged them into a downloadable zip now live
  on the `zip-release` branch, cut from `main` at 0.2.2-beta. Nothing about a
  normal install changes: clone the repository, `npm install`, `npm link`, then
  `gantry serve` — the same on Windows, macOS and Linux. If you installed from a
  zip or used `install.cmd`/`run.cmd`, that copy keeps working and keeps getting
  fixes on the `zip-release` branch, but releases from `main` no longer produce a
  zip. The corporate-proxy guidance those scripts automated is still in
  README.md as the manual `NODE_USE_SYSTEM_CA` step.

## 0.2.2-beta — 2026-09-09

### Fixed

- **A TLS-inspecting corporate proxy no longer breaks `install.cmd`** (WI #350).
  Behind Zscaler, the installer downloaded the portable Node ZIP fine and then
  died on the first npm tarball with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`: the
  proxy re-signs every HTTPS response with a CA that Windows trusts but Node does
  not, and curl (which uses the Windows store) sailed through while npm did not.
  `install.cmd` and `run.cmd` now set `NODE_USE_SYSTEM_CA` themselves and export
  the Windows root stores to `.node-runtime\windows-ca.pem` for
  `NODE_EXTRA_CA_CERTS`, so the documented manual `setx` step is no longer
  needed — it was easy to apply and still have no effect, because `setx` only
  reaches processes started afterwards. Both mechanisms only *add* trust anchors;
  certificate verification stays on, and nothing is written to the user's
  persistent environment or the registry. `run.cmd` gets the same treatment
  because the same proxy would otherwise break Gantry's own Azure DevOps calls at
  runtime.

## 0.2.1-beta — 2026-09-08

### Fixed

- **Local instances render through WASM Pandoc rather than native Pandoc**
  (WI #349). A local instance's render went down the native path and failed with
  `spawnSync pandoc ENOENT` on a zip-release install, where no native Pandoc is
  present — despite the web UI defaulting to the in-browser WASM engine
  everywhere else.

## 0.2.0-beta — 2026-09-08

### Changed

- **The `examples` fixture is now a fully populated design v2 mock** — Kiwi Cover
  Mutual, exercising every diagram in the SAD template, with local-file asset
  citations (WI #348). Replaces the previous thin fixture, so the bundled example
  shows what a genuinely complete instance looks like.

## 0.1.2-beta — 2026-09-08

### Added

- **Definition Reference Guide (Contoso Solution Design)** in the in-app User Guide
  (WI #347).

## 0.1.1-beta — 2026-09-04

### Fixed

- Local-workspace asset images, plus two zip-release install bugs.
- The user guide reconciled against actual app behaviour.

### Changed

- Removed the redundant `slug=` query parameter from local instance URLs.

## 0.1.0 — 2026-09-03

Initial tagged release. Headline capabilities at this point:

- **Local workspaces** — instance data in a folder on the browser user's own
  machine via the File System Access API, alongside server-hosted (Azure DevOps)
  workspaces (ADR-0029).
- **Advanced mode** — hides the Azure DevOps surfaces for people who only ever
  work locally.
- **The `design` definition, version 2** — SOAP, HLD, SAD, SSAD and As-built
  artefacts with per-artefact field-level requirements.
- **WASM Pandoc as the default render path**, with a Settings toggle to native
  Pandoc and automatic fallback (WI #314).
- **`install.cmd` / `run.cmd`** — a no-admin-rights install and one-step launcher
  for locked-down corporate Windows machines, using Node's portable ZIP build
  (WI #327, #332, #335, #336, #337, #338, #339).
- **The zip-release pipeline** — a trimmed, runtime-only, Git-free package for
  machines that can't clone (WI #340).
