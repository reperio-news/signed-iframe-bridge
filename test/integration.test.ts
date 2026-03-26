/**
 * @vitest-environment happy-dom
 *
 * Integration test simulating parent <-> child iframe communication.
 * Uses happy-dom which doesn't have the jsdom Uint8Array realm mismatch
 * issue that breaks jose's SignJWT.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPair as joseGenerateKeyPair } from 'jose';
import { ParentService } from '../src/parent-service.js';
import { ChildService } from '../src/child-service.js';
import { createToken } from '../src/token.js';
import { PROTOCOL_NS } from '../src/protocol.js';
import type { SignedIframeBridgePayload, AuthState } from '../src/types.js';

const PARENT_ORIGIN = 'https://parent.example.com';
const CHILD_ORIGIN = 'https://child.example.com';

const basePayload: SignedIframeBridgePayload = {
  uid: 'user-42',
  user: { name: 'Bob' },
  permissions: ['admin'],
};

/**
 * Sets up a message bridge that intercepts postMessage and dispatches
 * MessageEvents with proper origin fields to registered listeners.
 */
function createMessageBridge() {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const origAddEventListener = window.addEventListener.bind(window);
  const origRemoveEventListener = window.removeEventListener.bind(window);

  vi.spyOn(window, 'addEventListener').mockImplementation(
    (type: string, handler: unknown, options?: unknown) => {
      if (type === 'message' && typeof handler === 'function') {
        listeners.push(handler as (event: MessageEvent) => void);
      }
      return origAddEventListener(
        type,
        handler as EventListenerOrEventListenerObject,
        options as boolean | AddEventListenerOptions | undefined,
      );
    },
  );

  vi.spyOn(window, 'removeEventListener').mockImplementation(
    (type: string, handler: unknown, options?: unknown) => {
      if (type === 'message' && typeof handler === 'function') {
        const idx = listeners.indexOf(handler as (event: MessageEvent) => void);
        if (idx !== -1) listeners.splice(idx, 1);
      }
      return origRemoveEventListener(
        type,
        handler as EventListenerOrEventListenerObject,
        options as boolean | EventListenerOptions | undefined,
      );
    },
  );

  function dispatch(data: unknown, origin: string, source: Window | null = window) {
    const event = new MessageEvent('message', { data, origin, source });
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  return { dispatch };
}

function setupPostMessageRouting(
  bridge: ReturnType<typeof createMessageBridge>,
  /**
   * Determines which direction a custom message is routed.
   * In tests both services share one window, so we need a hint.
   * 'child-to-parent' = child.send() → parent receives
   * 'parent-to-child' = parent.send() → child receives
   * Default: route custom messages as child→parent.
   */
  customDirection: 'child-to-parent' | 'parent-to-child' = 'child-to-parent',
) {
  vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
    const msg = data as { ns?: string; type?: string };
    if (msg?.ns !== PROTOCOL_NS) return;

    switch (msg.type) {
      case 'ready':
      case 'refresh-request':
        // child -> parent
        setTimeout(() => bridge.dispatch(data, CHILD_ORIGIN, window), 0);
        break;
      case 'auth':
      case 'refresh-response':
      case 'error':
        // parent -> child
        setTimeout(() => bridge.dispatch(data, PARENT_ORIGIN, window), 0);
        break;
      case 'custom':
        // Direction depends on who sent it
        if (customDirection === 'child-to-parent') {
          setTimeout(() => bridge.dispatch(data, CHILD_ORIGIN, window), 0);
        } else {
          setTimeout(() => bridge.dispatch(data, PARENT_ORIGIN, window), 0);
        }
        break;
    }
  });
}

function createMockIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { get: () => window });
  return iframe;
}

