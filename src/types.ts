import type { JWTPayload, KeyLike } from 'jose';
import type { AnyProtocolMessage } from './protocol.js';

/** JWT payload carried inside signed-iframe tokens. */
export interface SignedIframeBridgePayload extends JWTPayload {
  /** Unique user identifier. */
  uid: string;
  /** Arbitrary user info (name, email, avatar, etc.). */
  user?: Record<string, unknown>;
  /** Permission strings the child can inspect. */
  permissions?: string[];
}

/** Supported signing algorithms. */
export type SupportedAlgorithm = 'ES256' | 'RS256';

/** Configuration for the parent-side service. */
export interface ParentServiceOptions {
  /** The iframe element to communicate with. */
  iframe: HTMLIFrameElement;
  /** Expected origin of the child iframe (e.g. "https://child.example.com"). */
  childOrigin: string;
  /**
   * Async callback invoked when a token is needed (initial auth + refreshes).
   * Must return a signed JWT string obtained from your server.
   * The private key should never leave your server.
   */
  onTokenRefresh: () => Promise<string>;
  /** Timeout in ms for waiting for the child to be ready. Default: 30000. */
  connectTimeout?: number;
  /**
   * Minimum interval in ms between refresh token calls.
   * Prevents the child from overwhelming the backend with rapid refresh requests.
   * Default: 1000.
   */
  refreshThrottleMs?: number;
}

/** Configuration for the child-side service. */
export interface ChildServiceOptions {
  /** Expected origin of the parent page (e.g. "https://parent.example.com"). */
  parentOrigin: string;
  /** Public key for client-side JWT verification. */
  publicKey: CryptoKey | KeyLike;
  /** Expected signing algorithm. Defaults to 'ES256'. */
  algorithm?: SupportedAlgorithm;
  /** Expected JWT issuer — verification rejects mismatches if set. */
  issuer?: string;
  /** Expected JWT audience. */
  audience?: string;
  /** Timeout in ms for waiting for the initial auth token. Default: 30000. */
  connectTimeout?: number;
  /** Timeout in ms for token refresh requests. Default: 10000. */
  refreshTimeout?: number;
}

/** Authentication state returned by ChildService. */
export interface AuthState {
  /** Whether the current token is valid and not expired. */
  valid: boolean;
  /** Decoded payload (present when valid). */
  payload: SignedIframeBridgePayload | null;
  /** Raw JWT string (useful for forwarding to child's backend). */
  rawToken: string | null;
}

/** Payload delivered to custom-message event handlers. */
export interface CustomMessageEvent {
  /** The channel name the message was sent on. */
  channel: string;
  /** The data payload (any serialisable value). */
  data?: unknown;
}

/** Events emitted by ParentService. */
export interface ParentEventMap {
  /** A protocol message was received from the child. */
  message: AnyProtocolMessage;
  /** The child iframe signalled it is ready. */
  ready: void;
  /** A refresh request was received and fulfilled. */
  'token-sent': { nonce?: string };
  /** A custom message was received from the child. */
  'custom-message': CustomMessageEvent;
  /** An error occurred while handling a refresh request. */
  error: { error: Error; nonce?: string };
}

/** Events emitted by ChildService. */
export interface ChildEventMap {
  /** A protocol message was received from the parent. */
  message: AnyProtocolMessage;
  /** Initial authentication completed or token was refreshed. */
  authenticated: AuthState;
  /** The token changed (initial auth or refresh). */
  'token-changed': AuthState;
  /** A custom message was received from the parent. */
  'custom-message': CustomMessageEvent;
  /** An error was received from the parent. */
  error: { error: Error; nonce?: string };
}
