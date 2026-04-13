import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  sha256(data: string): Promise<string>;
  pbkdf2(password: string, salt: string, iterations: number, keyLength: number): Promise<string>;
  randomBytes(length: number): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeCrypto');
