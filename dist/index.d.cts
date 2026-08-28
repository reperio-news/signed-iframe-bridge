import { JWTPayload, KeyLike } from 'jose';
export { exportPKCS8, exportSPKI, importPKCS8, importSPKI } from 'jose';

declare const PROTOCOL_NS: "signed-iframe-bridge";
type MessageType = 'ready' | 'auth' | 'refresh-request' | 'refresh-response' | 'error' | 'custom';
interface ProtocolMessage {
    ns: typeof PROTOCOL_NS;
    type: MessageType;
    nonce?: string;
}
interface ReadyMessage extends ProtocolMessage {
    type: 'ready';
}
interface AuthMessage extends ProtocolMessage {
    type: 'auth';
    token: string;
}
interface RefreshRequestMessage extends ProtocolMessage {
    type: 'refresh-request';
    nonce: string;
}
interface RefreshResponseMessage extends ProtocolMessage {
    type: 'refresh-response';
    nonce: string;
    token: string;
}
interface ErrorMessage extends ProtocolMessage {
    type: 'error';
    nonce?: string;
    code: string;
    message: string;
}
interface CustomMessage extends ProtocolMessage {
    type: 'custom';
    channel: string;
    data?: unknown;
}
type AnyProtocolMessage = ReadyMessage | AuthMessage | RefreshRequestMessage | RefreshResponseMessage | ErrorMessage | CustomMessage;

