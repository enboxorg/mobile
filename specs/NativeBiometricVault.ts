import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  isBiometricAvailable(): Promise<{
    available: boolean;
    enrolled: boolean;
    type: 'faceID' | 'touchID' | 'fingerprint' | 'face' | 'none';
    reason?: string;
  }>;
  generateAndStoreSecret(
    keyAlias: string,
    options: {
      requireBiometrics: boolean;
      invalidateOnEnrollmentChange?: boolean;
      /**
       * Optional caller-provided 32-byte wallet secret, lower-case hex
       * (length 64). When supplied, the native module MUST store these
       * exact bytes under `keyAlias` and MUST NOT generate new entropy.
       * When omitted, the native module generates fresh 32 random bytes
       * itself (legacy behaviour). Callers pass this so the JS layer
       * can derive the HD seed / mnemonic from the same bytes without
       * a follow-up biometric read of the stored secret.
       */
      secretHex?: string;
    },
  ): Promise<void>;
  getSecret(
    keyAlias: string,
    prompt: {
      promptTitle: string;
      promptMessage: string;
      promptCancel: string;
      promptSubtitle?: string;
    },
  ): Promise<string>;
  hasSecret(keyAlias: string): Promise<boolean>;
  deleteSecret(keyAlias: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeBiometricVault');
