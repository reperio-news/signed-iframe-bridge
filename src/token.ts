import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import type { KeyLike, JWTVerifyOptions } from 'jose';
import type { SignedIframeBridgePayload, SupportedAlgorithm } from './types.js';

/** Create a signed JWT with the given payload and TTL. */
export async function createToken(
  privateKey: CryptoKey | KeyLike,
  algorithm: SupportedAlgorithm,
  payload: SignedIframeBridgePayload,
  ttl: number,
  options?: { issuer?: string; audience?: string },
): Promise<string> {
  let builder = new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`);

  if (options?.issuer) builder = builder.setIssuer(options.issuer);
  if (options?.audience) builder = builder.setAudience(options.audience);

  return builder.sign(privateKey);
}

/** Verify a JWT and return the typed payload. */
export async function verifyToken(
  token: string,
  publicKey: CryptoKey | KeyLike,
  algorithm: SupportedAlgorithm,
  options?: { issuer?: string; audience?: string },
): Promise<SignedIframeBridgePayload> {
  const verifyOptions: JWTVerifyOptions = {
    algorithms: [algorithm],
  };
  if (options?.issuer) verifyOptions.issuer = options.issuer;
  if (options?.audience) verifyOptions.audience = options.audience;

  const { payload } = await jwtVerify(token, publicKey, verifyOptions);
  return payload as unknown as SignedIframeBridgePayload;
}

/** Decode a JWT without verification (for quick local inspection). */
export function decodeToken(token: string): SignedIframeBridgePayload {
  return decodeJwt(token) as unknown as SignedIframeBridgePayload;
}

/**
 * Check if a token's exp claim has passed (or will pass within the grace period).
 * @param token - The JWT string to check.
 * @param gracePeriodMs - Consider the token expired this many ms before actual expiry. Default: 2000.
 */
export function isTokenExpired(token: string, gracePeriodMs = 2_000): boolean {
  try {
    const payload = decodeJwt(token);
    if (!payload.exp) return true;
    return payload.exp * 1000 - gracePeriodMs <= Date.now();
  } catch {
    return true;
  }
}
