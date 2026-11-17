import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type Holder,
  holderOf,
  releaseSlots,
  slotCountOf,
  takeSlot,
} from './slots.ts'

const GIB = 1024 ** 3

const children: ChildProcess[] = []
const directories: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

const pool = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-env-slots-'))
  directories.push(directory)
  return directory
}

/* A real process per holder, because a slot is only as live as the process holding it. */
const holder = async (name: string): Promise<Holder> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'])
  children.push(child)
  await new Promise((resolve) => child.once('spawn', resolve))
  return holderOf(name, child.pid)
}

const kill = async (process_: Holder): Promise<void> => {
  const child = children.find(({ pid }) => pid === process_.pid)
  child?.kill('SIGKILL')
  await new Promise((resolve) => child?.once('exit', resolve))
}

/** Whether taking settles within a moment, which a holder that has to wait does not. */
const settles = (taking: Promise<void>): Promise<boolean> =>
  Promise.race([taking.then(() => true), sleep(1_000).then(() => false)])

/*
 * Whether a holder that may now go does take its slot. Each poll reads every
 * holder's process, which on a machine busy with the rest of `pnpm check`
 * can take longer than the moment `settles` waits, so this waits as long as
 * a slow poll needs and returns as soon as the slot is taken.
 */
const takes = (taking: Promise<void>): Promise<boolean> =>
  Promise.race([taking.then(() => true), sleep(10_000).then(() => false)])

describe('the number of lane slots', { timeout: 30_000 }, () => {
  it('fits lanes into the memory Docker has after the shared stack', () => {
    expect(slotCountOf(undefined, 2.5 * GIB, 64)).toBe(4)
  })

  it('runs no more lanes than the host has cores for', () => {
    expect(slotCountOf(undefined, 32 * GIB, 10)).toBe(3)
  })

  it('is always at least one', () => {
    expect(slotCountOf(undefined, 0.5 * GIB, 1)).toBe(1)
  })

  it('follows DEV_ENV_LANE_SLOTS, and refuses a value that is not a count', () => {
    expect(slotCountOf('7', 0, 1)).toBe(7)
    expect(() => slotCountOf('0', 0, 1)).toThrow('DEV_ENV_LANE_SLOTS')
    expect(() => slotCountOf('two', 0, 1)).toThrow('DEV_ENV_LANE_SLOTS')
  })
})

describe('taking a lane slot', () => {
  it('gives each holder its own slot, and makes the next wait, saying who holds them', async () => {
    const directory = pool()
    const [one, two, three] = await Promise.all(
      ['one', 'two', 'three'].map(holder)
    )
    if (one === undefined || two === undefined || three === undefined)
      throw new Error('no holders')
    await takeSlot({ directory, size: 2, holder: one })
    await takeSlot({ directory, size: 2, holder: two })

    const reasons: string[] = []
    const third = takeSlot({
      directory,
      size: 2,
      holder: three,
      onWait: (reason) => reasons.push(reason),
    })
    expect(await settles(third)).toBe(false)
    expect(reasons).toEqual([
      `all 2 lane slots are held by one (pid ${one.pid}), two (pid ${two.pid})`,
    ])

    releaseSlots(directory, one)
    expect(await takes(third)).toBe(true)
  })

  it('keeps one slot for a holder that asks again', async () => {
    const directory = pool()
    const one = await holder('one')
    await takeSlot({ directory, size: 2, holder: one })
    await takeSlot({ directory, size: 2, holder: one })
    expect(readdirSync(directory)).toEqual(['slot-0.json'])
  })

  it('frees the slot of a holder that was killed', async () => {
    const directory = pool()
    const [killed, next] = await Promise.all(['killed', 'next'].map(holder))
    if (killed === undefined || next === undefined)
      throw new Error('no holders')
    await takeSlot({ directory, size: 1, holder: killed })
    await kill(killed)

    expect(await takes(takeSlot({ directory, size: 1, holder: next }))).toBe(
      true
    )
  })

  it('frees a slot whose pid now belongs to another process', async () => {
    const directory = pool()
    const live = await holder('live')
    writeFileSync(
      join(directory, 'slot-0.json'),
      JSON.stringify({ ...live, startedAt: 'Thu Jan  1 00:00:00 1970' })
    )

    expect(await takes(takeSlot({ directory, size: 1, holder: live }))).toBe(
      true
    )
  })
})

describe('running alone', { timeout: 30_000 }, () => {
  it('waits for the files already running, and lets no new one start meanwhile', async () => {
    const directory = pool()
    const [running, alone, later] = await Promise.all(
      ['running', 'alone', 'later'].map(holder)
    )
    if (running === undefined || alone === undefined || later === undefined)
      throw new Error('no holders')
    await takeSlot({ directory, size: 3, holder: running })

    const exclusive = takeSlot({
      directory,
      size: 3,
      holder: alone,
      exclusive: true,
    })
    expect(await settles(exclusive)).toBe(false)
    const queued = takeSlot({ directory, size: 3, holder: later })
    expect(await settles(queued)).toBe(false)

    releaseSlots(directory, running)
    expect(await takes(exclusive)).toBe(true)
    expect(await settles(queued)).toBe(false)

    releaseSlots(directory, alone)
    expect(await takes(queued)).toBe(true)
  })

  it('lets two that both want every slot take turns', async () => {
    const directory = pool()
    const [first, second] = await Promise.all(['first', 'second'].map(holder))
    if (first === undefined || second === undefined)
      throw new Error('no holders')
    await takeSlot({ directory, size: 2, holder: first, exclusive: true })

    const waiting = takeSlot({
      directory,
      size: 2,
      holder: second,
      exclusive: true,
    })
    expect(await settles(waiting)).toBe(false)

    await kill(first)
    expect(await takes(waiting)).toBe(true)
  })
})
