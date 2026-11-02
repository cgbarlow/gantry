# MCP access control: identity at the edge, Provider credentials behind it

**Status: accepted** (2026-11-02) — see **Decision** at the end. Drafted as a proposal on 2026-09-23; the analysis below is that proposal, kept as written because it is the reasoning the decision rests on. Nothing new is built: the decision is to stay at position 1 now, and which position to go to — and what reopens it — is fixed in advance.

`docs/adr/0043-mcp-server-is-a-separate-render-hosted-http-client.md` gave the MCP server the access model appropriate to what it then was: a single-operator client, deployed alongside a single-operator Gantry. A static bearer token (`GANTRY_MCP_ACCESS_TOKEN`) gates the server, and a map of workspace id to Personal Access Token (`GANTRY_MCP_WORKSPACE_PATS`, renamed from `GANTRY_WORKSPACE_PATS` by `#129`) supplies the credential it acts on a Provider with. `mcp-server/src/gantryClient.js` resolves a workspace's credential from that map alone; there is no per-call credential, and a workspace missing from the map produces a structured `missing_workspace_pat` error whose only remedy is an operator editing the environment and restarting.

That model does not survive contact with a second user, for three reasons that are about structure rather than about the strength of the secret:

- **One token is every workspace.** A caller holding `GANTRY_MCP_ACCESS_TOKEN` can act on every workspace in the credential map. There is no way to grant someone access to one workspace, and no way to revoke one person without rotating for everyone.
- **Attribution is wrong, not merely coarse.** Every commit, pull request, work-item change and stage advance made through MCP is attributed to whichever account owns the PAT in the map. The question "who advanced this stage?" has no answer the system can give, which is a compliance problem anywhere the Gate Ledger is meant to mean something.
- **The credentials are static and long-lived.** Personal Access Tokens in an environment variable do not rotate, do not meaningfully expire, and a leak is total and silent.

None of this is a defect in `docs/adr/0043`. It is that decision's stated scope reaching its limit.

## The two hops, which must not be conflated

Access control here is two separate problems, and treating them as one is the usual way this goes wrong — the same conflation `docs/adr/0047-a-workspace-can-be-shared-by-its-deployment.md` had to untangle between a credential that reads and a credential that writes.

**Hop 1 — who is calling the MCP server?** This is an identity problem, and it is where the Model Context Protocol's own authorization model applies: OAuth 2.1, with the MCP server acting as an OAuth resource server, PKCE, protected-resource metadata, and dynamic client registration. It yields per-user identity, short-lived tokens, revocation, and an audit trail. The specification in this area has revised repeatedly; whoever implements this must work from the current revision rather than from this paragraph.

**Hop 2 — what credential does the MCP server present to the Provider?** Solving hop 1 does nothing for this. An authenticated caller still leaves the server needing something to send to GitHub, Azure DevOps, GitLab or Atlassian. The options differ in what they buy:

- **A Provider App** (a GitHub App and its per-provider equivalents) rather than Personal Access Tokens: installation tokens that expire within the hour, scoped per repository, revocable from the Provider's own UI, rotating without anyone's involvement. Attribution becomes "the app" — honest, but coarse.
- **Per-user Provider credentials**, mapped from the hop-1 identity — user-to-server tokens obtained by the real person. Actions are attributed to that person and bounded by the permissions they actually hold at the Provider, which is the only arrangement in which an audit log is worth keeping.
- **Static PATs in an environment variable** — the status quo, and not a production answer.

## The shape of the decision

Three positions, in increasing cost. This ADR does not choose between them; it asserts only that the choice is deliberate and that the intermediate position is real rather than a half-measure.

1. **Status quo.** A single operator, a single static token. Correct for what exists today and should not be replaced before there is a second user.
2. **Per-user tokens without OAuth.** Replace the single shared `GANTRY_MCP_ACCESS_TOKEN` with per-user, individually revocable tokens, each mapped to its own Provider credential. No specification compliance work, no authorization server, days rather than weeks — and it buys the two things that actually matter first: revocation of one person, and attribution of an action to a real one. For an internal team this is frequently where the ladder correctly stops.
3. **Full model.** OAuth 2.1 for hop 1 per the MCP authorization specification; a Provider App or per-user Provider OAuth for hop 2.

