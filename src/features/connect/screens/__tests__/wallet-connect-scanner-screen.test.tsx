/**
 * WalletConnectScannerScreen regression tests (VAL-UX-051).
 *
 * The biometric-first refactor must not change this surface: the scanner
 * still renders, requests camera permission on mount, and forwards
 * scanned URLs to `walletConnectStore.handleIncomingUrl`.
 *
 * History / context:
 * Before `fix-scanner-permission-flow` the screen probed camera
 * permission inside `setTimeout(50)` and read `cameraRef.current` before
 * the `<Camera>` element was ever rendered — which meant the ref was
 * always `null`, the probe early-returned, and `hasPermission` stayed
 * `null` forever, trapping the user on the "Requesting camera access…"
 * placeholder.
 *
 * This suite now exercises the real permission-grant → `<Camera>`
 * render transition end-to-end: the probe is driven by a mocked
 * `requestCameraPermission()` helper that does not depend on the
 * `<Camera>` component being mounted, and the Camera mock captures its
 * props so we can drive the `onReadCode` / `onError` callbacks
 * directly.
 */

 

// ---------------------------------------------------------------------------
// Mock react-native-camera-kit so the scanner component mounts in Jest
// without spinning up native camera bridges. The mock captures the props
// handed to <Camera> so tests can drive the onReadCode / onError
// callbacks directly.
// ---------------------------------------------------------------------------
jest.mock('react-native-camera-kit', () => {
  const React = require('react');
  const { View } = require('react-native');

  const Camera = React.forwardRef(function MockCamera(
    props: Record<string, unknown>,
    _ref: unknown,
  ) {
    (globalThis as Record<string, unknown>).__scannerCameraProps = props;
    return React.createElement(View, { testID: 'mock-camera-kit' });
  });

  return {
    __esModule: true,
    Camera,
    CameraType: { Back: 'back', Front: 'front' },
  };
});

// ---------------------------------------------------------------------------
// Mock the camera-permission helper. The factory wires in jest mock
// functions internally (Jest hoists `jest.mock` above top-level
// `const`s, so we cannot reference outer variables at factory
// evaluation time). Tests reach for the mocks via the module require
// handles below.
// ---------------------------------------------------------------------------
jest.mock('@/lib/native/camera-permission', () => ({
  __esModule: true,
  requestCameraPermission: jest.fn(async () => ({
    granted: true,
    blocked: false,
  })),
  openCameraPermissionSettings: jest.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Mock @react-navigation/native so `useNavigation()` works in isolation.
// ---------------------------------------------------------------------------
jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useNavigation: () => ({
    goBack: (globalThis as unknown as Record<string, jest.Mock>)
      .__scannerGoBack,
  }),
}));

// ---------------------------------------------------------------------------
// Mock the wallet-connect store so we can assert `handleIncomingUrl`
// dispatches.
// ---------------------------------------------------------------------------
jest.mock('@/lib/enbox/wallet-connect-store', () => {
  const { create } = require('zustand');
  const mockHandleIncomingUrl = jest.fn(async () => undefined);
  const useWalletConnectStore = create(() => ({
    handleIncomingUrl: mockHandleIncomingUrl,
  }));
  return {
    useWalletConnectStore,
    __mockHandleIncomingUrl: mockHandleIncomingUrl,
  };
});

import { Alert } from 'react-native';

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { WalletConnectScannerScreen } from '@/features/connect/screens/wallet-connect-scanner-screen';

const walletConnectStoreMock = require('@/lib/enbox/wallet-connect-store') as {
  useWalletConnectStore: { getState: () => { handleIncomingUrl: jest.Mock } };
  __mockHandleIncomingUrl: jest.Mock;
};

const cameraPermissionMock = require('@/lib/native/camera-permission') as {
  requestCameraPermission: jest.Mock;
  openCameraPermissionSettings: jest.Mock;
};

const mockGoBack = jest.fn();
(globalThis as unknown as Record<string, jest.Mock>).__scannerGoBack =
  mockGoBack;

