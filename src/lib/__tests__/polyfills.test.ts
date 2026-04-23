/**
 * polyfills — AbortSignal.timeout shim
 *
 * `src/lib/polyfills.ts` ships a minimal WHATWG `AbortSignal.timeout` shim
 * because React Native's Hermes runtime (0.85) lacks the static factory
 * (WHATWG 2022 addition). Jest runs on Node >= 18 which has the factory
 * natively, so the shim's `typeof` guard means our shim does NOT run in
 * the Jest runtime by default. To exercise both paths we also simulate
 * the Hermes state (`AbortSignal.timeout = undefined`) before reloading
 * the module via `jest.isolateModules`.
 *
 * Test-environment hygiene notes:
 *
 * 1. `react-native-quick-crypto`'s `install()` needs Nitro bindings that
 *    don't exist under Jest/Node. We stub it to a no-op — Node already
 *    supplies `crypto.subtle` and `crypto.getRandomValues` globally.
 * 2. `web-streams-polyfill/polyfill` installs globals Node 18+ already
 *    has; stubbing avoids duplicate installs across isolateModules.
 * 3. `polyfills.ts` runs `wrapSubtleMethod(...)` which mutates
 *    `globalThis.crypto.subtle` by wrapping each method. On Node this
 *    leaks an open handle during the rest of the Jest run (the wrapped
 *    async functions leave promise chains around), which surfaces as a
 *    non-zero exit code despite all tests passing. We hide `crypto.subtle`
 *    from polyfills.ts while loading it and restore it afterwards — the
 *    wrappers are irrelevant to the `AbortSignal.timeout` behavior we're
 *    actually testing.
 */

jest.mock('react-native-quick-crypto', () => ({
  install: () => {
    /* no-op: Node provides WebCrypto natively in the Jest env */
  },
}));
jest.mock('web-streams-polyfill/polyfill', () => ({}), { virtual: true });

const realCrypto = (globalThis as any).crypto;
(globalThis as any).crypto = {
  // Preserve getRandomValues so polyfills.ts's final diagnostic log still
  // prints a valid `function` for it — but hide `subtle` so
  // wrapSubtleMethod() has nothing to mutate.
  getRandomValues: realCrypto?.getRandomValues?.bind(realCrypto),
};
require('../polyfills');
(globalThis as any).crypto = realCrypto;

describe('polyfills — AbortSignal.timeout', () => {
  it('exposes AbortSignal.timeout as a function after the polyfills module loads', () => {
    expect(typeof (AbortSignal as any).timeout).toBe('function');
  });

  it('AbortSignal.timeout(1) returns a signal whose aborted flag flips to true', async () => {
    const signal = (AbortSignal as any).timeout(1);
    expect(typeof signal.aborted).toBe('boolean');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(true);
  });

  it('installs a working shim when AbortSignal.timeout is missing (RN/Hermes case)', async () => {
    const originalTimeout = (AbortSignal as any).timeout;
    const cryptoBackup = (globalThis as any).crypto;
    try {
      // Simulate the Hermes environment: the static factory is undefined.
      (AbortSignal as any).timeout = undefined;
      // Re-hide subtle so the isolateModules reload does not re-wrap.
      (globalThis as any).crypto = {
        getRandomValues: realCrypto?.getRandomValues?.bind(realCrypto),
      };
      jest.isolateModules(() => {
        require('../polyfills');
      });
      // Our shim should have populated it.
      expect(typeof (AbortSignal as any).timeout).toBe('function');

      const signal = (AbortSignal as any).timeout(1);
      expect(typeof signal.aborted).toBe('boolean');
      expect(signal.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signal.aborted).toBe(true);
    } finally {
      (AbortSignal as any).timeout = originalTimeout;
      (globalThis as any).crypto = cryptoBackup;
    }
  });

  it('is idempotent: reloading polyfills preserves the existing function reference', () => {
    // AbortSignal.timeout is already installed by the top-level require above.
    const first = (AbortSignal as any).timeout;
    expect(typeof first).toBe('function');

    const cryptoBackup = (globalThis as any).crypto;
    try {
      (globalThis as any).crypto = {
        getRandomValues: realCrypto?.getRandomValues?.bind(realCrypto),
      };
      // Reload the polyfills module. The `typeof ... !== 'function'` guard
      // must prevent the shim from overwriting the existing function.
      jest.isolateModules(() => {
        require('../polyfills');
      });
    } finally {
      (globalThis as any).crypto = cryptoBackup;
    }
    const second = (AbortSignal as any).timeout;

    expect(second).toBe(first);
  });

  it('does not regress existing polyfills: TextDecoder/TextEncoder remain available after the module loads', () => {
    expect(typeof (globalThis as any).TextDecoder).toBe('function');
    expect(typeof (globalThis as any).TextEncoder).toBe('function');
  });
});
