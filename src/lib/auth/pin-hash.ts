import NativeCrypto from '@specs/NativeCrypto';

const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;
const SEPARATOR = ':';

/**
 * Hash a PIN with a random salt using PBKDF2-SHA256 via the native crypto module.
 * Returns a string in the format `salt:derivedKey` for storage.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = await NativeCrypto.randomBytes(SALT_BYTES);
  const key = await NativeCrypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH);
  return `${salt}${SEPARATOR}${key}`;
}

/**
 * Verify a PIN against a stored `salt:derivedKey` string using PBKDF2-SHA256.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const separatorIndex = stored.indexOf(SEPARATOR);
  if (separatorIndex === -1) return false;

  const salt = stored.slice(0, separatorIndex);
  const expectedKey = stored.slice(separatorIndex + 1);
  const actualKey = await NativeCrypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH);

  // Constant-time comparison — bitwise ops are intentional
  if (actualKey.length !== expectedKey.length) return false;
  let diff = 0;
  for (let i = 0; i < actualKey.length; i++) {
    diff |= actualKey.charCodeAt(i) ^ expectedKey.charCodeAt(i); // eslint-disable-line no-bitwise
  }
  return diff === 0;
}
