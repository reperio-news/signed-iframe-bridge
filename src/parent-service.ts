import type { ParentServiceOptions, ParentEventMap } from './types.js';
import {
  isReadyMessage,
  isRefreshRequestMessage,
  isCustomMessage,
  createAuthMessage,
  createRefreshResponseMessage,
  createErrorMessage,
  createCustomMessage,
  PROTOCOL_NS,
  type AnyProtocolMessage,
} from './protocol.js';
import { ConnectionTimeoutError } from './errors.js';
import { createDeferred, isOriginAllowed } from './utils.js';
import { TypedEmitter } from './events.js';

export class ParentService extends TypedEmitter<ParentEventMap> {
  private readonly childOrigin: string;
  private readonly iframe: HTMLIFrameElement;
  private readonly onTokenRefresh: () => Promise<string>;
  private readonly connectTimeout: number;
  private readonly refreshThrottleMs: number;

  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private readyDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  private connected = false;
  private destroyed = false;
  private lastRefreshTime = 0;

  constructor(options: ParentServiceOptions) {
    super();
    this.iframe = options.iframe;
    this.childOrigin = options.childOrigin ?? this.deriveChildOrigin();
    this.onTokenRefresh = options.onTokenRefresh;
    this.connectTimeout = options.connectTimeout ?? 30_000;
    this.refreshThrottleMs = options.refreshThrottleMs ?? 1_000;
  }

  /** Derive the child origin from the iframe's src attribute. */
  private deriveChildOrigin(): string {
    const src = this.iframe.src;
    if (!src) {
      throw new Error(
        'Cannot derive childOrigin: iframe has no src attribute. Set childOrigin explicitly.',
      );
    }
    try {
      return new URL(src).origin;
    } catch {
      throw new Error(
        `Cannot derive childOrigin: iframe src "${src}" is not a valid URL. Set childOrigin explicitly.`,
      );
    }
  }

  /**
   * Wait for the child iframe to signal readiness, then send
   * the initial auth token. Resolves when the child is authenticated.
   */
  async connect(): Promise<void> {
    if (this.destroyed) throw new Error('ParentService has been destroyed');
    if (this.connected) return;

    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener('message', this.messageHandler);

    // Create the deferred lazily — only when connect() is called
    this.readyDeferred = createDeferred<void>();

    // Wait for the child's "ready" signal with a timeout
    const timeout = setTimeout(() => {
      this.readyDeferred?.reject(new ConnectionTimeoutError(this.connectTimeout));
    }, this.connectTimeout);

    try {
      await this.readyDeferred.promise;
    } finally {
      clearTimeout(timeout);
    }

    // Child is ready — send the initial auth token
    const token = await this.onTokenRefresh();
    this.postToChild(createAuthMessage(token));
    this.lastRefreshTime = Date.now();
    this.connected = true;
  }

  /** Send a custom message to the child iframe. */
  send(channel: string, data?: unknown): void {
    this.postToChild(createCustomMessage(channel, data));
  }

  /** Remove all event listeners and clean up. */
  destroy(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.readyDeferred?.reject(new Error('ParentService destroyed'));
    this.readyDeferred = null;
    this.destroyed = true;
    this.connected = false;
    this.removeAllListeners();
  }

  private handleMessage(event: MessageEvent): void {
    if (!isOriginAllowed(this.childOrigin, event.origin)) return;

    // Ensure the message comes from our specific iframe
    if (event.source !== this.iframe.contentWindow) return;

    const data = event.data;
    if (!data || data.ns !== PROTOCOL_NS) return;

    // Emit raw message event
    this.emit('message', data as AnyProtocolMessage);

    if (isReadyMessage(data)) {
      this.emit('ready', undefined);
      this.readyDeferred?.resolve();
      return;
    }

    if (isRefreshRequestMessage(data)) {
      this.handleRefreshRequest(data.nonce);
      return;
    }

    if (isCustomMessage(data)) {
      this.emit('custom-message', { channel: data.channel, data: data.data });
      return;
    }
  }

  private async handleRefreshRequest(nonce: string): Promise<void> {
    // Rate-limit refresh requests
    const now = Date.now();
    const elapsed = now - this.lastRefreshTime;
    if (elapsed < this.refreshThrottleMs) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshThrottleMs - elapsed));
    }

    try {
      const token = await this.onTokenRefresh();
      this.lastRefreshTime = Date.now();
      this.postToChild(createRefreshResponseMessage(nonce, token));
      this.emit('token-sent', { nonce });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Token refresh failed');
      this.postToChild(createErrorMessage('REFRESH_FAILED', error.message, nonce));
      this.emit('error', { error, nonce });
    }
  }

  private postToChild(message: object): void {
    const win = this.iframe.contentWindow;
    if (!win) {
      const error = new Error('Cannot reach iframe: contentWindow is null');
      this.emit('error', { error });
      return;
    }
    win.postMessage(message, this.childOrigin);
  }
}
