export class LinkDropError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'LinkDropError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function makeSuccess<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function makeFailure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
