export type SyncErrorCode =
  | 'TIMEOUT'
  | 'AUTH'
  | 'QUOTA_EXCEEDED'
  | 'CLOCK_SKEW'
  | 'VALIDATION'
  | 'SERVER'
  | 'DECRYPT'
  | 'INTEGRITY'
  | 'UNSUPPORTED_ALG'
  | 'SALT_NOT_FOUND'
  | 'CRYPTO_UNAVAILABLE'
  | 'NO_PASSPHRASE'
  | 'LOCAL_FILE_MISSING'
  | 'TRANSFER'
  | 'STORAGE'
  | 'MANIFEST_COMMIT'
  | 'UNKNOWN_KIND'
  | 'SCHEMA_TOO_NEW'
  | 'LEGACY_MIGRATION_SKIP'
  | 'HLC_PERSIST';

export interface SyncErrorContext {
  replicaId?: string;
  kind?: string;
  field?: string;
  status?: number;
  cause?: unknown;
}

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly context: SyncErrorContext;

  constructor(code: SyncErrorCode, message: string, context: SyncErrorContext = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.context = context;
  }
}

export const isSyncError = (e: unknown): e is SyncError =>
  e instanceof SyncError || (e instanceof Error && e.name === 'SyncError');

/**
 * The signature of "this key can't read this ciphertext": AES-GCM auth-tag
 * failure or SHA-256 sidecar mismatch. In practice both mean the passphrase
 * behind the derived key is wrong. Distinct from SALT_NOT_FOUND /
 * CRYPTO_UNAVAILABLE, which say nothing about the passphrase.
 */
export const isWrongPassphraseError = (e: unknown): boolean =>
  isSyncError(e) && (e.code === 'DECRYPT' || e.code === 'INTEGRITY');

export const assertNever = (x: never): never => {
  throw new SyncError('VALIDATION', `Unexpected value: ${JSON.stringify(x)}`);
};

/**
 * The message a failed request is allowed to carry back to its caller.
 *
 * Deny by default, because the two kinds of error are not distinguishable by
 * looking at them. A `SyncError` was constructed here, on purpose, saying
 * something the caller can act on. Anything else fell out of a library and was
 * written for whoever is reading the server log.
 *
 * The difference is not cosmetic. Drizzle builds its message out of the failing
 * statement and every bound parameter, so forwarding it hands the table's whole
 * column layout and the row being written — user id, title, author, the
 * metadata blob — to anyone who can make a write fail. The same shape of leak
 * is available from an S3 client (bucket names, endpoints) and from `fetch`
 * (internal URLs). None of it is anything a caller can do something about.
 *
 * The detail is not lost, only redirected: every call site logs the original
 * before answering.
 */
export const clientSafeMessage = (error: unknown, fallback: string): string =>
  isSyncError(error) ? error.message : fallback;

/**
 * The part of a failure worth writing down, flattened so a log viewer keeps it.
 *
 * Two things make a database failure hard to read otherwise. Drizzle's own
 * message is the statement and its parameters and says nothing about what went
 * wrong — the reason lives on `cause`, one level down. And `console.error(err)`
 * serialises message and stack, so structured log viewers routinely drop
 * `cause` entirely: the one line that names the constraint is exactly the line
 * that goes missing.
 *
 * Walks the chain rather than reading one level, because a driver may wrap
 * twice.
 */
export const describeError = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const detail = (current as { detail?: unknown }).detail;
    parts.push(
      [
        `${current.name}: ${current.message}`,
        code ? `code=${String(code)}` : '',
        detail ? `detail=${String(detail)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length ? parts.join('\n  caused by ') : String(error);
};
