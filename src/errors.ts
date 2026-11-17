/** A failure the person running the command can act on, printed without a stack. */
export class DevEnvError extends Error {
  override readonly name = 'DevEnvError'
}
