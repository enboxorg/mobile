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
});
