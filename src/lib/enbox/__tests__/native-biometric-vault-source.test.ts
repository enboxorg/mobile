import { readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../../');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('native biometric vault platform source guards', () => {
  it('does not import the unavailable React_RCTLinking Swift module', () => {
    const appDelegate = readRepoFile('ios/EnboxMobile/AppDelegate.swift');
    const bridgingHeader = readRepoFile(
      'ios/EnboxMobile/EnboxMobile-Bridging-Header.h',
    );
    const project = readRepoFile('ios/EnboxMobile.xcodeproj/project.pbxproj');

    expect(appDelegate).not.toContain('import React_RCTLinking');
    expect(appDelegate).toContain('RCTLinkingManager.application');
    expect(bridgingHeader).toContain('#import <React/RCTLinkingManager.h>');
    expect(project).toContain('SWIFT_OBJC_BRIDGING_HEADER');
  });

  it('holds the iOS alias operation guard across async LAContext provisioning', () => {
    const source = readRepoFile(
      'ios/EnboxMobile/NativeBiometricVault/RCTNativeBiometricVault.mm',
    );

    expect(source).toContain('kErrOperationInProgress');
    expect(source).toContain('NSMutableSet<NSString *> *_activeAliases');
    expect(source).toContain('beginAliasOperation:keyAlias');
    expect(source).toContain(
      'evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics',
    );
    expect(source).toContain('finishGenerateAndStoreSecret:keyAlias');
    expect(source).toContain('endAliasOperation:keyAlias');
    expect(source).toContain('code = [self codeForLAError:evalError.code]');
    expect(source).not.toContain(
      'evalError.code == LAErrorBiometryNotAvailable ||\n' +
        '                       evalError.code == LAErrorBiometryNotEnrolled',
    );
  });

  it('makes Android getSecret participate in the same alias lock as generate/delete', () => {
    const source = readRepoFile(
      'android/app/src/main/java/org/enbox/mobile/nativemodules/NativeBiometricVaultModule.kt',
    );
    const getSecretStart = source.indexOf('override fun getSecret');
    const hasSecretStart = source.indexOf('override fun hasSecret');
    const getSecretBody = source.slice(getSecretStart, hasSecretStart);

    expect(getSecretBody).toContain('tryAcquireAliasLock(keyAlias)');
    expect(getSecretBody).toContain('ERR_OPERATION_IN_PROGRESS');
    expect(getSecretBody).toContain('releaseAliasLockOnce');
    expect(getSecretBody).toContain('BiometricPrompt.CryptoObject(cipher)');
  });
});
