# signed-iframe-bridge

Secure parent-child iframe communication with signed JWT authentication.

A TypeScript library that enables a parent webpage to communicate with a child iframe via `postMessage`, using asymmetric JWT signatures (ES256/RS256) for authentication. Once authenticated, both sides can exchange custom messages over the same secure, origin-validated channel.

## Install

```bash
npm install @reperio-news/signed-iframe-bridge
```

## Quick Start

### Parent Page

```typescript
import { ParentService } from '@reperio-news/signed-iframe-bridge';

const service = new ParentService({
  iframe: document.getElementById('child-iframe') as HTMLIFrameElement,
  // childOrigin is automatically derived from the iframe's src attribute
  onTokenRefresh: async () => {
    // Fetch a signed JWT from your backend — the private key stays on the server
    const res = await fetch('/api/iframe-token');
    const { token } = await res.json();
    return token;
  },
});

await service.connect();
// Child iframe is now authenticated
```

### Child Iframe

```typescript
import { ChildService, importSPKI } from '@reperio-news/signed-iframe-bridge';

const publicKey = await importSPKI(PUBLIC_KEY_PEM, 'ES256');

const service = new ChildService({
  // parentOrigin is optional — auto-locks to the first verified parent origin
  publicKey,
});

// authenticate() handles everything: connect, verify, and refresh
const auth = await service.authenticate();
console.log(auth.payload.uid);         // user id from JWT
console.log(auth.payload.permissions); // ['read', 'write', ...]

// Later — call authenticate() again to check validity (auto-refreshes if expired)
const freshAuth = await service.authenticate();

// Forward token to your own backend for server-side verification
const response = await fetch('/api/verify', {
  headers: { Authorization: `Bearer ${freshAuth.rawToken}` },
});
```

## How It Works

### Authentication Flow

1. Parent creates an iframe and calls `service.connect()`
2. Child iframe calls `service.authenticate()`, which sends a `ready` message to the parent
3. Parent receives `ready`, calls the `onTokenRefresh` callback, and sends the signed JWT to the child
4. Child verifies the JWT using the public key and resolves `authenticate()` with an `AuthState`

### Token Refresh Flow

1. Child calls `await service.authenticate()` again (or `requestTokenRefresh()`)
2. If the token hasn't expired, returns the current `AuthState` immediately
3. If expired (or within 2s of expiry), automatically sends a `refresh-request` to the parent
4. Parent calls `onTokenRefresh()` and sends back the new token
5. Child verifies the new token and resolves the promise

```
Parent                          Child Iframe
  │                                  │
  │         ◄── ready ───────────────│  child signals it's loaded
  │                                  │
  │── auth (signed JWT) ──────────►  │  parent sends initial token
  │                                  │
  │         ◄── refresh-request ─────│  child's token expired
  │                                  │
  │── refresh-response (new JWT) ──► │  parent sends fresh token
  │                                  │
  │── custom message ─────────────►  │  parent.send(channel, data)
  │                                  │
  │         ◄── custom message ──────│  child.send(channel, data)
  │                                  │
```

## Custom Messaging

Once connected, both sides can exchange arbitrary messages using `send()` and the `custom-message` event. All custom messages go through the same origin-validated, namespace-filtered channel as auth messages.

### Child → Parent

```typescript
// Child sends a message
service.send('user-action', { action: 'clicked', target: 'save-button' });
service.send('resize', { width: 800, height: 600 });
service.send('ping'); // data is optional
```

```typescript
// Parent listens
service.on('custom-message', ({ channel, data }) => {
  switch (channel) {
    case 'user-action':
      console.log('User did:', data);
      break;
    case 'resize':
      iframe.style.height = `${data.height}px`;
      break;
    case 'ping':
      service.send('pong'); // respond back
      break;
  }
});
```

### Parent → Child

```typescript
// Parent sends a message
service.send('theme-update', { theme: 'dark' });
service.send('config', { locale: 'en-US', features: ['beta'] });
```

