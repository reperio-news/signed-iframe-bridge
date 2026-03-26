import { describe, it, expect } from 'vitest';
import { generateKeyPair as joseGenerateKeyPair } from 'jose';
import { createToken, verifyToken, decodeToken, isTokenExpired } from '../src/token.js';
import type { SignedIframeBridgePayload } from '../src/types.js';

const payload: SignedIframeBridgePayload = {
  uid: 'user-123',
  user: { name: 'Alice', email: 'alice@example.com' },
  permissions: ['read', 'write'],
};

describe('token', () => {
  describe('ES256', () => {
    it('should create and verify a token', async () => {
      const { publicKey, privateKey } = await joseGenerateKeyPair('ES256');
      const token = await createToken(privateKey, 'ES256', payload, 3600);
      const decoded = await verifyToken(token, publicKey, 'ES256');

      expect(decoded.uid).toBe('user-123');
      expect(decoded.user).toEqual({ name: 'Alice', email: 'alice@example.com' });
      expect(decoded.permissions).toEqual(['read', 'write']);
      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
    });

    it('should reject a token signed with a different key', async () => {
      const { privateKey } = await joseGenerateKeyPair('ES256');
      const { publicKey: otherPublicKey } = await joseGenerateKeyPair('ES256');
      const token = await createToken(privateKey, 'ES256', payload, 3600);

      await expect(verifyToken(token, otherPublicKey, 'ES256')).rejects.toThrow();
    });

    it('should support issuer and audience claims', async () => {
      const { publicKey, privateKey } = await joseGenerateKeyPair('ES256');
      const token = await createToken(privateKey, 'ES256', payload, 3600, {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });

      const decoded = await verifyToken(token, publicKey, 'ES256', {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });
      expect(decoded.uid).toBe('user-123');

      // Wrong issuer should fail
      await expect(
        verifyToken(token, publicKey, 'ES256', { issuer: 'wrong-issuer' }),
      ).rejects.toThrow();
    });
  });

  describe('RS256', () => {
    it('should create and verify a token', async () => {
      const { publicKey, privateKey } = await joseGenerateKeyPair('RS256');
      const token = await createToken(privateKey, 'RS256', payload, 3600);
      const decoded = await verifyToken(token, publicKey, 'RS256');

      expect(decoded.uid).toBe('user-123');
    });
  });

  describe('decodeToken', () => {
    it('should decode without verification', async () => {
      const { privateKey } = await joseGenerateKeyPair('ES256');
      const token = await createToken(privateKey, 'ES256', payload, 3600);
      const decoded = decodeToken(token);

      expect(decoded.uid).toBe('user-123');
      expect(decoded.permissions).toEqual(['read', 'write']);
    });
  });

  describe('isTokenExpired', () => {
    it('should return false for a valid token', async () => {
      const { privateKey } = await joseGenerateKeyPair('ES256');
      const token = await createToken(privateKey, 'ES256', payload, 3600);

      expect(isTokenExpired(token)).toBe(false);
    });

    it('should return true for an expired token', async () => {
      const { privateKey } = await joseGenerateKeyPair('ES256');
      // TTL of 0 seconds = already expired
      const token = await createToken(privateKey, 'ES256', payload, 0);

      expect(isTokenExpired(token)).toBe(true);
    });

    it('should return true for invalid input', () => {
      expect(isTokenExpired('not-a-token')).toBe(true);
    });
  });
});