**Network posture is a genuine substitute for much of position 3.** An MCP server with no public ingress — private networking, an IP allowlist, mutual TLS — has a materially different threat model from one reachable from the internet. Building an authorization server for a service that never leaves a private network is cost without corresponding benefit, and the deployment posture should be settled before the access model is, not after.

## The consequence beyond MCP

`docs/adr/0047` records that Gantry has no authentication of its own: `lib/credential.js`'s `getCredential(req)` is a Basic-auth header decode and there is no session, login or user record anywhere. That is precisely why a shared workspace under `docs/adr/0047` means "readable by anyone who can reach the deployment" — with no notion of who anyone is, per-user access control is not available to be offered, and `docs/adr/0047` rejected building an identity layer as a different product rather than a natural extension.

Hop 1 **is** that identity layer. Building it for MCP would, for the first time, give Gantry a real answer to "who is this?" — and with it the ability to offer a *private* shared workspace, visible to named people rather than to everyone with the link. That is not a reason to build it. It is a reason not to design it as an MCP-only concern, and to weigh it as one decision serving two purposes rather than two decisions that happen to overlap.

## Alternatives considered

- **Extending the credential map with per-caller scoping, keeping one shared access token.** Rejected as the appearance of access control without its substance: a single shared token means anyone holding it can present as any caller, so scoping the map buys nothing an attacker respects.
- **Accepting PAT attribution and solving audit with logging in Gantry.** Rejected: a log recording that "the MCP server" made a change, when the underlying Provider history records a single service account, answers the question only within Gantry — and the Provider's own history is the record that will be consulted in any dispute.
- **Going straight to position 3, skipping per-user tokens.** Not rejected, and possibly right — but it should be chosen for a reason (public ingress, an external-user requirement, a compliance obligation) rather than by default, because position 2 delivers revocation and attribution at a small fraction of the cost.

## What would settle this

Three questions, in order. Answered on 2026-11-02, below.

1. Does the MCP server have public ingress, or can it be placed behind private networking?
2. Is there a second user, and are they inside or outside the organisation that owns the workspaces?
3. Must an action be attributable to a named person at the Provider, or is a service identity sufficient for the record being kept?

## Decision

The answers:

1. **Public, and it stays public.** The MCP server is a public Render web service, and claude.ai's connectors reach it from Anthropic's cloud — which is how it is actually used. Moving it behind private networking would cut off every client except one running inside that network, so network posture is not available as a substitute for position 3.
2. **No second user is planned.** There is one operator.
3. **A named person.** Once there is more than one, an approval or stage advance must show who did it in the Provider's own history, for the reason given under *Alternatives considered*.

From those:

- **Now: position 1.** The single shared `GANTRY_MCP_ACCESS_TOKEN` and the `GANTRY_MCP_WORKSPACE_PATS` map stay as `docs/adr/0043` and `mcp-server/README.md` describe them. With one operator, attribution is already correct — the PAT is theirs. No hardening work is taken on alongside this.
- **What reopens it: either need.** A second person needs MCP access, **or** someone needs a shared workspace visible only to named people rather than to everyone who can reach the deployment (`docs/adr/0047`). Either one is the same missing piece — an answer to "who is this?" — so either one unparks the work.
- **Where it goes then: position 3, never position 2.** A public server whose actions must name a person needs real identity at the edge, and per-user static tokens would be built only to be replaced. Position 2 is skipped, not taken as a step.
  - **Hop 1 — OAuth, designed for the whole of Gantry, not for MCP alone.** One identity layer, which the web app also uses, so the private shared workspace above comes from the same work rather than a second build.
  - **Hop 2 — each person's own Provider sign-in** (on GitHub, a GitHub App acting on that user's behalf; each Provider's equivalent elsewhere). The Provider's history names the person, and they can do no more through Gantry than their own Provider permissions allow. A Provider App acting as itself is not enough, because it names the app.
  - **A single-operator deployment keeps the shared token.** OAuth is switched on when there is more than one person; a solo operator never has to stand up an authorization flow.

How position 3 is built — which Providers first, the sign-in flow on each, how the web app uses the identity — is not decided here. That is spec work for when it is unparked. `#132` is the parked ticket for it.

Status: **accepted**, 2026-11-02, during the ADR-0048 grilling session. Drafted as proposed on 2026-09-23 alongside `#132`, which has been re-scoped from position 2 to position 3 and stays parked until the trigger above is met.