```typescript
// Child listens
service.on('custom-message', ({ channel, data }) => {
  if (channel === 'theme-update') {
    document.body.classList.toggle('dark', data.theme === 'dark');
  }
});
```

## Event Subscription

Both services emit typed events you can subscribe to for logging, monitoring, or reacting to state changes.

### Child Events

```typescript
const service = new ChildService({ parentOrigin, publicKey });

// Log all protocol messages received from the parent
service.on('message', (msg) => {
  console.log(`[signed-iframe-bridge] received: ${msg.type}`, msg);
});

// React to initial authentication
service.on('authenticated', (auth) => {
  console.log(`Authenticated as ${auth.payload?.uid}`);
});

// React to any token change (initial auth + refreshes)
service.on('token-changed', (auth) => {
  console.log('Token updated, new expiry:', auth.payload?.exp);
  // e.g., update headers on an API client
  apiClient.setToken(auth.rawToken);
});

// Handle errors from the parent
service.on('error', ({ error, nonce }) => {
  console.error('Parent error:', error.message, nonce);
});

const auth = await service.authenticate();
```

### Parent Events

```typescript
const service = new ParentService({ iframe, childOrigin, onTokenRefresh });

// Log all protocol messages received from the child
service.on('message', (msg) => {
  console.log(`[signed-iframe-bridge] received: ${msg.type}`, msg);
});

// Know when the child is ready
service.on('ready', () => {
  console.log('Child iframe is ready');
});

// Track token deliveries
service.on('token-sent', ({ nonce }) => {
  console.log('Token sent to child, nonce:', nonce);
});

// Handle refresh errors
service.on('error', ({ error, nonce }) => {
  console.error('Failed to refresh token:', error.message);
});

await service.connect();
```

### Unsubscribing

`on()` returns an unsubscribe function:

```typescript
const unsub = service.on('token-changed', (auth) => { /* ... */ });

// Later
unsub();

// Or use off() directly
const handler = (auth) => { /* ... */ };
service.on('token-changed', handler);
service.off('token-changed', handler);
```

## Backend Integration

The `onTokenRefresh` callback is where you integrate with your server. Here's a typical Express example:

### Server (Node.js / Express)

```typescript
import express from 'express';
import { createToken, importPKCS8 } from '@reperio-news/signed-iframe-bridge';
import { readFileSync } from 'fs';

const app = express();
const privateKey = await importPKCS8(readFileSync('./private-key.pem', 'utf8'), 'ES256');

app.get('/api/iframe-token', authenticateUser, async (req, res) => {
  const token = await createToken(privateKey, 'ES256', {
    uid: req.user.id,
    user: { name: req.user.name, email: req.user.email },
    permissions: req.user.permissions,
  }, 3600, {
    issuer: 'my-app',
    audience: 'child-app',
  });

  res.json({ token });
});
```

### Child Backend Verification

When the child iframe forwards the raw token to its own backend:

```typescript
import { verifyToken, importSPKI } from '@reperio-news/signed-iframe-bridge';
import { readFileSync } from 'fs';

const publicKey = await importSPKI(readFileSync('./public-key.pem', 'utf8'), 'ES256');

app.get('/api/data', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = await verifyToken(token, publicKey, 'ES256', {
      issuer: 'my-app',
      audience: 'child-app',
    });
    // payload.uid, payload.permissions, etc.
    res.json({ data: 'secret stuff', user: payload.uid });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});
```

## API Reference

### `ParentService`

