/**
 * Per-session send pacing — the concrete ban-risk mitigation for QR
 * connections. Unofficial clients that burst-send are exactly what gets
 * fresh/low-trust numbers flagged fastest; a fixed minimum gap between
 * consecutive sends keeps a testing-volume account looking like a human
 * tapping "send", not a bot blasting messages. This is intentionally not
 * configurable — QR is scoped to low-volume product testing, not
 * broadcast-scale sending (broadcasts stay Cloud-API-only).
 */
const MIN_SEND_GAP_MS = 1200

const queues = new Map<string, Promise<unknown>>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `fn` after every previously-queued send for this session has
 * settled (success or failure), spaced at least `MIN_SEND_GAP_MS` apart.
 * A failed send does not wedge the queue — the next call still runs,
 * paced the same way.
 */
export function enqueueSend<T>(configId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(configId) ?? Promise.resolve()
  const settled = prev.then(
    () => {},
    () => {},
  )
  const run = settled.then(fn)
  queues.set(
    configId,
    run.then(
      () => sleep(MIN_SEND_GAP_MS),
      () => sleep(MIN_SEND_GAP_MS),
    ),
  )
  return run
}
