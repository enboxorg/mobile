/**
 * Type-level contract for the @enbox/agent vault-injection patch.
 *
 * This file is NOT a runtime entry point — it exists purely so that
 * `tsc --noEmit` (via `bun run typecheck`) validates that:
 *
 *   1. An object satisfying the exported `IdentityVault` interface is
 *      assignable to `EnboxUserAgent.create({ agentVault })`.
 *   2. A structurally-incompatible object is REJECTED by the compiler
 *      (guarded by `@ts-expect-error` — if the compiler ever stops
 *      complaining, the fixture itself will fail typecheck).
 *
 * Both checks together prove the patch widened the signature to the
 * `IdentityVault` interface without collapsing it to `any`.
 */

import type { EnboxUserAgent, IdentityVault } from '@enbox/agent';

// Extract the parameter type from the patched `create` signature so this
// check exercises the actual public API surface.
type CreateParams = NonNullable<Parameters<typeof EnboxUserAgent.create>[0]>;

// ---------- Positive: IdentityVault is assignable ----------

declare const identityVault: IdentityVault;

// Must compile cleanly — the patch's whole point.
const okParams: CreateParams = { agentVault: identityVault };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _positive: CreateParams = okParams;

// ---------- Negative: structurally incompatible vault is rejected ----------

// A plain object missing every vault method. Passing it to `agentVault` must
// fail structural assignability. If the compiler ever accepts it, the
// `@ts-expect-error` below becomes "unused" and typecheck fails instead.
const incompatibleVault = { foo: 1 } as const;

// @ts-expect-error — `{ foo: 1 }` is not assignable to `IdentityVault`.
const badParams: CreateParams = { agentVault: incompatibleVault };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _negative: CreateParams = badParams;
