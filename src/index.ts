// Services
export { ParentService } from './parent-service.js';
export { ChildService } from './child-service.js';

// Token helpers
export { createToken, verifyToken, decodeToken, isTokenExpired } from './token.js';

// Key helpers (re-exported from jose for convenience)
export { generateKeyPair } from './keys.js';
export type { KeyPair } from './keys.js';
export { importSPKI, importPKCS8, exportSPKI, exportPKCS8 } from 'jose';

// Types
export type {
  ParentServiceOptions,
  ChildServiceOptions,
  SignedIframeBridgePayload,
  AuthState,
  SupportedAlgorithm,
  ParentEventMap,
  ChildEventMap,
  CustomMessageEvent,
} from './types.js';

// Errors
export {
  SignedIframeBridgeError,
  TokenVerificationError,
  TokenExpiredError,
  RefreshTimeoutError,
  ConnectionTimeoutError,
} from './errors.js';
