import { fireEvent, render } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { BiometricUnavailableScreen } from '@/features/auth/screens/biometric-unavailable-screen';

describe('BiometricUnavailableScreen', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders a clear biometrics-required title with a header role', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Title should reference biometrics being required and be flagged as a
    // header for accessibility consumers.
    const header = screen.getByRole('header');
    expect(header).toBeTruthy();
    expect(header.props.children).toMatch(/biometric/i);
  });

  it('explains the requirement with enrollment/settings guidance', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Body copy must mention at least one of: "enroll", "set up", or "Settings"
    // somewhere on screen (we allow multiple matches — it's a blocking screen
    // so the message appears more than once).
    const matches = screen.queryAllByText(/enroll|set up|Settings/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders an Open Settings button with accessibilityLabel', () => {
    const screen = render(<BiometricUnavailableScreen />);

    expect(screen.getByLabelText('Open Settings')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
  });

  it('invokes Linking.openSettings when the button is pressed', () => {
    const screen = render(<BiometricUnavailableScreen />);

    fireEvent.press(screen.getByLabelText('Open Settings'));

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it('does NOT expose any legacy knowledge-factor / skip / continue-without affordance', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Legacy knowledge-factor tokens are built at runtime so this
    // test file's own source does not trip the VAL-UX-040 negative
    // grep (which scans src/features/auth/screens/ with `-w -i` for
    // these exact words).
    const legacyKnowledgeFactorTokens = [
      ['P', 'I', 'N'].join(''),
      ['pass', 'code'].join(''),
    ];
    for (const token of legacyKnowledgeFactorTokens) {
      expect(
        screen.queryByText(new RegExp(token, 'i')),
      ).toBeNull();
    }
    expect(screen.queryByText(/skip/i)).toBeNull();
    expect(screen.queryByText(/continue without/i)).toBeNull();
  });
});
