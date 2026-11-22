import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { WorkerService } from './manifest.ts'
import { devVarsOf, prepareWorkers } from './worker.ts'

const workspace = (configs: Record<string, unknown>) => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-env-worker-'))
  mkdirSync(join(directory, 'wrangler'))
  for (const [file, config] of Object.entries(configs))
    writeFileSync(join(directory, file), JSON.stringify(config))
  return { directory, workDirectory: join(directory, 'work') }
}

const serviceOf = (configs: readonly string[]): WorkerService => ({
  kind: 'worker',
  configs,
  readinessPath: '/',
  sources: ['.'],
})

describe('prepareWorkers', () => {
  it('writes each Worker a config whose paths still point at its source, and bindings only its owner can read', async () => {
    const { directory, workDirectory } = workspace({
      'wrangler/web.json': {
        name: 'web',
        main: '../src/index.ts',
        assets: { directory: '../public' },
        env: { staging: { main: '../src/staging.ts' } },
      },
    })

    const [worker] = await prepareWorkers({
      service: serviceOf(['wrangler/web.json']),
      directory,
      workDirectory,
      bindings: async () => ({ DATABASE_URL: 'postgres://a b"c' }),
    })

    expect(JSON.parse(readFileSync(worker!.configPath, 'utf8'))).toMatchObject({
      main: join(directory, 'src/index.ts'),
      assets: { directory: join(directory, 'public') },
      env: { staging: { main: join(directory, 'src/staging.ts') } },
    })
    const vars = join(workDirectory, 'web', '.dev.vars')
    expect(readFileSync(vars, 'utf8')).toBe(
      'DATABASE_URL="postgres://a b\\"c"\n'
    )
    expect(statSync(vars).mode & 0o077).toBe(0)
  })

  it('refuses two Workers of one name, and a config that is not JSON', async () => {
    const { directory, workDirectory } = workspace({
      'a.json': { name: 'same', main: 'a.ts' },
      'b.json': { name: 'same', main: 'b.ts' },
    })
    const prepare = (configs: readonly string[]) =>
      prepareWorkers({
        service: serviceOf(configs),
        directory,
        workDirectory,
        bindings: async () => ({}),
      })

    await expect(prepare(['a.json', 'b.json'])).rejects.toThrow(
      'both named "same"'
    )
    await expect(prepare(['wrangler.toml'])).rejects.toThrow('not a .json file')
  })
})

describe('devVarsOf', () => {
  it('keeps a multi-line secret on one entry', () => {
    expect(devVarsOf({ KEY: 'a\nb' })).toBe('KEY="a\\nb"\n')
  })
})
