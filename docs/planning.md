# Planning and Portability Assessment

## Current `web-wallet` Functionality

The existing web wallet is a real product surface:

- Wallet setup, unlock, lock, and recovery phrase restore
- Identity list, create, edit, delete, import, and export
- Profile and media management
- DWN endpoint management and registration
- Protocol install / visibility and permission revoke flows
- DID search and public profile lookup
- QR-based App Connect flow
- Popup / `postMessage` based DWeb Connect flow
- Backup, export, recovery phrase display, and auto-lock settings

## Portability Assessment

### Reusable With Light To Moderate Changes

- Product scope and screen map
- Auth and identity lifecycle concepts
- Enbox query / mutation / protocol logic (if the SDK runs in React Native)
- State-management patterns: TanStack Query + Zustand
- TypeScript domain utilities and validation logic

### Needs A Real Native Rewrite

- Storage and session persistence (web uses `localStorage` / `sessionStorage`)
- Camera and QR scanning (web uses `qr-scanner`)
- File import / export (web uses `Blob`, object URLs, anchor downloads)
- DWeb Connect windowing model (web uses popups and `postMessage`)
- PWA / offline shell (web uses service workers and Workbox)

### Biggest Technical Unknown

Whether the `@enbox/*` SDK stack runs in React Native without major surgery:

- Do `@enbox/auth`, `@enbox/agent`, `@enbox/api`, `@enbox/dwn-clients`, and `@enbox/crypto` work outside the browser?
- Do they rely on IndexedDB, Web Crypto, browser `Blob` behavior, service workers, or DOM globals?
- Can sync, crypto, storage, and WebSocket behavior be backed by mobile-safe adapters?

## Web Feature To Mobile Mapping

| Web capability | Mobile approach |
|---|---|
| PIN setup / unlock | PIN + Keychain / Keystore + optional biometrics |
| Session restore | Secure token in Keychain, not `sessionStorage` |
| Identity import / export | Files app / SAF / share sheet / document picker |
| QR connect | Native camera scanner |
| DWeb Connect popup | Deep links, universal links, or app-to-app bridge |
| Share DID / profile URL | Native share sheet |
| Auto-lock | App lifecycle + inactivity timer |
| Offline shell | Local persistence and sync coordination |

## Native-Only Features Worth Adding

- Biometric unlock after initial PIN setup
- Hardware-backed wrapping of sensitive material
- NFC tag read / write flows
- Native share targets and import from other apps
- Push notifications for connection or sync events
- Background sync retry when connectivity returns

## Delivery Plan

### Phase 0: Portability Spike (1-2 weeks)

1. Prove the Enbox SDK can initialize in a mobile runtime.
2. Identify required polyfills or adapters.
3. Decide whether React Native is viable without a deeper SDK rewrite.

### Phase 1: Foundation (2-4 weeks after spike)

1. Flesh out secure storage, session restore, and real auth state.
2. Add deep linking, camera/QR plumbing, and native capability modules.
3. Replace scaffold screens with real feature implementations.

### Phase 2: Parity MVP (6-10 weeks after foundation)

1. Port identity create / edit / import / export.
2. Port profile, search, permissions, protocols, backup, and settings.
3. Replace web-specific connect flows with mobile-native equivalents.

### Phase 3: Native Enhancements (3-6 weeks)

1. NFC
2. Biometric quick unlock
3. Push / background sync
4. Hardware-backed key protection improvements

## Main Risks

- The Enbox SDK may be more browser-coupled than the web app surface suggests.
- DWeb Connect cannot be ported 1:1; it needs a new mobile interaction model.
- Secure storage decisions affect migration, backup, and recovery design.
- Background sync and offline expectations differ sharply between browsers and mobile OSes.
