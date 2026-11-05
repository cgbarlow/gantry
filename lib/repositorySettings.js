// #335: what an operator can change about how `gantry serve` reads a code repository a Source document points at (lib/repositorySource.js).
// Each setting is one `GANTRY_REPOSITORY_*` environment variable holding a whole number, with a default that suits a server behind a
// common proxy. createServer resolves them once, at startup, so a value that makes no sense stops startup with one line naming the variable
// (never a search that quietly misbehaves later). A test or an embedder hands createServer the values directly (`options.repositoryReader`),
// the same options-first, environment-second convention as the other settings in lib/server.js.
//
// A new setting is one more row below: the reader option it fills, its variable, its default, its range, and `scale` from what the operator
// writes to what the reader takes (seconds to milliseconds, say). Name the variable in lib/envVarCheck.js's READ_ENV_VARS too, and in the
// README's "Code repositories as Source documents".

/**
 * The settings, each `{ option, envVar, fromProcessEnv, default, min, max, scale, means }`. `fromProcessEnv` reads the variable by its literal
 * name, which is how tests/envVarCheck.test.js finds every `GANTRY_` variable `gantry serve` reads. `means` finishes the refusal of a bad value.
 */
export const REPOSITORY_READER_SETTINGS = Object.freeze([
  {
    option: 'searchTimeLimitMs',
    envVar: 'GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_SEARCH_TIME_LIMIT_SECONDS,
    // Well under the 100 seconds a Cloudflare Tunnel (and many proxies) waits for an answer.
    default: 30,
    min: 1,
    max: 600,
    scale: 1000,
    means: 'the seconds a code repository search may take before it returns what it has found',
  },
  {
    option: 'searchParallelReads',
    envVar: 'GANTRY_REPOSITORY_SEARCH_PARALLEL_READS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_SEARCH_PARALLEL_READS,
    default: 8,
    min: 1,
    max: 32,
    scale: 1,
    means: 'how many files a code repository search reads at once',
  },
  {
    // #336: one request to the Provider that runs out of this time counts as a temporary failure, and is tried again.
    option: 'requestTimeLimitMs',
    envVar: 'GANTRY_REPOSITORY_REQUEST_TIME_LIMIT_SECONDS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_REQUEST_TIME_LIMIT_SECONDS,
    default: 15,
    min: 1,
    max: 300,
    scale: 1000,
    means: 'the seconds one request to a code repository\'s Provider may take before it counts as a temporary failure',
  },
  {
    // #336: a read that fails for a temporary reason is tried this many more times; 0 never tries again.
    option: 'retries',
    envVar: 'GANTRY_REPOSITORY_RETRIES',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_RETRIES,
    default: 2,
    min: 0,
    max: 5,
    scale: 1,
    means: 'how many more times a code repository read that failed for a temporary reason is tried',
  },
  {
    // #336: the wait before the first retry; each later retry waits twice as long as the one before.
    option: 'retryWaitMs',
    envVar: 'GANTRY_REPOSITORY_RETRY_WAIT_MILLISECONDS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_RETRY_WAIT_MILLISECONDS,
    default: 500,
    min: 0,
    max: 10000,
    scale: 1,
    means: 'the milliseconds to wait before trying a code repository read again, doubled for each later try',
  },
  {
    // #338 (docs/adr/0074): how much memory every Repository copy together may take (lib/repositoryCopies.js). 0 keeps no copies: every
    // read of a code repository is then file by file, as before #338.
    option: 'copyMemoryBytes',
    envVar: 'GANTRY_REPOSITORY_COPY_MEMORY_MB',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_COPY_MEMORY_MB,
    default: 512,
    min: 0,
    max: 65536,
    scale: 1024 * 1024,
    means: 'the megabytes of memory all copies of code repositories together may take; 0 keeps none',
  },
  {
    // #338: the most text one repository's copy may hold. A repository with more is read file by file (or, narrowed to folders on GitLab
    // or Azure DevOps, copied for those folders only).
    option: 'copyRepositoryBytes',
    envVar: 'GANTRY_REPOSITORY_COPY_LIMIT_MB',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_COPY_LIMIT_MB,
    default: 150,
    min: 1,
    max: 65536,
    scale: 1024 * 1024,
    means: 'the megabytes of text one code repository\'s copy may hold',
  },
  {
    // #338: a copy unused this long is dropped.
    option: 'copyIdleMs',
    envVar: 'GANTRY_REPOSITORY_COPY_IDLE_MINUTES',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_COPY_IDLE_MINUTES,
    default: 120,
    min: 1,
    max: 10080,
    scale: 60 * 1000,
    means: 'the minutes a copy of a code repository is kept once nothing uses it',
  },
  {
    // #338: a branch's head is asked again at most this often for reads; Out of date always asks it fresh. 0 asks it on every read.
    option: 'headRecheckMs',
    envVar: 'GANTRY_REPOSITORY_HEAD_RECHECK_SECONDS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_HEAD_RECHECK_SECONDS,
    default: 60,
    min: 0,
    max: 3600,
    scale: 1000,
    means: 'the seconds before a code repository\'s branch head is asked again',
  },
  {
    // #338: one archive download (a whole repository, in one request) may take this long, much longer than one request for a file.
    option: 'archiveTimeLimitMs',
    envVar: 'GANTRY_REPOSITORY_ARCHIVE_TIME_LIMIT_SECONDS',
    fromProcessEnv: () => process.env.GANTRY_REPOSITORY_ARCHIVE_TIME_LIMIT_SECONDS,
    default: 300,
    min: 5,
    max: 3600,
    scale: 1000,
    means: 'the seconds downloading a code repository\'s archive may take before it counts as a temporary failure',
  },
])

/**
 * The reader options when nothing is set: `{ searchTimeLimitMs: 30000, searchParallelReads: 8, requestTimeLimitMs: 15000, retries: 2,
 * retryWaitMs: 500, copyMemoryBytes: 512 MB, copyRepositoryBytes: 150 MB, copyIdleMs: 2 hours, headRecheckMs: 60000,
 * archiveTimeLimitMs: 300000 }`. The `copy*` and `headRecheckMs` settings are the Repository copy store's (lib/repositoryCopies.js), which
 * lib/server.js makes once from them.
 */
export const REPOSITORY_READER_DEFAULTS = Object.freeze(Object.fromEntries(REPOSITORY_READER_SETTINGS.map((s) => [s.option, s.default * s.scale])))

/**
 * The repository reader's options, for createRepositoryReader: each from `options` (a test or embedder, in the reader's own units) when it
 * gives one, else from its environment variable in `env` (process.env when not given), else its default. An empty variable counts as unset.
 * Throws, with a one-line message naming the variable, for a value that isn't a whole number in range.
 */
export function repositoryReaderSettings(options, env) {
  const resolved = {}
  for (const setting of REPOSITORY_READER_SETTINGS) {
    if (options?.[setting.option] !== undefined) {
      resolved[setting.option] = options[setting.option]
      continue
    }
    const raw = String((env ? env[setting.envVar] : setting.fromProcessEnv()) ?? '').trim()
    if (!raw) {
      resolved[setting.option] = setting.default * setting.scale
      continue
    }
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!(value >= setting.min && value <= setting.max)) {
      throw new Error(`${setting.envVar} must be a whole number from ${setting.min} to ${setting.max} (${setting.means}); it is "${raw}".`)
    }
    resolved[setting.option] = value * setting.scale
  }
  return resolved
}
