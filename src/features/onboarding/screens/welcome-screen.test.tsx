import { fireEvent, render } from '@testing-library/react-native';

import { WelcomeScreen } from '@/features/onboarding/screens/welcome-screen';

describe('WelcomeScreen', () => {
  it('renders the product value proposition', () => {
    const screen = render(<WelcomeScreen onStart={() => {}} />);

    expect(screen.getByText('Enbox')).toBeTruthy();
    expect(screen.getByText(/your identities/i)).toBeTruthy();
    expect(screen.getByText('Get started')).toBeTruthy();
  });

  it('invokes the start callback', () => {
    const onStart = jest.fn();
    const screen = render(<WelcomeScreen onStart={onStart} />);

    fireEvent.press(screen.getByText('Get started'));

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('exposes the Get started CTA with a matching accessibility label', () => {
    // VAL-UX-038 / VAL-UX-039: the stable CI/UI anchor "Get started" must
    // be both visible text AND the button's accessibilityLabel so the CI
    // UI driver and VoiceOver/TalkBack both locate the same control.
    const screen = render(<WelcomeScreen onStart={() => {}} />);

    expect(screen.getByText('Get started')).toBeTruthy();
    expect(screen.getByLabelText('Get started')).toBeTruthy();
  });

  it('sets accessibilityRole="header" on the hero title', () => {
    // VAL-UX-038: every new / preserved onboarding screen marks its
    // title with role="header" so screen readers can navigate by heading.
    const screen = render(<WelcomeScreen onStart={() => {}} />);

    const header = screen.getByRole('header');
    expect(header).toBeTruthy();
    expect(header.props.children).toMatch(/your identities/i);
  });

  it('does not mention PIN in any feature-row copy', () => {
    // VAL-UX-006 / VAL-UX-040: the old PIN-centric copy on feature 01
    // ("protected by a PIN …") must not survive the biometric-first
    // migration. Nothing on the Welcome screen may reference PIN.
    const screen = render(<WelcomeScreen onStart={() => {}} />);

    expect(screen.queryByText(/PIN/i)).toBeNull();
  });
});
