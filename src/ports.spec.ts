import { describe, expect, it } from 'vitest'

import { choosePort } from './ports.ts'

describe('choosePort', () => {
  it('walks past taken ports and wraps at the end of the range', async () => {
    const taken = new Set([29_999, 20_000])

    await expect(choosePort(29_999, (port) => taken.has(port))).resolves.toBe(
      20_001
    )
  })

  it('fails instead of leaving the range when every port is taken', async () => {
    await expect(choosePort(25_000, () => true)).rejects.toThrow('No free port')
  })
})