```typescript
new ParentService(options: ParentServiceOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `iframe` | `HTMLIFrameElement` | Yes | — | The iframe element to communicate with |
| `childOrigin` | `string` | No | Derived from iframe `src` | Expected origin of the child iframe. Auto-derived from the iframe's `src` if omitted. Use `"*"` to allow any origin |
| `onTokenRefresh` | `() => Promise<string>` | Yes | — | Async callback that returns a signed JWT string (fetch from your server) |
| `connectTimeout` | `number` | No | `30000` | Timeout in ms waiting for child ready |
| `refreshThrottleMs` | `number` | No | `1000` | Minimum interval in ms between refresh calls (prevents child from overwhelming your backend) |

**Methods:**

- **`connect(): Promise<void>`** — Wait for the child to be ready, then send the initial auth token.
- **`send(channel, data?): void`** — Send a custom message to the child iframe.
- **`destroy(): void`** — Remove all event listeners and clean up.

**Events:**

| Event | Payload | When |
|-------|---------|------|
| `message` | `AnyProtocolMessage` | Any protocol message received from child |
| `ready` | `void` | Child iframe signalled it's ready |
| `token-sent` | `{ nonce?: string }` | A token was successfully sent to the child |
| `custom-message` | `{ channel: string, data?: unknown }` | A custom message was received from the child |
| `error` | `{ error: Error, nonce?: string }` | Failed to handle a refresh request |

### `ChildService`

```typescript
new ChildService(options: ChildServiceOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `parentOrigin` | `string` | No | Auto-lock | Expected origin of the parent page. If omitted, accepts any origin initially and locks onto the origin of the first verified auth token. Use `"*"` to allow any origin without locking |
| `publicKey` | `CryptoKey \| KeyLike` | Yes | — | Public key for JWT verification |
| `algorithm` | `'ES256' \| 'RS256'` | No | `'ES256'` | Expected signing algorithm |
| `issuer` | `string` | No | — | Expected JWT issuer (rejects mismatches) |
| `audience` | `string` | No | — | Expected JWT audience |
| `connectTimeout` | `number` | No | `30000` | Timeout in ms waiting for auth token |
| `refreshTimeout` | `number` | No | `10000` | Timeout in ms for refresh requests |

**Methods:**

- **`authenticate(): Promise<AuthState>`** — Single entry point. Connects if needed, returns current state if valid, refreshes if expired.
- **`requestTokenRefresh(): Promise<AuthState>`** — Explicitly request a new token from the parent.
- **`send(channel, data?): void`** — Send a custom message to the parent.
- **`getRawToken(): string | null`** — Get the raw JWT string (for forwarding to your backend).
- **`getPayload(): SignedIframeBridgePayload | null`** — Get the decoded payload without re-verifying.
- **`destroy(): void`** — Remove all event listeners and clean up.

**Events:**

| Event | Payload | When |
|-------|---------|------|
| `message` | `AnyProtocolMessage` | Any protocol message received from parent |
| `authenticated` | `AuthState` | Initial authentication completed |
| `token-changed` | `AuthState` | Token changed (initial auth or refresh) |
| `custom-message` | `{ channel: string, data?: unknown }` | A custom message was received from the parent |
| `error` | `{ error: Error, nonce?: string }` | Error received from parent |

### `AuthState`

```typescript
interface AuthState {
  valid: boolean;                      // Whether the token is valid and not expired
  payload: SignedIframeBridgePayload | null; // Decoded JWT payload
  rawToken: string | null;             // Raw JWT string
}
```

### `SignedIframeBridgePayload`

```typescript
interface SignedIframeBridgePayload extends JWTPayload {
  uid: string;                          // User identifier
  user?: Record<string, unknown>;       // Arbitrary user info
  permissions?: string[];               // Permission strings
}
```

### Token Helpers

Standalone functions for creating/verifying tokens (useful on your backend):

```typescript
import { createToken, verifyToken, decodeToken, isTokenExpired } from '@reperio-news/signed-iframe-bridge';

// Create a signed JWT (TTL in seconds)
const token = await createToken(privateKey, 'ES256', payload, 3600, { issuer: 'my-app' });

// Verify a JWT (throws on failure)
const payload = await verifyToken(token, publicKey, 'ES256', { issuer: 'my-app' });

// Decode without verification (for quick inspection)
const decoded = decodeToken(token);

// Check if expired (includes 2s grace period by default)
const expired = isTokenExpired(token);
const expiredCustomGrace = isTokenExpired(token, 5000); // 5s grace
```

### Key Helpers

Key generation and import/export helpers (re-exported from [jose](https://github.com/panva/jose)):

```typescript
import { generateKeyPair, importSPKI, importPKCS8, exportSPKI, exportPKCS8 } from '@reperio-news/signed-iframe-bridge';

// Generate a new key pair
const { publicKey, privateKey } = await generateKeyPair('ES256');

// Import keys from PEM strings
const pubKey = await importSPKI(pemString, 'ES256');
const privKey = await importPKCS8(pemString, 'ES256');

// Export keys to PEM strings
const pubPem = await exportSPKI(publicKey);
const privPem = await exportPKCS8(privateKey);
```

## Multiple Iframes

Create one `ParentService` per iframe. Each instance independently manages its own connection:

```typescript
const iframes = document.querySelectorAll<HTMLIFrameElement>('.child-iframe');

const services = Array.from(iframes).map(iframe =>
  new ParentService({
    iframe,
    childOrigin: 'https://child.example.com',
    onTokenRefresh: () => generateTokenFor(iframe.id),
  })
);

await Promise.all(services.map(s => s.connect()));
```

Each instance checks `event.source` to ensure it only processes messages from its specific iframe.

## Security

- **Origin validation** on every incoming message (strict match by default, or `"*"` to allow any origin)
- **Namespace filtering** — only processes messages with `ns: '@reperio-news/signed-iframe-bridge'`
- **Asymmetric crypto** — the private key stays on your server; only the public key is used client-side
- **Nonce correlation** for refresh request/response pairs prevents replay confusion
- **Refresh throttling** on the parent prevents child from overwhelming your token endpoint
- **Grace period** on token expiry (2s default) prevents using almost-expired tokens
- **Timeouts** on all async operations to prevent indefinite hanging
- **Error propagation** across the postMessage boundary with preserved error context

### Origin Auto-Detection

Both `childOrigin` and `parentOrigin` are optional:

- **`childOrigin`** (parent side) — automatically derived from the iframe's `src` attribute if omitted.
- **`parentOrigin`** (child side) — if omitted, the child accepts messages from any origin initially. Once the first JWT is successfully verified, the child **locks onto that origin** and rejects all subsequent messages from other origins. This is the recommended default — the JWT signature acts as the trust anchor, and the locked origin provides defense-in-depth afterward.

Set either to `"*"` to allow any origin permanently without locking.

This is safe because **JWT signature verification is the primary security mechanism** — a malicious origin cannot forge a valid token without the private key.

### Rate Limiting

The parent throttles refresh requests by default (1 second between calls). Adjust via `refreshThrottleMs`:

```typescript
new ParentService({
  // ...
  refreshThrottleMs: 2000, // at most one refresh every 2 seconds
});
```

Your backend `onTokenRefresh` endpoint should also implement its own rate limiting as a defense-in-depth measure.

## Errors

All errors extend `SignedIframeBridgeError` and include a `code` property:

| Error | Code | When |
|-------|------|------|
| `ConnectionTimeoutError` | `CONNECTION_TIMEOUT` | Child didn't signal ready, or parent didn't send auth, within timeout |
| `RefreshTimeoutError` | `REFRESH_TIMEOUT` | Parent didn't respond to refresh request within timeout |
| `TokenVerificationError` | `TOKEN_VERIFICATION_FAILED` | JWT signature or claims verification failed (includes original error as `cause`) |
| `TokenExpiredError` | `TOKEN_EXPIRED` | Token TTL has passed |
| `OriginMismatchError` | `ORIGIN_MISMATCH` | Message received from unexpected origin |
| `ProtocolError` | `PROTOCOL_ERROR` | Malformed or unexpected protocol message |

## License

MIT
