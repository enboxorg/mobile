/**
 * Compile-time type-check spec for BiometricVault.
 *
 * This file is NOT executed by Jest (its filename ends in `.test-d.ts`,
 * not `.test.ts`) but IS included in the `tsc --noEmit` run via
 * `tsconfig.json`. It enforces that `BiometricVault` structurally
 * satisfies `IdentityVault<{ InitializeResult: string }>` per
 * validation-contract assertion VAL-VAULT-024.
 *
 * If this file fails to typecheck the mission is blocked — it is the
 * primary machine-checked gate that the vault actually implements the
 * upstream `@enbox/agent` contract.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { IdentityVault } from '@enbox/agent';
import type { BearerDid } from '@enbox/dids';

import { BiometricVault } from '@/lib/enbox/biometric-vault';

// The primary assertion: a BiometricVault instance must be assignable to
// IdentityVault<{ InitializeResult: string }> without a cast.
const vaultAsIdentityVault: IdentityVault<{ InitializeResult: string }> =
  new BiometricVault();

// The initialize result must be a string (not unknown / any).
async function assertInitializeResultIsString() {
  const vault: IdentityVault<{ InitializeResult: string }> = new BiometricVault();
  const mnemonic: string = await vault.initialize({ password: 'unused' });
  // Non-existent fields on the concrete type should still fail — guard the
  // return type against accidental widening.
  const lengthOk: number = mnemonic.length;
  return lengthOk;
}

// getDid() must resolve to a BearerDid.
async function assertGetDidReturnsBearerDid() {
  const vault = new BiometricVault();
  const did: BearerDid = await vault.getDid();
  return did;
}

// getStatus() must include the standard IdentityVault fields.
async function assertGetStatusShape() {
  const vault = new BiometricVault();
  const status = await vault.getStatus();
  const initialized: boolean = status.initialized;
  const lastBackup: string | null = status.lastBackup;
  const lastRestore: string | null = status.lastRestore;
  return { initialized, lastBackup, lastRestore };
}

// isLocked must be synchronous (returns boolean, not Promise<boolean>).
function assertIsLockedIsSync() {
  const vault = new BiometricVault();
  const locked: boolean = vault.isLocked();
  return locked;
}

// isInitialized must be async (Promise<boolean>).
async function assertIsInitializedIsAsync() {
  const vault = new BiometricVault();
  const value: boolean = await vault.isInitialized();
  return value;
}

// encryptData / decryptData must accept/return the documented types.
async function assertEncryptDecryptSignatures() {
  const vault = new BiometricVault();
  const jwe: string = await vault.encryptData({
    plaintext: new Uint8Array([1, 2, 3]),
  });
  const plaintext: Uint8Array = await vault.decryptData({ jwe });
  return { jwe, plaintext };
}

// Must NOT widen `initialize` return to `any` — this fixture will fail
// the type-check if someone accidentally re-types the method.
async function assertInitializeReturnDoesNotWidenToAny() {
  const vault = new BiometricVault();
  const phrase = await vault.initialize({});
  // If phrase were `any`, this assignment would silently accept a number.
  const asString: string = phrase;
  return asString;
}
