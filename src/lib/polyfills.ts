/**
 * Polyfills required by the @enbox/* SDK.
 * This file MUST be imported before any @enbox/* imports.
 */

// crypto.subtle + crypto.getRandomValues
import { install as installCrypto } from 'react-native-quick-crypto';
installCrypto();

// ReadableStream / WritableStream / TransformStream
import 'web-streams-polyfill/polyfill';

// Blob — React Native has a built-in Blob implementation since 0.54,
// but it may be incomplete for the SDK. We check and patch if needed.
if (typeof globalThis.Blob === 'undefined') {
  // This shouldn't happen on RN 0.85, but guard anyway.
  console.warn('[polyfills] Blob is not available — some SDK features may not work');
}
