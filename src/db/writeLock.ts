/**
 * Serializes multi-statement SQLite write transactions on the single shared connection.
 * Without it, concurrent `BEGIN TRANSACTION` calls (manual add + SMS drain + deletion)
 * fail with "cannot start a transaction within a transaction".
 */
let tail: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => undefined);
  return run;
}
