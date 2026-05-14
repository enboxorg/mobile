import {
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

/**
 * Result of probing whether the host has granted camera access for QR
 * scanning. `blocked` is `true` when the user denied permission with
 * "Don't ask again" (Android) or when the OS reports the permission as
 * permanently unavailable (iOS denied / restricted) — at that point the
 * only recovery path is to deep-link into the system Settings app.
 */
export type CameraPermissionResult = {
  granted: boolean;
  blocked: boolean;
};

type CameraKitPermissionsModule = {
  checkDeviceCameraAuthorizationStatus?: () => Promise<boolean | number>;
  requestDeviceCameraAuthorization?: () => Promise<boolean>;
};

/**
 * Lazily resolve the react-native-camera-kit iOS bridge module from
 * `NativeModules`. The library registers the module under
 * `RNCameraKitModule` (new arch) and historically surfaced it as
 * `CameraKit` as well, so we accept either.
 *
 * Returns `undefined` when the module has not been linked (unit tests,
 * platforms we do not target) so the wrapper can degrade gracefully
 * rather than throwing.
 */
function resolveIosCameraKitModule(): CameraKitPermissionsModule | undefined {
  const modules = NativeModules as Record<string, unknown>;
  const candidate = modules.RNCameraKitModule ?? modules.CameraKit;
  if (candidate && typeof candidate === 'object') {
    return candidate as CameraKitPermissionsModule;
  }
  return undefined;
}

/**
 * Request camera access for QR scanning without relying on the
 * `<Camera>` component being mounted. On Android we use RN's built-in
 * `PermissionsAndroid` helper (the app's `AndroidManifest.xml` already
 * declares `android.permission.CAMERA`). On iOS we go through
 * react-native-camera-kit's static bridge module, which in turn wraps
 * `AVCaptureDevice.authorizationStatus(for: .video)` and
 * `AVCaptureDevice.requestAccess(for: .video, ...)`.
 *
 * The helper returns a deterministic `{ granted, blocked }` tuple so the
 * caller can distinguish "still prompt-able" from "go to Settings".
 *
 * On unsupported platforms (web / desktop / Jest with no bridge at all)
 * the helper resolves `{ granted: true }` so higher-level code does not
 * lock itself out of test runners.
 */
export async function requestCameraPermission(): Promise<CameraPermissionResult> {
  if (Platform.OS === 'android') {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: 'Camera access',
        message: 'Enbox uses your camera to scan Enbox Connect QR codes.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    return {
      granted: result === PermissionsAndroid.RESULTS.GRANTED,
      blocked: result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    };
  }

  if (Platform.OS === 'ios') {
    const mod = resolveIosCameraKitModule();
    if (!mod?.checkDeviceCameraAuthorizationStatus) {
      // No native bridge available. Treat this as a hard denial with a
      // Settings affordance so the UI surfaces guidance rather than
      // silently failing.
      return { granted: false, blocked: true };
    }

    // The camera-kit iOS module resolves `true` (authorized), `false`
    // (denied / restricted), or `-1` (AVAuthorizationStatus.notDetermined).
    const status = await mod.checkDeviceCameraAuthorizationStatus();
    if (status === true) {
      return { granted: true, blocked: false };
    }
    if (status === false) {
      return { granted: false, blocked: true };
    }

    if (!mod.requestDeviceCameraAuthorization) {
      return { granted: false, blocked: true };
    }

    const granted = await mod.requestDeviceCameraAuthorization();
    if (granted) {
      return { granted: true, blocked: false };
    }
    // The user tapped "Don't allow" on the system prompt; subsequent
    // calls will return `false` without re-prompting, so surface the
    // blocked state so the UI shows a Settings affordance.
    return { granted: false, blocked: true };
  }

  // Unsupported host (web / desktop / anywhere RN's Platform reports
  // neither `android` nor `ios`). Let the rendered camera surface decide
  // what to do itself.
  return { granted: true, blocked: false };
}

/**
 * Deep-link the user into the OS-level Settings app so they can toggle
 * the Camera permission for this app. Exposed as a thin wrapper so tests
 * can spy on it and so callers have a single import to reach for.
 */
export async function openCameraPermissionSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Best effort; the host OS will have surfaced its own error UI if
    // it cannot open the Settings deep link.
  }
}
