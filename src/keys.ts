import { generateKeyPair as joseGenerateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import type { SupportedAlgorithm } from './types.js';

export interface KeyPair {
  publicKey: CryptoKey | KeyLike;
  privateKey: CryptoKey | KeyLike;
}

/** Generate an asymmetric key pair for the given algorithm. */
export async function generateKeyPair(algorithm: SupportedAlgorithm = 'ES256'): Promise<KeyPair> {
  const { publicKey, privateKey } = await joseGenerateKeyPair(algorithm);
  return { publicKey, privateKey };
}
