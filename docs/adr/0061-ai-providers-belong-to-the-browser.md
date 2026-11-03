# AI Providers belong to the browser, not the workspace

Ticket #244, map #238 (v0.13.0, the AI interview). A deliberate exception to
ADR-0038's one-credential-per-workspace rule.

An architect sets up their **AI Providers** once, in their own browser, and
uses them in every workspace. The keys are stored in the browser the same way
Workspace PATs are, and are sent with each request. `gantry serve` never
stores them. One AI Provider is marked Default and the Interview page
pre-selects it.

ADR-0038 keeps Workspace PATs per workspace so a token for one **Provider** is
never sent to another. An AI key carries no such risk: it is only ever sent to
the address of the AI Provider it was entered for, whatever the workspace. It
is also the architect's own account rather than something a workspace owns.
Keeping a copy per workspace would make the architect re-enter the same key
for every workspace and protect nothing. Limiting which AI Providers a
workspace or Definition allows (for example "this client's material must not
go to OpenAI") is a matter of policy, not of where the key is stored, and is
left for later.

## Local models are called from the browser

An Ollama or LM Studio AI Provider says where it **runs**: on *this computer*
or on *the Gantry server*.

- **This computer:** the browser calls the model directly. A hosted
  `gantry serve` can't reach the architect's laptop, because `localhost`
  there means the server. The architect has to allow the browser's requests
  (`OLLAMA_ORIGINS`, or LM Studio's CORS setting). Test connection explains
  how when a request is blocked.
- **Everything else** (every other AI Provider type, and local models that run
  on the Gantry server) goes through `gantry serve`. It refuses private and
  loopback addresses unless the operator sets `GANTRY_AI_ALLOW_PRIVATE_URLS`.
  Otherwise a hosted Gantry could be pointed at its own internal network.

## Considered options

- **AI Providers per workspace, like Workspace PATs.** Rejected for the
  reasons above.
- **Every call goes through `gantry serve`.** Local models would then work
  only when serve runs on the architect's own machine, or the operator would
  have to open private addresses on a hosted server.
