/**
 * Errors with a user-facing message. The IPC layer maps each class to an
 * error code and passes the message through to the renderer unchanged, so
 * messages here must be actionable and must not leak internals.
 */
export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

export class ForbiddenError extends Error {
  override name = 'ForbiddenError'
}

/** A required capability (e.g. FFmpeg) is not available right now. */
export class UnavailableError extends Error {
  override name = 'UnavailableError'
}

/** The request conflicts with current state (e.g. file already in the library). */
export class ConflictError extends Error {
  override name = 'ConflictError'
}

/** The input was understood but can't be processed (e.g. corrupted media). */
export class UnprocessableError extends Error {
  override name = 'UnprocessableError'
}