function resetPermissionDefaults() {
  cameraPermissionMock.requestCameraPermission
    .mockReset()
    .mockResolvedValue({ granted: true, blocked: false });
  cameraPermissionMock.openCameraPermissionSettings
    .mockReset()
    .mockResolvedValue(undefined);
}

describe('WalletConnectScannerScreen — VAL-UX-051 regression', () => {
  beforeEach(() => {
    resetPermissionDefaults();
    walletConnectStoreMock.__mockHandleIncomingUrl.mockReset();
    walletConnectStoreMock.__mockHandleIncomingUrl.mockResolvedValue(undefined);
    mockGoBack.mockReset();
    (globalThis as Record<string, unknown>).__scannerCameraProps = undefined;
  });

  // --------------------------------------------------------------
  // Render + copy regression
  // --------------------------------------------------------------
  it('renders the "Requesting camera access" placeholder on first paint', async () => {
    // Use a deferred promise so we can observe the `probing` phase
    // before the permission helper resolves.
    let resolvePermission: (value: {
      granted: boolean;
      blocked: boolean;
    }) => void = () => undefined;
    cameraPermissionMock.requestCameraPermission.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const screen = render(<WalletConnectScannerScreen />);
    expect(screen.getByText(/Requesting camera access/i)).toBeTruthy();

    // Resolve so the effect cleanup in afterEach doesn't leave a
    // dangling promise in this test, and wait for the subsequent
    // re-render to settle before the suite unmounts the screen.
    await act(async () => {
      resolvePermission({ granted: false, blocked: false });
    });
  });

  it('does not render any PIN-era copy (regression guard)', async () => {
    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.queryByTestId('mock-camera-kit')).toBeTruthy(),
    );

    expect(screen.queryByText(/\bPIN\b/i)).toBeNull();
    expect(screen.queryByText(/passcode/i)).toBeNull();
    expect(screen.queryByText(/pin[- ]?code/i)).toBeNull();
  });

  // --------------------------------------------------------------
  // Core behavior: permission-grant → <Camera> render transition.
  // This is the behavior the prior implementation was unable to
  // exercise because the permission probe depended on the Camera
  // ref being attached.
  // --------------------------------------------------------------
  it('transitions from the loading placeholder to <Camera> once permission is granted', async () => {
    cameraPermissionMock.requestCameraPermission.mockResolvedValueOnce({
      granted: true,
      blocked: false,
    });

    const screen = render(<WalletConnectScannerScreen />);

    // Initially the screen is probing permission.
    expect(screen.queryByTestId('mock-camera-kit')).toBeNull();
    expect(screen.getByText(/Requesting camera access/i)).toBeTruthy();

    // Once the helper resolves we mount the Camera and hide the loader.
    await waitFor(() =>
      expect(screen.queryByTestId('mock-camera-kit')).toBeTruthy(),
    );
    expect(screen.queryByText(/Requesting camera access/i)).toBeNull();
    expect(
      cameraPermissionMock.requestCameraPermission,
    ).toHaveBeenCalledTimes(1);
  });

  it('wires the Camera element with scanBarcode + allowedBarcodeTypes=[qr] and an onReadCode handler', async () => {
    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.queryByTestId('mock-camera-kit')).toBeTruthy(),
    );

    const cameraProps = (globalThis as Record<string, unknown>)
      .__scannerCameraProps as Record<string, unknown>;
    expect(cameraProps).toBeTruthy();
    expect(cameraProps.scanBarcode).toBe(true);
    expect(cameraProps.allowedBarcodeTypes).toEqual(['qr']);
    expect(typeof cameraProps.onReadCode).toBe('function');
    expect(typeof cameraProps.onError).toBe('function');
  });

  // --------------------------------------------------------------
  // Denied-permission flow: user-friendly message + Open Settings.
  // --------------------------------------------------------------
  it('surfaces the camera-unavailable message when permission is denied', async () => {
    cameraPermissionMock.requestCameraPermission.mockResolvedValueOnce({
      granted: false,
      blocked: false,
    });

    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.getByText(/Camera unavailable/i)).toBeTruthy(),
    );
    expect(screen.queryByTestId('mock-camera-kit')).toBeNull();
    expect(
      screen.getByText(/Enable camera access to scan an Enbox connect QR code/i),
    ).toBeTruthy();
    // When the permission is not yet blocked we do NOT offer a Settings
    // deep link — re-entering the screen will simply re-prompt.
    expect(screen.queryByLabelText('Open Settings')).toBeNull();
  });

  it('shows an "Open Settings" deep link when permission is permanently blocked', async () => {
    cameraPermissionMock.requestCameraPermission.mockResolvedValueOnce({
      granted: false,
      blocked: true,
    });

    const screen = render(<WalletConnectScannerScreen />);

    const openSettings = await screen.findByLabelText('Open Settings');
    expect(openSettings).toBeTruthy();

    fireEvent.press(openSettings);
    await waitFor(() =>
      expect(
        cameraPermissionMock.openCameraPermissionSettings,
      ).toHaveBeenCalledTimes(1),
    );
  });

  it('falls back to the denial state and surfaces the error message if the probe rejects', async () => {
    cameraPermissionMock.requestCameraPermission.mockRejectedValueOnce(
      new Error('Permission probe crashed'),
    );

    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.getByText(/Camera unavailable/i)).toBeTruthy(),
    );
    expect(screen.getByText(/Permission probe crashed/i)).toBeTruthy();
    expect(screen.queryByTestId('mock-camera-kit')).toBeNull();
  });

  // --------------------------------------------------------------
  // Scan → handleIncomingUrl dispatch — exercised through the mocked
  // Camera's captured `onReadCode` prop now that it actually mounts.
  // --------------------------------------------------------------
  it('forwards scanned URLs to walletConnectStore.handleIncomingUrl and navigates back', async () => {
    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.queryByTestId('mock-camera-kit')).toBeTruthy(),
    );

    const cameraProps = (globalThis as Record<string, unknown>)
      .__scannerCameraProps as {
      onReadCode: (event: {
        nativeEvent: { codeStringValue: string };
      }) => Promise<void>;
    };

    await act(async () => {
      await cameraProps.onReadCode({
        nativeEvent: { codeStringValue: '  enbox://connect?x=1  ' },
      });
    });

    expect(
      walletConnectStoreMock.__mockHandleIncomingUrl,
    ).toHaveBeenCalledTimes(1);
    expect(
      walletConnectStoreMock.__mockHandleIncomingUrl,
    ).toHaveBeenCalledWith('enbox://connect?x=1');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('alerts the user and does not navigate back when handleIncomingUrl rejects', async () => {
    walletConnectStoreMock.__mockHandleIncomingUrl.mockRejectedValueOnce(
      new Error('bad QR'),
    );
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const screen = render(<WalletConnectScannerScreen />);

    await waitFor(() =>
      expect(screen.queryByTestId('mock-camera-kit')).toBeTruthy(),
    );

    const cameraProps = (globalThis as Record<string, unknown>)
      .__scannerCameraProps as {
      onReadCode: (event: {
        nativeEvent: { codeStringValue: string };
      }) => Promise<void>;
    };

    await act(async () => {
      await cameraProps.onReadCode({
        nativeEvent: { codeStringValue: 'not-a-valid-uri' },
      });
    });

    expect(
      walletConnectStoreMock.__mockHandleIncomingUrl,
    ).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toMatch(/Invalid QR code/);
    expect(mockGoBack).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  // --------------------------------------------------------------
  // Direct store sanity — kept from the previous regression suite
  // so a rename of `handleIncomingUrl` still fails fast.
  // --------------------------------------------------------------
  it('invokes the mocked handleIncomingUrl when called directly (sanity check for the wired store)', async () => {
    await walletConnectStoreMock.useWalletConnectStore
      .getState()
      .handleIncomingUrl('enbox://connect?x=1');

    expect(
      walletConnectStoreMock.__mockHandleIncomingUrl,
    ).toHaveBeenCalledTimes(1);
    expect(
      walletConnectStoreMock.__mockHandleIncomingUrl,
    ).toHaveBeenCalledWith('enbox://connect?x=1');
  });
});
