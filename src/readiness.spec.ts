import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { waitUntilAnswering } from './readiness.ts'

const live = async () => true

let server: Server | undefined

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined))
  server = undefined
})

/** A server whose every answer takes `delayMs`, counting the requests it holds at once. */
const slowServer = async (delayMs: number) => {
  const seen = { inFlight: 0, mostAtOnce: 0, requests: 0 }
  server = createServer((_request, response) => {
    seen.requests += 1
    seen.inFlight += 1
    seen.mostAtOnce = Math.max(seen.mostAtOnce, seen.inFlight)
    setTimeout(() => {
      seen.inFlight -= 1
      response.end('ok')
    }, delayMs)
  })
  await new Promise<void>((resolve) =>
    server?.listen(0, '127.0.0.1', () => resolve())
  )
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/`, seen }
}

describe('waiting for a service to answer', () => {
  it('waits for a page that takes longer than a second, asking once at a time', async () => {
    const { url, seen } = await slowServer(1_500)

    const readiness = await waitUntilAnswering({
      url,
      timeoutMs: 3_500,
      isLive: live,
    })

    expect(readiness).toBe('ready')
    expect(seen.mostAtOnce).toBe(1)
    expect(seen.requests).toBe(1)
  })

  it('gives up when the time is up', async () => {
    const { url } = await slowServer(2_000)

    expect(
      await waitUntilAnswering({ url, timeoutMs: 500, isLive: live })
    ).toBe('timed out')
  })

  it('stops asking once the process has exited', async () => {
    const { url, seen } = await slowServer(0)

    expect(
      await waitUntilAnswering({
        url,
        timeoutMs: 5_000,
        isLive: async () => false,
      })
    ).toBe('exited')
    expect(seen.requests).toBe(0)
  })
})
