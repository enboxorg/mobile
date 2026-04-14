/**
 * Polyfills required by the @enbox/* SDK.
 * This file MUST be imported before any @enbox/* imports.
 */

// crypto.subtle + crypto.getRandomValues
import { install as installCrypto } from 'react-native-quick-crypto';
installCrypto();

// ReadableStream / WritableStream / TransformStream
import 'web-streams-polyfill/polyfill';

// Diagnostic: log what's available after polyfills
console.log('[polyfills] crypto.subtle:', typeof globalThis.crypto?.subtle);
console.log('[polyfills] crypto.getRandomValues:', typeof globalThis.crypto?.getRandomValues);
console.log('[polyfills] ReadableStream:', typeof globalThis.ReadableStream);
console.log('[polyfills] WritableStream:', typeof globalThis.WritableStream);
console.log('[polyfills] TextEncoder:', typeof globalThis.TextEncoder);
console.log('[polyfills] TextDecoder:', typeof globalThis.TextDecoder);
console.log('[polyfills] Blob:', typeof globalThis.Blob);
console.log('[polyfills] fetch:', typeof globalThis.fetch);
console.log('[polyfills] WebSocket:', typeof globalThis.WebSocket);
