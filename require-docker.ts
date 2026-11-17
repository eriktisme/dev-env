import { execFileSync } from 'node:child_process'

/*
 * Fails rather than skips: a suite that passes without Docker reports a green
 * run in which nothing was tested.
 */
export default function requireDocker(): void {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
  } catch {
    throw new Error(
      'Integration tests need Docker. Start Docker and run them again.'
    )
  }
}
