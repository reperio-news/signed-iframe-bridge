import { describe, it, expect } from 'vitest';
import {
  isReadyMessage,
  isAuthMessage,
  isRefreshRequestMessage,
  isRefreshResponseMessage,
  isErrorMessage,
  isCustomMessage,
  createReadyMessage,
  createAuthMessage,
  createRefreshRequestMessage,
  createRefreshResponseMessage,
  createErrorMessage,
  createCustomMessage,
  PROTOCOL_NS,
} from '../src/protocol.js';

describe('protocol', () => {
  describe('message builders', () => {
    it('should create a ready message', () => {
      const msg = createReadyMessage();
      expect(msg).toEqual({ ns: PROTOCOL_NS, type: 'ready' });
    });

    it('should create an auth message', () => {
      const msg = createAuthMessage('jwt-token');
      expect(msg).toEqual({ ns: PROTOCOL_NS, type: 'auth', token: 'jwt-token' });
    });

    it('should create a refresh request message', () => {
      const msg = createRefreshRequestMessage('nonce-1');
      expect(msg).toEqual({ ns: PROTOCOL_NS, type: 'refresh-request', nonce: 'nonce-1' });
    });

    it('should create a refresh response message', () => {
      const msg = createRefreshResponseMessage('nonce-1', 'new-token');
      expect(msg).toEqual({
        ns: PROTOCOL_NS,
        type: 'refresh-response',
        nonce: 'nonce-1',
        token: 'new-token',
      });
    });

    it('should create an error message', () => {
      const msg = createErrorMessage('ERR', 'something failed', 'nonce-1');
      expect(msg).toEqual({
        ns: PROTOCOL_NS,
        type: 'error',
        code: 'ERR',
        message: 'something failed',
        nonce: 'nonce-1',
      });
    });

    it('should create a custom message with data', () => {
      const msg = createCustomMessage('my-channel', { foo: 'bar' });
      expect(msg).toEqual({
        ns: PROTOCOL_NS,
        type: 'custom',
        channel: 'my-channel',
        data: { foo: 'bar' },
      });
    });

    it('should create a custom message without data', () => {
      const msg = createCustomMessage('ping');
      expect(msg).toEqual({
        ns: PROTOCOL_NS,
        type: 'custom',
        channel: 'ping',
        data: undefined,
      });
    });
  });

  describe('type guards', () => {
    it('should identify ready messages', () => {
      expect(isReadyMessage(createReadyMessage())).toBe(true);
      expect(isReadyMessage({ ns: PROTOCOL_NS, type: 'auth' })).toBe(false);
      expect(isReadyMessage(null)).toBe(false);
      expect(isReadyMessage('string')).toBe(false);
    });

    it('should identify auth messages', () => {
      expect(isAuthMessage(createAuthMessage('token'))).toBe(true);
      expect(isAuthMessage({ ns: PROTOCOL_NS, type: 'auth' })).toBe(false); // no token
      expect(isAuthMessage(createReadyMessage())).toBe(false);
    });

    it('should identify refresh request messages', () => {
      expect(isRefreshRequestMessage(createRefreshRequestMessage('n'))).toBe(true);
      expect(isRefreshRequestMessage({ ns: PROTOCOL_NS, type: 'refresh-request' })).toBe(false);
    });

    it('should identify refresh response messages', () => {
      expect(isRefreshResponseMessage(createRefreshResponseMessage('n', 't'))).toBe(true);
      expect(isRefreshResponseMessage({ ns: PROTOCOL_NS, type: 'refresh-response' })).toBe(false);
    });

    it('should identify error messages', () => {
      expect(isErrorMessage(createErrorMessage('ERR', 'fail'))).toBe(true);
      expect(isErrorMessage({ ns: PROTOCOL_NS, type: 'error' })).toBe(false);
    });

    it('should identify custom messages', () => {
      expect(isCustomMessage(createCustomMessage('ch', 'data'))).toBe(true);
      expect(isCustomMessage(createCustomMessage('ch'))).toBe(true);
      expect(isCustomMessage({ ns: PROTOCOL_NS, type: 'custom' })).toBe(false); // no channel
    });

    it('should reject messages with wrong namespace', () => {
      expect(isReadyMessage({ ns: 'wrong', type: 'ready' })).toBe(false);
    });
  });
});
