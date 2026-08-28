// src/protocol.ts
var PROTOCOL_NS = "signed-iframe-bridge";
function isProtocolMessage(data) {
  return typeof data === "object" && data !== null && data.ns === PROTOCOL_NS;
}
function isReadyMessage(data) {
  return isProtocolMessage(data) && data.type === "ready";
}
function isAuthMessage(data) {
  return isProtocolMessage(data) && data.type === "auth" && typeof data.token === "string";
}
function isRefreshRequestMessage(data) {
  return isProtocolMessage(data) && data.type === "refresh-request" && typeof data.nonce === "string";
}
function isRefreshResponseMessage(data) {
  return isProtocolMessage(data) && data.type === "refresh-response" && typeof data.nonce === "string" && typeof data.token === "string";
}
function isErrorMessage(data) {
  return isProtocolMessage(data) && data.type === "error" && typeof data.code === "string" && typeof data.message === "string";
}
function isCustomMessage(data) {
  return isProtocolMessage(data) && data.type === "custom" && typeof data.channel === "string";
}
function createReadyMessage() {
  return { ns: PROTOCOL_NS, type: "ready" };
}
function createAuthMessage(token) {
  return { ns: PROTOCOL_NS, type: "auth", token };
}
function createRefreshRequestMessage(nonce) {
  return { ns: PROTOCOL_NS, type: "refresh-request", nonce };
}
function createRefreshResponseMessage(nonce, token) {
  return { ns: PROTOCOL_NS, type: "refresh-response", nonce, token };
}
function createErrorMessage(code, message, nonce) {
  return { ns: PROTOCOL_NS, type: "error", code, message, ...nonce ? { nonce } : {} };
}
function createCustomMessage(channel, data) {
  return { ns: PROTOCOL_NS, type: "custom", channel, data };
}

// src/errors.ts
var SignedIframeBridgeError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SignedIframeBridgeError";
    this.code = code;
  }
};
var TokenVerificationError = class extends SignedIframeBridgeError {
  constructor(reason, cause) {
    super("TOKEN_VERIFICATION_FAILED", `Token verification failed: ${reason}`);
    this.name = "TokenVerificationError";
    if (cause) this.cause = cause;
  }
};
var TokenExpiredError = class extends SignedIframeBridgeError {
  constructor() {
    super("TOKEN_EXPIRED", "Token has expired");
    this.name = "TokenExpiredError";
  }
};
var RefreshTimeoutError = class extends SignedIframeBridgeError {
  constructor(timeoutMs) {
    super("REFRESH_TIMEOUT", `Token refresh timed out after ${timeoutMs}ms`);
    this.name = "RefreshTimeoutError";
  }
};
var ConnectionTimeoutError = class extends SignedIframeBridgeError {
  constructor(timeoutMs) {
    super("CONNECTION_TIMEOUT", `Connection timed out after ${timeoutMs}ms`);
    this.name = "ConnectionTimeoutError";
  }
};

// src/utils.ts
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function generateNonce() {
  return crypto.randomUUID();
}
function isOriginAllowed(expected, actual) {
  return expected === "*" || expected === actual;
}

// src/events.ts
var TypedEmitter = class {
  listeners = /* @__PURE__ */ new Map();
  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, /* @__PURE__ */ new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }
  /** Unsubscribe from an event. */
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }
  /** Emit an event to all subscribers. */
  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }
  /** Remove all listeners. */
  removeAllListeners() {
    this.listeners.clear();
  }
};

