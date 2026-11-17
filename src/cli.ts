import { stderr, stdout } from 'node:process'

import type { Mode } from './checkout.ts'
import { isTestMode } from './checkout.ts'
import { resetTestEnvironments } from './test-environment.ts'
import type { CheckoutInfo, EnvironmentInfo } from './environment.ts'
import {
  describeCheckout,
  resetTarget,
  startTarget,
  stopAll,
  stopTarget,
} from './environment.ts'
import { DevEnvError } from './errors.ts'
import { runAffected } from './affected/run.ts'

const USAGE = `Usage:
  dev-env start <target>... [--test]
  dev-env stop [target]... [--test]
  dev-env info [--json]
  dev-env reset <target>... [--test]
  dev-env affected <target> [--base <ref>] [--list]
`

const printEnvironment = (environment: EnvironmentInfo): void => {
  const suffix = isTestMode(environment.mode) ? ` (${environment.mode})` : ''
  stdout.write(`${environment.target}${suffix}\n`)
  for (const [name, service] of Object.entries(environment.services)) {
    const status = service.running ? 'running' : 'stopped'
    stdout.write(`  ${name}: ${service.url ?? service.address} [${status}]\n`)
  }
}

const printCheckout = (info: CheckoutInfo): void => {
  stdout.write(`${info.checkout} (${info.environmentId})\n`)
  stdout.write(`Available: ${info.available.join(', ') || 'none'}\n`)
  info.environments.forEach(printEnvironment)
}

const requireTargets = (targets: readonly string[]): void => {
  if (targets.length === 0) throw new DevEnvError(USAGE.trimEnd())
}

const main = async (argv: readonly string[]): Promise<void> => {
  const args = argv.filter((arg) => arg !== '--')
  const [command, ...rest] = args
  const baseAt = rest.indexOf('--base')
  const base = baseAt === -1 ? undefined : rest[baseAt + 1]
  const options = baseAt === -1 ? rest : rest.toSpliced(baseAt, 2)
  const flags = options.filter((arg) => arg.startsWith('--'))
  const targets = options.filter((arg) => !arg.startsWith('--'))
  const mode: Mode = flags.includes('--test') ? 'test' : 'dev'
  const cwd = process.cwd()

  switch (command) {
    case 'start': {
      requireTargets(targets)
      for (const target of targets) {
        printEnvironment(await startTarget(cwd, target, mode))
      }
      return
    }
    case 'stop': {
      if (targets.length === 0) {
        await stopAll(cwd, flags.includes('--test') ? 'test' : undefined)
        return
      }
      for (const target of targets) await stopTarget(cwd, target, mode)
      return
    }
    case 'reset': {
      requireTargets(targets)
      for (const target of targets) {
        // A test environment may have several lanes, and --test resets them all.
        if (isTestMode(mode)) await resetTestEnvironments({ cwd, target })
        else await resetTarget(cwd, target, mode)
      }
      return
    }
    case 'info': {
      const info = await describeCheckout(cwd)
      if (flags.includes('--json')) {
        stdout.write(`${JSON.stringify(info, null, 2)}\n`)
      } else {
        printCheckout(info)
      }
      return
    }
    case 'affected': {
      const [target] = targets
      if (target === undefined || targets.length > 1)
        throw new DevEnvError(USAGE.trimEnd())
      process.exitCode = await runAffected(cwd, target, {
        base,
        list: flags.includes('--list'),
      })
      return
    }
    default:
      throw new DevEnvError(USAGE.trimEnd())
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  stderr.write(
    error instanceof DevEnvError
      ? `${error.message}\n`
      : `${error instanceof Error ? error.stack : String(error)}\n`
  )
  process.exitCode = 1
})
