// #130: a `GANTRY_`-prefixed environment variable set on a service that does not read it used to be
// completely silent — the process started normally, nothing was logged, and the eventual symptom
// pointed nowhere near the cause. #129's `GANTRY_MCP_` rename makes that particular mistake less
// likely to be *made*; this module makes the whole class of it *detectable*, at the one moment an
// operator is still looking at the deploy log.
//
// Three rules this must never break:
//   1. **Names only, never values.** Several of these variables are credentials. A startup check that
//      echoed a value would hand a PAT to whatever log stream the hosting provider keeps, which is a
//      strictly worse failure than the silence it replaces. Nothing in here reads `env[name]`.
//   2. **Never blocks startup.** An unrecognised `GANTRY_` variable is not an error: operators
//      legitimately set variables for their own tooling. Warn and carry on.
//   3. **Silence when correct.** A correctly configured deployment prints nothing at all, so anything
//      that *is* printed stays worth reading.
//
// This mirrors `lib/envVarCheck.js` in the main package by hand rather than importing it: the two live
// in different packages this codebase does not import across (`src/credentials.js` and
// `lib/workspaceBootstrap.js` are the established precedent for that duplication). The main package's
// `tests/envVarCheck.test.js` holds the two copies' tables to each other so they cannot drift.

/**
 * The `GANTRY_`-prefixed environment variables this MCP server actually reads (`src/index.js`'s
 * `main`, post-#129). `test/envVarCheck.test.js` greps `src/` for `process.env.GANTRY_*` reads and
 * asserts this list matches them exactly, in both directions — a new variable cannot silently fall out
 * of the check, and a removed one cannot silently linger in it.
 *
 * `PORT` is read too, but only `GANTRY_`-prefixed variables are ever considered here: an operator's
 * environment is full of unrelated variables, and warning about any of them would bury the one line
 * that matters.
 */
export const READ_ENV_VARS = ['GANTRY_MCP_ACCESS_TOKEN', 'GANTRY_MCP_BASE_URL', 'GANTRY_MCP_WORKSPACE_PATS']

/** How the *other* service is named to an operator in a warning. */
export const OTHER_SERVICE_LABEL = 'the Gantry web server (gantry serve)'

/**
 * What the other service reads (`lib/` and `bin/` in the main package). Set on *this* service, one of
 * these is the case that actually bites: it looks like a Gantry variable, it is a Gantry variable, and
 * it is simply on the wrong process — so it gets named as such rather than reported as unknown.
 */
export const OTHER_SERVICE_ENV_VARS = [
  'GANTRY_BOOTSTRAP_WORKSPACES',
  'GANTRY_DEBUG',
  'GANTRY_INSTANCES_DIR',
  'GANTRY_LIBRARY_PAT',
  'GANTRY_LIBRARY_PAT_ATLASSIAN',
  'GANTRY_LIBRARY_PAT_AZURE_DEVOPS',
  'GANTRY_LIBRARY_PAT_GITHUB',
  'GANTRY_LIBRARY_PAT_GITLAB',
  'GANTRY_SHARED_WORKSPACE_PATS',
  'GANTRY_WORKSPACES_DIR',
]

/**
 * Retired names mapped to what replaced them. Gantry renames env vars without aliases (#121's
 * `GANTRY_SHARED_WORKSPACE_PATS`, #129's `GANTRY_MCP_*`), which is only safe to walk into if an
 * operator upgrading from an older version is *told* — an alias-free rename plus silence is how a
 * working deployment turns into a broken one across a version bump with no diagnostic at all.
 */
export const RETIRED_ENV_VARS = {
  GANTRY_BASE_URL: 'GANTRY_MCP_BASE_URL',
  GANTRY_BOOTSTRAP_PATS: 'GANTRY_SHARED_WORKSPACE_PATS',
  GANTRY_WORKSPACE_PATS: 'GANTRY_MCP_WORKSPACE_PATS',
}

const PREFIX = 'GANTRY_'

/** Log-line prefix, matching this server's existing `gantry-mcp-server ...` startup line. */
const LINE_PREFIX = 'gantry-mcp-server:'

// Deliberately modest: close enough to catch a typo or a singular/plural slip, far enough from
// "guess something" that a genuinely unrelated variable gets no misleading suggestion.
const MAX_SUGGESTION_DISTANCE = 3

function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, j) => j)
  for (let i = 1; i < rows; i += 1) {
    const current = [i]
    for (let j = 1; j < cols; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1)
    }
    previous = current
  }
  return previous[cols - 1]
}

/**
 * The closest known variable to `name`, or `null` when nothing is close enough to be worth naming.
 * Both this service's own variables and the other service's are candidates: a near-miss on a web
 * server variable name is still most usefully answered with the name that was probably meant.
 */
function closestKnownName(name) {
  let best = null
  let bestDistance = Infinity
  for (const candidate of [...READ_ENV_VARS, ...OTHER_SERVICE_ENV_VARS]) {
    const distance = editDistance(name, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : null
}

/**
 * Builds the warning lines for `env` — one per `GANTRY_`-prefixed variable that is set but unread,
 * sorted by name so the output is stable. Returns `[]` for a correctly configured environment.
 *
 * Takes the environment as an argument and returns strings rather than printing: the printing half
 * (`warnAboutUnreadEnvVars`) stays trivially small, and a test can assert on exact text without
 * capturing a stream. **Only variable names are ever read from `env` — never a value.**
 */
export function unreadEnvVarWarnings(env) {
  const read = new Set(READ_ENV_VARS)
  const foreign = new Set(OTHER_SERVICE_ENV_VARS)

  const unread = Object.keys(env ?? {})
    .filter((name) => name.startsWith(PREFIX) && !read.has(name))
    .sort()

  return unread.map((name) => {
    const unreadHere = `${LINE_PREFIX} ${name} is set but this service does not read it`

    if (foreign.has(name)) {
      return `${unreadHere} — it belongs to ${OTHER_SERVICE_LABEL}, a separate process. Set it there instead.`
    }

    const replacement = RETIRED_ENV_VARS[name]
    if (replacement) {
      const belongsElsewhere = foreign.has(replacement)
        ? `, which belongs to ${OTHER_SERVICE_LABEL}, a separate process`
        : ''
      return `${unreadHere} — that name is retired; it is now ${replacement}${belongsElsewhere}.`
    }

    const suggestion = closestKnownName(name)
    return suggestion ? `${unreadHere} — did you mean ${suggestion}?` : `${unreadHere}.`
  })
}

/**
 * Prints the warnings for `env` to stderr at startup. Never throws and never exits: whatever is set,
 * and whatever goes wrong in here, the service still starts (see rule 2 at the top of this file).
 * Returns the lines it printed, so a caller or test can see them without capturing the stream.
 */
export function warnAboutUnreadEnvVars(env = process.env) {
  let lines = []
  try {
    lines = unreadEnvVarWarnings(env)
    for (const line of lines) console.error(line)
  } catch {
    // A startup diagnostic that could itself break startup would be worse than no diagnostic.
  }
  return lines
}
