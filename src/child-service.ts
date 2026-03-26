import type { KeyLike } from 'jose';
import type {
  ChildServiceOptions,
  AuthState,
  SignedIframeBridgePayload,
  SupportedAlgorithm,
  ChildEventMap,
} from './types.js';
import {
  isAuthMessage,
  isRefreshResponseMessage,
  isErrorMessage,
  isCustomMessage,
  createReadyMessage,
  createRefreshRequestMessage,
  createCustomMessage,
  PROTOCOL_NS,
  type AnyProtocolMessage,
} from './protocol.js';
import { verifyToken, isTokenExpired } from './token.js';
import {
  ConnectionTimeoutError,
  RefreshTimeoutError,
  TokenVerificationError,
  SignedIframeBridgeError,
} from './errors.js';
import { createDeferred, generateNonce, isOriginAllowed, type Deferred } from './utils.js';
import { TypedEmitter } from './events.js';

export class ChildService extends TypedEmitter<ChildEventMap> {
  private readonly parentOrigin: string;
  private readonly publicKey: CryptoKey | KeyLike;
  private readonly algorithm: SupportedAlgorithm;
  private readonly issuer?: string;
  private readonly audience?: string;
  private readonly connectTimeout: number;
  private readonly refreshTimeout: number;

  private currentToken: string | null = null;
  private currentPayload: SignedIframeBridgePayload | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private authDeferred: Deferred<string> | null = null;
  private pendingRefreshes = new Map<string, Deferred<string>>();
  private connectPromise: Promise<AuthState> | null = null;
  private connected = false;
  private destroyed = false;

  constructor(options: ChildServiceOptions) {
    super();
    this.parentOrigin = options.parentOrigin;
    this.publicKey = options.publicKey;
    this.algorithm = options.algorithm ?? 'ES256';
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.connectTimeout = options.connectTimeout ?? 30_000;
    this.refreshTimeout = options.refreshTimeout ?? 10_000;
  }

  /**
   * Single entry point for authentication. Handles all states:
   * - Not connected → connects (sends ready, waits for initial token, verifies)
   * - Connected + token valid → returns current AuthState
   * - Connected + token expired → requests refresh, verifies, returns new AuthState
   */
  async authenticate(): Promise<AuthState> {
    if (this.destroyed) throw new Error('ChildService has been destroyed');

    if (!this.connected) {
      return this.doConnect();
    }

    if (!this.currentToken || isTokenExpired(this.currentToken)) {
      return this.requestTokenRefresh();
    }

    return this.buildAuthState();
  }

  /**
   * Explicitly request a new token from the parent.
   * Returns the new AuthState once the parent responds.
   */
  async requestTokenRefresh(): Promise<AuthState> {
    const nonce = generateNonce();
    const deferred = createDeferred<string>();
    this.pendingRefreshes.set(nonce, deferred);

    // Send refresh request to parent
    window.parent.postMessage(createRefreshRequestMessage(nonce), this.parentOrigin);

    // Set timeout
    const timeout = setTimeout(() => {
      const pending = this.pendingRefreshes.get(nonce);
      if (pending) {
        this.pendingRefreshes.delete(nonce);
        pending.reject(new RefreshTimeoutError(this.refreshTimeout));
      }
    }, this.refreshTimeout);

    try {
      const token = await deferred.promise;
      await this.setToken(token);
      const state = this.buildAuthState();
      this.emit('token-changed', state);
      return state;
    } finally {
      clearTimeout(timeout);
      this.pendingRefreshes.delete(nonce);
    }
  }

  /** Send a custom message to the parent. */
  send(channel: string, data?: unknown): void {
    window.parent.postMessage(createCustomMessage(channel, data), this.parentOrigin);
  }

  /** Get the raw JWT string for forwarding to the child's backend. */
  getRawToken(): string | null {
    return this.currentToken;
  }

  /** Get the decoded payload without re-verifying. */
  getPayload(): SignedIframeBridgePayload | null {
    return this.currentPayload;
  }

  /** Remove all event listeners and clean up. */
  destroy(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    // Reject any pending operations
    for (const [, deferred] of this.pendingRefreshes) {
      deferred.reject(new Error('ChildService destroyed'));
    }
    this.pendingRefreshes.clear();
    this.authDeferred?.reject(new Error('ChildService destroyed'));
    this.authDeferred = null;
    this.destroyed = true;
    this.connected = false;
    this.currentToken = null;
    this.currentPayload = null;
    this.removeAllListeners();
  }

  private async doConnect(): Promise<AuthState> {
    // Guard against concurrent calls — reuse the in-flight promise
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnectInternal();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnectInternal(): Promise<AuthState> {
    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener('message', this.messageHandler);

    // Create a deferred for the initial auth token
    this.authDeferred = createDeferred<string>();

    // Tell the parent we're ready
    window.parent.postMessage(createReadyMessage(), this.parentOrigin);

    // Wait for the auth token with a timeout
    const timeout = setTimeout(() => {
      this.authDeferred?.reject(new ConnectionTimeoutError(this.connectTimeout));
    }, this.connectTimeout);

    try {
      const token = await this.authDeferred.promise;
      await this.setToken(token);
      this.connected = true;
      const state = this.buildAuthState();
      this.emit('authenticated', state);
      this.emit('token-changed', state);
      return state;
    } finally {
      clearTimeout(timeout);
      this.authDeferred = null;
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (!isOriginAllowed(this.parentOrigin, event.origin)) return;

    const data = event.data;
    if (!data || data.ns !== PROTOCOL_NS) return;

    // Emit raw message event
    this.emit('message', data as AnyProtocolMessage);

    if (isAuthMessage(data)) {
      // Initial auth token from parent
      this.authDeferred?.resolve(data.token);
      return;
    }

    if (isRefreshResponseMessage(data)) {
      const pending = this.pendingRefreshes.get(data.nonce);
      if (pending) {
        this.pendingRefreshes.delete(data.nonce);
        pending.resolve(data.token);
      }
      return;
    }

    if (isErrorMessage(data)) {
      const error = new SignedIframeBridgeError(data.code, data.message);
      if (data.nonce) {
        const pending = this.pendingRefreshes.get(data.nonce);
        if (pending) {
          this.pendingRefreshes.delete(data.nonce);
          pending.reject(error);
        }
      }
      this.emit('error', { error, nonce: data.nonce });
      return;
    }

    if (isCustomMessage(data)) {
      this.emit('custom-message', { channel: data.channel, data: data.data });
      return;
    }
  }

  private async setToken(token: string): Promise<void> {
    try {
      const payload = await verifyToken(token, this.publicKey, this.algorithm, {
        issuer: this.issuer,
        audience: this.audience,
      });
      this.currentToken = token;
      this.currentPayload = payload;
    } catch (err) {
      this.currentToken = null;
      this.currentPayload = null;
      const reason = err instanceof Error ? err.message : 'Unknown error';
      throw new TokenVerificationError(reason, err instanceof Error ? err : undefined);
    }
  }

  private buildAuthState(): AuthState {
    return {
      valid: this.currentToken !== null && !isTokenExpired(this.currentToken),
      payload: this.currentPayload,
      rawToken: this.currentToken,
    };
  }
}
