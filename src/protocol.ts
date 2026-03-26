export const PROTOCOL_NS = 'signed-iframe-bridge' as const;

export type MessageType =
  | 'ready'
  | 'auth'
  | 'refresh-request'
  | 'refresh-response'
  | 'error'
  | 'custom';

export interface ProtocolMessage {
  ns: typeof PROTOCOL_NS;
  type: MessageType;
  nonce?: string;
}

export interface ReadyMessage extends ProtocolMessage {
  type: 'ready';
}

export interface AuthMessage extends ProtocolMessage {
  type: 'auth';
  token: string;
}

export interface RefreshRequestMessage extends ProtocolMessage {
  type: 'refresh-request';
  nonce: string;
}

export interface RefreshResponseMessage extends ProtocolMessage {
  type: 'refresh-response';
  nonce: string;
  token: string;
}

export interface ErrorMessage extends ProtocolMessage {
  type: 'error';
  nonce?: string;
  code: string;
  message: string;
}

export interface CustomMessage extends ProtocolMessage {
  type: 'custom';
  channel: string;
  data?: unknown;
}

export type AnyProtocolMessage =
  | ReadyMessage
  | AuthMessage
  | RefreshRequestMessage
  | RefreshResponseMessage
  | ErrorMessage
  | CustomMessage;

// --- Type guards ---

function isProtocolMessage(data: unknown): data is ProtocolMessage {
  return typeof data === 'object' && data !== null && (data as ProtocolMessage).ns === PROTOCOL_NS;
}

export function isReadyMessage(data: unknown): data is ReadyMessage {
  return isProtocolMessage(data) && data.type === 'ready';
}

export function isAuthMessage(data: unknown): data is AuthMessage {
  return (
    isProtocolMessage(data) &&
    data.type === 'auth' &&
    typeof (data as AuthMessage).token === 'string'
  );
}

export function isRefreshRequestMessage(data: unknown): data is RefreshRequestMessage {
  return (
    isProtocolMessage(data) &&
    data.type === 'refresh-request' &&
    typeof (data as RefreshRequestMessage).nonce === 'string'
  );
}

export function isRefreshResponseMessage(data: unknown): data is RefreshResponseMessage {
  return (
    isProtocolMessage(data) &&
    data.type === 'refresh-response' &&
    typeof (data as RefreshResponseMessage).nonce === 'string' &&
    typeof (data as RefreshResponseMessage).token === 'string'
  );
}

export function isErrorMessage(data: unknown): data is ErrorMessage {
  return (
    isProtocolMessage(data) &&
    data.type === 'error' &&
    typeof (data as ErrorMessage).code === 'string' &&
    typeof (data as ErrorMessage).message === 'string'
  );
}

export function isCustomMessage(data: unknown): data is CustomMessage {
  return (
    isProtocolMessage(data) &&
    data.type === 'custom' &&
    typeof (data as CustomMessage).channel === 'string'
  );
}

// --- Message builders ---

export function createReadyMessage(): ReadyMessage {
  return { ns: PROTOCOL_NS, type: 'ready' };
}

export function createAuthMessage(token: string): AuthMessage {
  return { ns: PROTOCOL_NS, type: 'auth', token };
}

export function createRefreshRequestMessage(nonce: string): RefreshRequestMessage {
  return { ns: PROTOCOL_NS, type: 'refresh-request', nonce };
}

export function createRefreshResponseMessage(nonce: string, token: string): RefreshResponseMessage {
  return { ns: PROTOCOL_NS, type: 'refresh-response', nonce, token };
}

export function createErrorMessage(code: string, message: string, nonce?: string): ErrorMessage {
  return { ns: PROTOCOL_NS, type: 'error', code, message, ...(nonce ? { nonce } : {}) };
}

export function createCustomMessage(channel: string, data?: unknown): CustomMessage {
  return { ns: PROTOCOL_NS, type: 'custom', channel, data };
}
