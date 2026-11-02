// A storage that "dies" part-way through a Save, for the fault-injection tests of #271 (docs/adr/0070). It wraps a real
// store (Azurite, or the in-memory one) and passes everything through until `dieAfterPuts` file writes have landed;
// from then on every call rejects, as it would for a process that has gone: no further writes, no rollback, and no
// lease release, so the lease it holds is left to expire on its own and whatever it had written stays written.
export function createDyingStorage(real, { dieAfterPuts }) {
  let puts = 0
  let dead = false
  const died = () => Object.assign(new Error('the server died'), { code: 'SERVER_DIED' })
  const guard = (name) => async (...args) => {
    if (dead) throw died()
    return real[name](...args)
  }
  const wrapped = {
    get dead() {
      return dead
    },
    getText: guard('getText'),
    getBytes: guard('getBytes'),
    list: guard('list'),
    remove: guard('remove'),
    acquireLease: guard('acquireLease'),
    renewLease: guard('renewLease'),
    releaseLease: guard('releaseLease'),
    async putBytes(path, bytes, options) {
      if (dead) throw died()
      // The write-ahead record is not a file of the Save: it is written before the first of them.
      const isJournal = path.startsWith('.gantry/')
      if (!isJournal && puts >= dieAfterPuts) {
        dead = true
        throw died()
      }
      const result = await real.putBytes(path, bytes, options)
      if (!isJournal) puts++
      return result
    },
    putText(path, text, options) {
      return wrapped.putBytes(path, Buffer.from(text, 'utf8'), options)
    },
  }
  return wrapped
}