// src/parent-service.ts
var ParentService = class extends TypedEmitter {
  childOrigin;
  iframe;
  onTokenRefresh;
  connectTimeout;
  refreshThrottleMs;
  messageHandler = null;
  readyDeferred = null;
  connected = false;
  destroyed = false;
  lastRefreshTime = 0;
  constructor(options) {
    super();
    this.iframe = options.iframe;
    this.childOrigin = options.childOrigin ?? this.deriveChildOrigin();
    this.onTokenRefresh = options.onTokenRefresh;
    this.connectTimeout = options.connectTimeout ?? 3e4;
    this.refreshThrottleMs = options.refreshThrottleMs ?? 1e3;
  }
  /** Derive the child origin from the iframe's src attribute. */
  deriveChildOrigin() {
    const src = this.iframe.src;
    if (!src) {
      throw new Error(
        "Cannot derive childOrigin: iframe has no src attribute. Set childOrigin explicitly."
      );
    }
    try {
      return new URL(src).origin;
    } catch {
      throw new Error(
        `Cannot derive childOrigin: iframe src "${src}" is not a valid URL. Set childOrigin explicitly.`
      );
    }
  }
  /**
   * Wait for the child iframe to signal readiness, then send
   * the initial auth token. Resolves when the child is authenticated.
   */
  async connect() {
    if (this.destroyed) throw new Error("ParentService has been destroyed");
    if (this.connected) return;
    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener("message", this.messageHandler);
    this.readyDeferred = createDeferred();
    const timeout = setTimeout(() => {
      this.readyDeferred?.reject(new ConnectionTimeoutError(this.connectTimeout));
    }, this.connectTimeout);
    try {
      await this.readyDeferred.promise;
    } finally {
      clearTimeout(timeout);
    }
    const token = await this.onTokenRefresh();
    this.postToChild(createAuthMessage(token));
    this.lastRefreshTime = Date.now();
    this.connected = true;
  }
  /** Send a custom message to the child iframe. */
  send(channel, data) {
    this.postToChild(createCustomMessage(channel, data));
  }
  /** Remove all event listeners and clean up. */
  destroy() {
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    this.readyDeferred?.reject(new Error("ParentService destroyed"));
    this.readyDeferred = null;
    this.destroyed = true;
    this.connected = false;
    this.removeAllListeners();
  }
  handleMessage(event) {
    if (!isOriginAllowed(this.childOrigin, event.origin)) return;
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data;
    if (!data || data.ns !== PROTOCOL_NS) return;
    this.emit("message", data);
    if (isReadyMessage(data)) {
      this.emit("ready", void 0);
      this.readyDeferred?.resolve();
      return;
    }
    if (isRefreshRequestMessage(data)) {
      this.handleRefreshRequest(data.nonce);
      return;
    }
    if (isCustomMessage(data)) {
      this.emit("custom-message", { channel: data.channel, data: data.data });
      return;
    }
  }
  async handleRefreshRequest(nonce) {
    const now = Date.now();
    const elapsed = now - this.lastRefreshTime;
    if (elapsed < this.refreshThrottleMs) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshThrottleMs - elapsed));
    }
    try {
      const token = await this.onTokenRefresh();
      this.lastRefreshTime = Date.now();
      this.postToChild(createRefreshResponseMessage(nonce, token));
      this.emit("token-sent", { nonce });
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Token refresh failed");
      this.postToChild(createErrorMessage("REFRESH_FAILED", error.message, nonce));
      this.emit("error", { error, nonce });
    }
  }
  postToChild(message) {
    const win = this.iframe.contentWindow;
    if (!win) {
      const error = new Error("Cannot reach iframe: contentWindow is null");
      this.emit("error", { error });
      return;
    }
    win.postMessage(message, this.childOrigin);
  }
};

// src/token.ts
import { SignJWT, jwtVerify, decodeJwt } from "jose";
async function createToken(privateKey, algorithm, payload, ttl, options) {
  let builder = new SignJWT(payload).setProtectedHeader({ alg: algorithm }).setIssuedAt().setExpirationTime(`${ttl}s`);
  if (options?.issuer) builder = builder.setIssuer(options.issuer);
  if (options?.audience) builder = builder.setAudience(options.audience);
  return builder.sign(privateKey);
}
async function verifyToken(token, publicKey, algorithm, options) {
  const verifyOptions = {
    algorithms: [algorithm]
  };
  if (options?.issuer) verifyOptions.issuer = options.issuer;
  if (options?.audience) verifyOptions.audience = options.audience;
  const { payload } = await jwtVerify(token, publicKey, verifyOptions);
  return payload;
}
function decodeToken(token) {
  return decodeJwt(token);
}
function isTokenExpired(token, gracePeriodMs = 2e3) {
  try {
    const payload = decodeJwt(token);
    if (!payload.exp) return true;
    return payload.exp * 1e3 - gracePeriodMs <= Date.now();
  } catch {
    return true;
  }
}

