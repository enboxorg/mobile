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
