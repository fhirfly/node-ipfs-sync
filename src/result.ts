export type Option<T> =
  | { hasValue: true, value: T }
  | { hasValue: false }

export function some<T>(value: T): Option<T> {
  return { hasValue: true, value }
}

export function none<T>(): Option<T> {
  return { hasValue: false }
}

export type Result<T, E> =
  | { ok: true, value: T, error: undefined }
  | { ok: false, error: E }

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value, error: undefined }
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error }
}
