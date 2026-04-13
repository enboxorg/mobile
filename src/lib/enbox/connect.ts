/**
 * Mobile connect flow using the WalletConnect relay.
 *
 * This replaces @enbox/browser's popup+postMessage flow with a
 * relay-mediated QR code / deep link flow that works natively.
 *
 * Flow:
 * 1. App pushes an authorization request to the relay server
 * 2. Relay returns a URI (enbox://connect?request_uri=...&encryption_key=...)
 * 3. App renders the URI as a QR code for cross-device, or opens it as a
 *    deep link for same-device wallet
 * 4. Wallet fetches the request, shows consent UI, posts encrypted response
 * 5. App polls the relay for the response
 * 6. User confirms with a PIN (used as AAD for decryption)
 * 7. Session is established
 */

import { AuthManager } from '@enbox/auth';
import type { ConnectPermissionRequest } from '@enbox/agent';

export interface MobileConnectOptions {
  /** The auth manager instance (from initializeAgent). */
  authManager: AuthManager;

  /** Human-readable name shown in the wallet consent UI. */
  displayName: string;

  /** Relay server URL. */
  connectServerUrl: string;

  /** Permission requests for the protocols the app needs access to. */
  permissionRequests: ConnectPermissionRequest[];

  /**
   * Called when the wallet URI is ready. The URI can be:
   * - Rendered as a QR code for cross-device scanning
   * - Opened via Linking.openURL() for same-device wallet
   *
   * Returns a cleanup function that will be called when connect completes or is cancelled.
   */
  onWalletUriReady: (uri: string) => void | (() => void);

  /**
   * Called when the wallet has responded and a PIN is needed.
   * Must return the PIN string entered by the user.
   * Return undefined to cancel the connect flow.
   */
  validatePin: () => Promise<string | undefined>;
}

export async function mobileConnect(options: MobileConnectOptions) {
  const {
    authManager,
    displayName,
    connectServerUrl,
    permissionRequests,
    onWalletUriReady,
    validatePin,
  } = options;

  // Use the built-in WalletConnect relay flow from @enbox/auth.
  // This requires only fetch() (polling) — no DOM, no popups, no postMessage.
  const session = await authManager.walletConnect({
    displayName,
    connectServerUrl,
    permissionRequests,
    onWalletUriReady: (uri: string) => {
      onWalletUriReady(uri);
    },
    validatePin: async () => {
      const pin = await validatePin();
      if (!pin) {
        throw new Error('Connect cancelled by user');
      }
      return pin;
    },
  });

  return session;
}