/** JWT payload carried inside signed-iframe tokens. */
interface SignedIframeBridgePayload extends JWTPayload {
    /** Unique user identifier. */
    uid: string;
    /** Arbitrary user info (name, email, avatar, etc.). */
    user?: Record<string, unknown>;
    /** Permission strings the child can inspect. */
    permissions?: string[];
}
/** Supported signing algorithms. */
type SupportedAlgorithm = 'ES256' | 'RS256';
/** Configuration for the parent-side service. */
interface ParentServiceOptions {
    /** The iframe element to communicate with. */
    iframe: HTMLIFrameElement;
    /**
     * Expected origin of the child iframe (e.g. "https://child.example.com").
     * If omitted, automatically derived from the iframe's `src` attribute.
     * Use `"*"` to allow any origin.
     */
    childOrigin?: string;
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
interface ChildServiceOptions {
    /**
     * Expected origin of the parent page (e.g. "https://parent.example.com").
     * If omitted, the child accepts messages from any origin initially and
     * locks onto the origin of the first successfully verified auth token.
     * Use `"*"` to allow any origin without locking.
     */
    parentOrigin?: string;
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
interface AuthState {
    /** Whether the current token is valid and not expired. */
    valid: boolean;
    /** Decoded payload (present when valid). */
    payload: SignedIframeBridgePayload | null;
    /** Raw JWT string (useful for forwarding to child's backend). */
    rawToken: string | null;
}
/** Payload delivered to custom-message event handlers. */
interface CustomMessageEvent {
    /** The channel name the message was sent on. */
    channel: string;
    /** The data payload (any serialisable value). */
    data?: unknown;
}
/** Events emitted by ParentService. */
interface ParentEventMap {
    /** A protocol message was received from the child. */
    message: AnyProtocolMessage;
    /** The child iframe signalled it is ready. */
    ready: void;
    /** A refresh request was received and fulfilled. */
    'token-sent': {
        nonce?: string;
    };
    /** A custom message was received from the child. */
    'custom-message': CustomMessageEvent;
    /** An error occurred while handling a refresh request. */
    error: {
        error: Error;
        nonce?: string;
    };
}
/** Events emitted by ChildService. */
interface ChildEventMap {
    /** A protocol message was received from the parent. */
    message: AnyProtocolMessage;
    /** Initial authentication completed or token was refreshed. */
    authenticated: AuthState;
    /** The token changed (initial auth or refresh). */
    'token-changed': AuthState;
    /** A custom message was received from the parent. */
    'custom-message': CustomMessageEvent;
    /** An error was received from the parent. */
    error: {
        error: Error;
        nonce?: string;
    };
}

/** Minimal typed event emitter for services. */
type EventHandler<T = unknown> = (data: T) => void;
declare class TypedEmitter<EventMap extends {}> {
    private listeners;
    /** Subscribe to an event. Returns an unsubscribe function. */
    on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void;
    /** Unsubscribe from an event. */
    off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
    /** Emit an event to all subscribers. */
    protected emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void;
    /** Remove all listeners. */
    protected removeAllListeners(): void;
}

declare class ParentService extends TypedEmitter<ParentEventMap> {
    private readonly childOrigin;
    private readonly iframe;
    private readonly onTokenRefresh;
    private readonly connectTimeout;
    private readonly refreshThrottleMs;
    private messageHandler;
    private readyDeferred;
    private connected;
    private destroyed;
    private lastRefreshTime;
    constructor(options: ParentServiceOptions);
    /** Derive the child origin from the iframe's src attribute. */
    private deriveChildOrigin;
    /**
     * Wait for the child iframe to signal readiness, then send
     * the initial auth token. Resolves when the child is authenticated.
     */
    connect(): Promise<void>;
    /** Send a custom message to the child iframe. */
    send(channel: string, data?: unknown): void;
    /** Remove all event listeners and clean up. */
    destroy(): void;
    private handleMessage;
    private handleRefreshRequest;
    private postToChild;
}

declare class ChildService extends TypedEmitter<ChildEventMap> {
    private parentOrigin;
    private readonly autoLockOrigin;
    private readonly publicKey;
    private readonly algorithm;
    private readonly issuer?;
    private readonly audience?;
    private readonly connectTimeout;
    private readonly refreshTimeout;
    private currentToken;
    private currentPayload;
    private messageHandler;
    private authDeferred;
    private pendingRefreshes;
    private connectPromise;
    private connected;
    private destroyed;
    constructor(options: ChildServiceOptions);
    /**
     * Single entry point for authentication. Handles all states:
     * - Not connected → connects (sends ready, waits for initial token, verifies)
     * - Connected + token valid → returns current AuthState
     * - Connected + token expired → requests refresh, verifies, returns new AuthState
     */
    authenticate(): Promise<AuthState>;
    /**
     * Explicitly request a new token from the parent.
     * Returns the new AuthState once the parent responds.
     */
    requestTokenRefresh(): Promise<AuthState>;
    /** Send a custom message to the parent. */
    send(channel: string, data?: unknown): void;
    /** Get the raw JWT string for forwarding to the child's backend. */
    getRawToken(): string | null;
    /** Get the decoded payload without re-verifying. */
    getPayload(): SignedIframeBridgePayload | null;
    /** Remove all event listeners and clean up. */
    destroy(): void;
    private doConnect;
    private doConnectInternal;
    private handleMessage;
    private setToken;
    private buildAuthState;
}

/** Create a signed JWT with the given payload and TTL. */
declare function createToken(privateKey: CryptoKey | KeyLike, algorithm: SupportedAlgorithm, payload: SignedIframeBridgePayload, ttl: number, options?: {
    issuer?: string;
    audience?: string;
}): Promise<string>;
/** Verify a JWT and return the typed payload. */
declare function verifyToken(token: string, publicKey: CryptoKey | KeyLike, algorithm: SupportedAlgorithm, options?: {
    issuer?: string;
    audience?: string;
}): Promise<SignedIframeBridgePayload>;
/** Decode a JWT without verification (for quick local inspection). */
declare function decodeToken(token: string): SignedIframeBridgePayload;
/**
 * Check if a token's exp claim has passed (or will pass within the grace period).
 * @param token - The JWT string to check.
 * @param gracePeriodMs - Consider the token expired this many ms before actual expiry. Default: 2000.
 */
declare function isTokenExpired(token: string, gracePeriodMs?: number): boolean;

interface KeyPair {
    publicKey: CryptoKey | KeyLike;
    privateKey: CryptoKey | KeyLike;
}
/** Generate an asymmetric key pair for the given algorithm. */
declare function generateKeyPair(algorithm?: SupportedAlgorithm): Promise<KeyPair>;

declare class SignedIframeBridgeError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
declare class TokenVerificationError extends SignedIframeBridgeError {
    constructor(reason: string, cause?: Error);
}
declare class TokenExpiredError extends SignedIframeBridgeError {
    constructor();
}
declare class RefreshTimeoutError extends SignedIframeBridgeError {
    constructor(timeoutMs: number);
}
declare class ConnectionTimeoutError extends SignedIframeBridgeError {
    constructor(timeoutMs: number);
}

export { type AuthState, type ChildEventMap, ChildService, type ChildServiceOptions, ConnectionTimeoutError, type CustomMessageEvent, type KeyPair, type ParentEventMap, ParentService, type ParentServiceOptions, RefreshTimeoutError, SignedIframeBridgeError, type SignedIframeBridgePayload, type SupportedAlgorithm, TokenExpiredError, TokenVerificationError, createToken, decodeToken, generateKeyPair, isTokenExpired, verifyToken };