// src/child-service.ts
var ChildService = class extends TypedEmitter {
  parentOrigin;
  autoLockOrigin;
  publicKey;
  algorithm;
  issuer;
  audience;
  connectTimeout;
  refreshTimeout;
  currentToken = null;
  currentPayload = null;
  messageHandler = null;
  authDeferred = null;
  pendingRefreshes = /* @__PURE__ */ new Map();
  connectPromise = null;
  connected = false;
  destroyed = false;
  constructor(options) {
    super();
    this.autoLockOrigin = options.parentOrigin === void 0;
    this.parentOrigin = options.parentOrigin ?? "*";
    this.publicKey = options.publicKey;
    this.algorithm = options.algorithm ?? "ES256";
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.connectTimeout = options.connectTimeout ?? 3e4;
    this.refreshTimeout = options.refreshTimeout ?? 1e4;
  }
  /**
   * Single entry point for authentication. Handles all states:
   * - Not connected → connects (sends ready, waits for initial token, verifies)
   * - Connected + token valid → returns current AuthState
   * - Connected + token expired → requests refresh, verifies, returns new AuthState
   */
  async authenticate() {
    if (this.destroyed) throw new Error("ChildService has been destroyed");
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
  async requestTokenRefresh() {
    const nonce = generateNonce();
    const deferred = createDeferred();
    this.pendingRefreshes.set(nonce, deferred);
    window.parent.postMessage(createRefreshRequestMessage(nonce), this.parentOrigin);
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
      this.emit("token-changed", state);
      return state;
    } finally {
      clearTimeout(timeout);
      this.pendingRefreshes.delete(nonce);
    }
  }
  /** Send a custom message to the parent. */
  send(channel, data) {
    window.parent.postMessage(createCustomMessage(channel, data), this.parentOrigin);
  }
  /** Get the raw JWT string for forwarding to the child's backend. */
  getRawToken() {
    return this.currentToken;
  }
  /** Get the decoded payload without re-verifying. */
  getPayload() {
    return this.currentPayload;
  }
  /** Remove all event listeners and clean up. */
  destroy() {
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    for (const [, deferred] of this.pendingRefreshes) {
      deferred.reject(new Error("ChildService destroyed"));
    }
    this.pendingRefreshes.clear();
    this.authDeferred?.reject(new Error("ChildService destroyed"));
    this.authDeferred = null;
    this.destroyed = true;
    this.connected = false;
    this.currentToken = null;
    this.currentPayload = null;
    this.removeAllListeners();
  }
  async doConnect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnectInternal();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  async doConnectInternal() {
    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener("message", this.messageHandler);
    this.authDeferred = createDeferred();
    window.parent.postMessage(createReadyMessage(), this.parentOrigin);
    const timeout = setTimeout(() => {
      this.authDeferred?.reject(new ConnectionTimeoutError(this.connectTimeout));
    }, this.connectTimeout);
    try {
      const { token, origin } = await this.authDeferred.promise;
      await this.setToken(token);
      if (this.autoLockOrigin) {
        this.parentOrigin = origin;
      }
      this.connected = true;
      const state = this.buildAuthState();
      this.emit("authenticated", state);
      this.emit("token-changed", state);
      return state;
    } finally {
      clearTimeout(timeout);
      this.authDeferred = null;
    }
  }
  handleMessage(event) {
    if (!isOriginAllowed(this.parentOrigin, event.origin)) return;
    const data = event.data;
    if (!data || data.ns !== PROTOCOL_NS) return;
    this.emit("message", data);
    if (isAuthMessage(data)) {
      this.authDeferred?.resolve({ token: data.token, origin: event.origin });
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
      this.emit("error", { error, nonce: data.nonce });
      return;
    }
    if (isCustomMessage(data)) {
      this.emit("custom-message", { channel: data.channel, data: data.data });
      return;
    }
  }
  async setToken(token) {
    try {
      const payload = await verifyToken(token, this.publicKey, this.algorithm, {
        issuer: this.issuer,
        audience: this.audience
      });
      this.currentToken = token;
      this.currentPayload = payload;
    } catch (err) {
      this.currentToken = null;
      this.currentPayload = null;
      const reason = err instanceof Error ? err.message : "Unknown error";
      throw new TokenVerificationError(reason, err instanceof Error ? err : void 0);
    }
  }
  buildAuthState() {
    return {
      valid: this.currentToken !== null && !isTokenExpired(this.currentToken),
      payload: this.currentPayload,
      rawToken: this.currentToken
    };
  }
};

// src/keys.ts
import { generateKeyPair as joseGenerateKeyPair } from "jose";
async function generateKeyPair(algorithm = "ES256") {
  const { publicKey, privateKey } = await joseGenerateKeyPair(algorithm);
  return { publicKey, privateKey };
}

// src/index.ts
import { importSPKI, importPKCS8, exportSPKI, exportPKCS8 } from "jose";
export {
  ChildService,
  ConnectionTimeoutError,
  ParentService,
  RefreshTimeoutError,
  SignedIframeBridgeError,
  TokenExpiredError,
  TokenVerificationError,
  createToken,
  decodeToken,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  isTokenExpired,
  verifyToken
};
//# sourceMappingURL=index.mjs.map