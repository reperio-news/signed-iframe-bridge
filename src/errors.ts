export class SignedIframeBridgeError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SignedIframeBridgeError';
    this.code = code;
  }
}

export class TokenVerificationError extends SignedIframeBridgeError {
  constructor(reason: string, cause?: Error) {
    super('TOKEN_VERIFICATION_FAILED', `Token verification failed: ${reason}`);
    this.name = 'TokenVerificationError';
    if (cause) this.cause = cause;
  }
}

export class TokenExpiredError extends SignedIframeBridgeError {
  constructor() {
    super('TOKEN_EXPIRED', 'Token has expired');
    this.name = 'TokenExpiredError';
  }
}

export class RefreshTimeoutError extends SignedIframeBridgeError {
  constructor(timeoutMs: number) {
    super('REFRESH_TIMEOUT', `Token refresh timed out after ${timeoutMs}ms`);
    this.name = 'RefreshTimeoutError';
  }
}

export class ConnectionTimeoutError extends SignedIframeBridgeError {
  constructor(timeoutMs: number) {
    super('CONNECTION_TIMEOUT', `Connection timed out after ${timeoutMs}ms`);
    this.name = 'ConnectionTimeoutError';
  }
}