describe('integration: ParentService + ChildService', () => {
  let keys: Awaited<ReturnType<typeof joseGenerateKeyPair>>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Generate keys once per suite
  async function ensureKeys() {
    if (!keys) {
      keys = await joseGenerateKeyPair('ES256');
    }
    return keys;
  }

  function createTokenFactory() {
    let counter = 0;
    return async () => {
      counter++;
      const { privateKey } = await ensureKeys();
      return createToken(
        privateKey,
        'ES256',
        {
          ...basePayload,
          uid: `user-42-${counter}`,
        },
        300,
      );
    };
  }

  function createParent(
    overrides: Partial<
      Parameters<(typeof ParentService)['prototype']['constructor']> extends never
        ? Record<string, unknown>
        : Record<string, unknown>
    > = {},
  ) {
    const iframe = createMockIframe();
    const makeToken = createTokenFactory();
    return new ParentService({
      iframe,
      childOrigin: CHILD_ORIGIN,
      onTokenRefresh: makeToken,
      connectTimeout: 5000,
      refreshThrottleMs: 0,
      ...overrides,
    });
  }

  function createChild(overrides: Partial<Record<string, unknown>> = {}) {
    return new ChildService({
      parentOrigin: PARENT_ORIGIN,
      publicKey: keys.publicKey,
      connectTimeout: 5000,
      refreshTimeout: 5000,
      ...overrides,
    });
  }

  it('should complete the full authentication flow', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const [, authState] = await Promise.all([parent.connect(), child.authenticate()]);

    expect(authState.valid).toBe(true);
    expect(authState.payload?.uid).toBe('user-42-1');

    // Calling authenticate() again when connected + valid returns current state
    const sameState = await child.authenticate();
    expect(sameState.valid).toBe(true);
    expect(sameState.payload?.uid).toBe('user-42-1');

    parent.destroy();
    child.destroy();
  });

  it('should handle token refresh flow', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    // Token is still valid — authenticate() returns current state
    let state = await child.authenticate();
    expect(state.valid).toBe(true);
    expect(state.payload?.uid).toBe('user-42-1');

    // Explicit refresh
    state = await child.requestTokenRefresh();
    expect(state.valid).toBe(true);
    expect(state.payload?.uid).toBe('user-42-2');

    parent.destroy();
    child.destroy();
  });

  it('should handle refresh error from parent', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);
    let callCount = 0;
    const makeToken = createTokenFactory();

    const parent = createParent({
      onTokenRefresh: async () => {
        callCount++;
        if (callCount > 1) throw new Error('Backend unavailable');
        return makeToken();
      },
    });

    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    await expect(child.requestTokenRefresh()).rejects.toThrow('Backend unavailable');

    parent.destroy();
    child.destroy();
  });

  it('should ignore messages from wrong origin', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();

    vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
      const msg = data as { ns?: string; type?: string };
      if (msg?.ns === PROTOCOL_NS && msg.type === 'ready') {
        setTimeout(() => {
          bridge.dispatch(
            { ns: PROTOCOL_NS, type: 'auth', token: 'fake' },
            'https://evil.example.com',
            window,
          );
        }, 10);
      }
    });

    const child = new ChildService({
      parentOrigin: 'https://trusted.example.com',
      publicKey: keys.publicKey,
      connectTimeout: 500,
    });

    await expect(child.authenticate()).rejects.toThrow('Connection timed out');
    child.destroy();
  });

  it('should reject parent connect() when destroyed while waiting', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();

    // Start connecting but don't create a child — parent waits for "ready"
    const connectPromise = parent.connect();

    // Destroy while waiting
    parent.destroy();

    await expect(connectPromise).rejects.toThrow('ParentService destroyed');
  });

  it('should reject child connect() when destroyed while waiting', async () => {
    await ensureKeys();
    createMessageBridge();

    // Don't set up routing — child will wait for auth that never comes
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});

    const child = createChild();

    const connectPromise = child.authenticate();

    // Destroy while waiting for auth
    child.destroy();

    await expect(connectPromise).rejects.toThrow('ChildService destroyed');
  });

  it('should time out parent connect when child never signals ready', async () => {
    await ensureKeys();
    createMessageBridge();
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});

    const parent = createParent({ connectTimeout: 100 });

    await expect(parent.connect()).rejects.toThrow('Connection timed out');
    parent.destroy();
  });

  it('should time out child refresh when parent never responds', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild({ refreshTimeout: 100 });

    await Promise.all([parent.connect(), child.authenticate()]);

    // Destroy parent so it won't respond to refresh requests
    parent.destroy();

    await expect(child.requestTokenRefresh()).rejects.toThrow('Token refresh timed out');
    child.destroy();
  });

  it('should handle concurrent refresh requests', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    // Fire two concurrent refreshes
    const [state1, state2] = await Promise.all([
      child.requestTokenRefresh(),
      child.requestTokenRefresh(),
    ]);

    expect(state1.valid).toBe(true);
    expect(state2.valid).toBe(true);
    // Each should have received a distinct token (counter increments)
    expect(state1.payload?.uid).not.toBe('user-42-1'); // not the initial token

    parent.destroy();
    child.destroy();
  });

  it('should clean up on destroy', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    parent.destroy();
    child.destroy();

    expect(child.getRawToken()).toBeNull();
    expect(child.getPayload()).toBeNull();
  });

  // --- Event subscription tests ---

  it('should emit message events on child for all protocol messages', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const messages: unknown[] = [];
    child.on('message', (msg) => messages.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);

    // Should have received at least the auth message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m: Record<string, unknown>) => m.type === 'auth')).toBe(true);

    parent.destroy();
    child.destroy();
  });

  it('should emit authenticated and token-changed events on initial connect', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const authenticated: AuthState[] = [];
    const tokenChanged: AuthState[] = [];

    child.on('authenticated', (state) => authenticated.push(state));
    child.on('token-changed', (state) => tokenChanged.push(state));

    await Promise.all([parent.connect(), child.authenticate()]);

    expect(authenticated).toHaveLength(1);
    expect(authenticated[0].valid).toBe(true);
    expect(tokenChanged).toHaveLength(1);

    parent.destroy();
    child.destroy();
  });

  it('should emit token-changed on refresh but not authenticated', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    const authenticated: AuthState[] = [];
    const tokenChanged: AuthState[] = [];

    child.on('authenticated', (state) => authenticated.push(state));
    child.on('token-changed', (state) => tokenChanged.push(state));

    await child.requestTokenRefresh();

    expect(authenticated).toHaveLength(0); // only fires on initial connect
    expect(tokenChanged).toHaveLength(1);
    expect(tokenChanged[0].payload?.uid).toBe('user-42-2');

    parent.destroy();
    child.destroy();
  });

  it('should emit message and ready events on parent', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const messages: unknown[] = [];
    let readyFired = false;

    parent.on('message', (msg) => messages.push(msg));
    parent.on('ready', () => {
      readyFired = true;
    });

    await Promise.all([parent.connect(), child.authenticate()]);

    expect(readyFired).toBe(true);
    expect(messages.some((m: Record<string, unknown>) => m.type === 'ready')).toBe(true);

    parent.destroy();
    child.destroy();
  });

  it('should emit error event on child when parent sends error', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);
    let callCount = 0;
    const makeToken = createTokenFactory();

    const parent = createParent({
      onTokenRefresh: async () => {
        callCount++;
        if (callCount > 1) throw new Error('Server error');
        return makeToken();
      },
    });
    const child = createChild();

    await Promise.all([parent.connect(), child.authenticate()]);

    const errors: Array<{ error: Error; nonce?: string }> = [];
    child.on('error', (e) => errors.push(e));

    await expect(child.requestTokenRefresh()).rejects.toThrow('Server error');

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain('Server error');

    parent.destroy();
    child.destroy();
  });

  it('should support unsubscribing from events', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const messages: unknown[] = [];
    const unsub = child.on('message', (msg) => messages.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);
    const countAfterConnect = messages.length;

    // Unsubscribe
    unsub();

    await child.requestTokenRefresh();

    // No new messages after unsub
    expect(messages.length).toBe(countAfterConnect);

    parent.destroy();
    child.destroy();
  });

  it('should emit token-sent event on parent after refresh', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge);

    const parent = createParent();
    const child = createChild();

    const tokenSent: Array<{ nonce?: string }> = [];
    parent.on('token-sent', (e) => tokenSent.push(e));

    await Promise.all([parent.connect(), child.authenticate()]);

    await child.requestTokenRefresh();

    expect(tokenSent).toHaveLength(1);
    expect(tokenSent[0].nonce).toBeTruthy();

    parent.destroy();
    child.destroy();
  });

  // --- Custom messaging tests ---

  it('should deliver custom messages from child to parent', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge, 'child-to-parent');

    const parent = createParent();
    const child = createChild();

    const received: Array<{ channel: string; data?: unknown }> = [];
    parent.on('custom-message', (msg) => received.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);

    child.send('user-action', { action: 'clicked', target: 'button-1' });

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('user-action');
    expect(received[0].data).toEqual({ action: 'clicked', target: 'button-1' });

    parent.destroy();
    child.destroy();
  });

  it('should deliver custom messages from parent to child', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge, 'parent-to-child');

    const parent = createParent();
    const child = createChild();

    const received: Array<{ channel: string; data?: unknown }> = [];
    child.on('custom-message', (msg) => received.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);

    parent.send('theme-update', { theme: 'dark' });

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('theme-update');
    expect(received[0].data).toEqual({ theme: 'dark' });

    parent.destroy();
    child.destroy();
  });

  it('should handle custom messages with no data payload', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge, 'child-to-parent');

    const parent = createParent();
    const child = createChild();

    const received: Array<{ channel: string; data?: unknown }> = [];
    parent.on('custom-message', (msg) => received.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);

    child.send('ping');

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('ping');
    expect(received[0].data).toBeUndefined();

    parent.destroy();
    child.destroy();
  });

  it('should deliver multiple custom messages on different channels', async () => {
    await ensureKeys();
    const bridge = createMessageBridge();
    setupPostMessageRouting(bridge, 'child-to-parent');

    const parent = createParent();
    const child = createChild();

    const received: Array<{ channel: string; data?: unknown }> = [];
    parent.on('custom-message', (msg) => received.push(msg));

    await Promise.all([parent.connect(), child.authenticate()]);

    child.send('analytics', { event: 'page-view' });
    child.send('resize', { width: 800, height: 600 });

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(2);
    expect(received[0].channel).toBe('analytics');
    expect(received[1].channel).toBe('resize');

    parent.destroy();
    child.destroy();
  });
});
