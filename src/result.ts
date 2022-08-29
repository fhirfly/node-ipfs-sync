export type Option<T> =
  | { hasValue: true, value: T }
  | { hasValue: false }

export function some<T>(value: T): Option<T> {
  return { hasValue: true, value }
}

export function none<T>(): Option<T> {
  return { hasValue: false }
}

type OkResult<T, E> = { ok: true, value: T, error: undefined }
type ErrResult<T, E> = { ok: false, error: E }
export type Result<T, E> =
  | OkResult<T, E>
  | ErrResult<T, E>

export function ok<T, E>(value: T): OkResult<T, E> {
  return { ok: true, value, error: undefined }
}

export function err<T, E>(error: E): ErrResult<T, E> {
  return { ok: false, error }
}

export function isOk<T, E>(result: Result<T, E>): result is OkResult<T, E> {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is ErrResult<T, E> {
  return !result.ok
}
