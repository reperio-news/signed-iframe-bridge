export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** Create a promise with externally-accessible resolve/reject. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Generate a unique nonce for request/response correlation. */
export function generateNonce(): string {
  return crypto.randomUUID();
}

/** Validate that a message origin matches the expected origin. */
export function isOriginAllowed(expected: string, actual: string): boolean {
  return expected === actual;
}
