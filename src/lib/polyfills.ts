/**
 * Polyfills required by the @enbox/* SDK.
 * This file MUST be imported before any @enbox/* imports.
 */

// TextDecoder — RN 0.85 has TextEncoder but NOT TextDecoder.
// The @enbox/common package instantiates TextDecoder at module load time,
// so this must be polyfilled before any SDK import.
if (typeof globalThis.TextDecoder === 'undefined') {
  const { TextDecoder, TextEncoder } = require('text-encoding');
  globalThis.TextDecoder = TextDecoder;
  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = TextEncoder;
  }
}

// crypto.subtle + crypto.getRandomValues
import { install as installCrypto } from 'react-native-quick-crypto';
installCrypto();

// ReadableStream / WritableStream / TransformStream
import 'web-streams-polyfill/polyfill';

// Diagnostic: log what's available after polyfills
console.log('[polyfills] crypto.subtle:', typeof globalThis.crypto?.subtle);
console.log('[polyfills] crypto.getRandomValues:', typeof globalThis.crypto?.getRandomValues);
console.log('[polyfills] ReadableStream:', typeof globalThis.ReadableStream);
console.log('[polyfills] TextEncoder:', typeof globalThis.TextEncoder);
console.log('[polyfills] TextDecoder:', typeof globalThis.TextDecoder);
console.log('[polyfills] Blob:', typeof globalThis.Blob);
