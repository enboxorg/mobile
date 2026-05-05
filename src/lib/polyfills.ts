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

// AbortSignal.timeout — WHATWG 2022 static factory missing in RN/Hermes.
// @enbox/dids' pkarrPut calls `AbortSignal.timeout(30_000)` at runtime;
// without this shim the call throws "TypeError: undefined is not a function"
// and surfaces as `internalError: Failed to put Pkarr record for identifier
// <zbase32>: undefined is not a function` on device. Node >= 18 (Jest) has
// this natively, so Jest passes without the shim; the RN release build is
// the only failure surface.
//
// Idempotent via the `typeof` guard so module reloads in dev/HMR do not
// replace the shim every time, preserving referential identity.
if (
  typeof AbortSignal !== 'undefined' &&
  typeof (AbortSignal as any).timeout !== 'function'
) {
  (AbortSignal as any).timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => {
      try {
        controller.abort(new DOMException('TimeoutError', 'TimeoutError'));
      } catch {
        controller.abort();
      }
    }, ms);
    return controller.signal;
  };
}

// crypto.subtle + crypto.getRandomValues
import { install as installCrypto } from 'react-native-quick-crypto';
installCrypto();

const ENABLE_CRYPTO_DIAGNOSTICS =
  process.env.ENBOX_DEBUG_CRYPTO === '1';

function wrapSubtleMethod<T extends keyof SubtleCrypto>(name: T) {
  const subtle = globalThis.crypto?.subtle as any;
  if (!subtle || typeof subtle[name] !== 'function') return;

  const original = subtle[name].bind(subtle);
  subtle[name] = async (...args: any[]) => {
    try {
      if (name === 'generateKey') {
        console.log('[subtle.generateKey]', JSON.stringify(args[0]), args[2]);
      } else if (name === 'importKey') {
        console.log('[subtle.importKey]', args[0], JSON.stringify(args[2]), args[4]);
      } else if (name === 'encrypt' || name === 'decrypt') {
        console.log(`[subtle.${String(name)}]`, JSON.stringify(args[0]), args[1]?.algorithm?.name, args[1]?.usages);
      } else if (name === 'wrapKey' || name === 'unwrapKey') {
        console.log(
          `[subtle.${String(name)}]`,
          args[0],
          typeof args[3] === 'string' ? args[3] : JSON.stringify(args[3]),
          args[2]?.algorithm?.name,
          args[2]?.usages,
        );
      }

      return await original(...args);
    } catch (err: any) {
      console.error(`[subtle.${String(name)}] failed:`, err?.message ?? err);
      if (name === 'encrypt' || name === 'decrypt') {
        console.error(`[subtle.${String(name)}] key details:`, args[1]?.algorithm?.name, args[1]?.usages);
      } else if (name === 'wrapKey' || name === 'unwrapKey') {
        console.error(`[subtle.${String(name)}] wrapping key details:`, args[2]?.algorithm?.name, args[2]?.usages);
      }
      throw err;
    }
  };
}

if (ENABLE_CRYPTO_DIAGNOSTICS) {
  wrapSubtleMethod('generateKey');
  wrapSubtleMethod('importKey');
  wrapSubtleMethod('encrypt');
  wrapSubtleMethod('decrypt');
  wrapSubtleMethod('wrapKey');
  wrapSubtleMethod('unwrapKey');
}

// ReadableStream / WritableStream / TransformStream
import 'web-streams-polyfill/polyfill';

if (ENABLE_CRYPTO_DIAGNOSTICS) {
  console.log('[polyfills] crypto.subtle:', typeof globalThis.crypto?.subtle);
  console.log('[polyfills] crypto.getRandomValues:', typeof globalThis.crypto?.getRandomValues);
  console.log('[polyfills] ReadableStream:', typeof globalThis.ReadableStream);
  console.log('[polyfills] TextEncoder:', typeof globalThis.TextEncoder);
  console.log('[polyfills] TextDecoder:', typeof globalThis.TextDecoder);
  console.log('[polyfills] Blob:', typeof globalThis.Blob);
  console.log('[polyfills] AbortSignal.timeout:', typeof (AbortSignal as any).timeout);
}
