import { setTimeout as sleep } from 'node:timers/promises'

const POLL_MS = 250
// Long enough for a rendered page on a busy machine, short enough to ask again if a request was lost while the server started.
const ATTEMPT_MS = 30_000

export type Readiness = 'ready' | 'exited' | 'timed out'

/*
 * Asks the URL until it answers below 400, the process exits or the time is
 * up, one request at a time. Each request is given time to finish: a page
 * slower than the wait would never pass, and a server keeps rendering a page
 * whose request was given up on, so asking again piles up its work until the
 * database runs out of connections.
 */
export const waitUntilAnswering = async ({
  url,
  timeoutMs,
  isLive,
}: {
  readonly url: string
  readonly timeoutMs: number
  readonly isLive: () => Promise<boolean>
}): Promise<Readiness> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isLive())) return 'exited'
    const attemptMs = Math.min(ATTEMPT_MS, deadline - Date.now())
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(attemptMs, 1)),
      })
      if (response.status < 400) return 'ready'
    } catch {
      // Refused or timed out: the server is still starting.
    }
    await sleep(POLL_MS)
  }
  return 'timed out'
}
