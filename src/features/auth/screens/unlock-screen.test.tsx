import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { UnlockScreen } from '@/features/auth/screens/unlock-screen';
import { useSessionStore } from '@/features/session/session-store';

beforeEach(() => {
  useSessionStore.setState({
    failedAttempts: 0,
    lockedUntil: null,
  });
});

describe('UnlockScreen', () => {
  it('does not submit until the PIN is complete', () => {
    const onUnlock = jest.fn().mockResolvedValue(true);
    const screen = render(<UnlockScreen onUnlock={onUnlock} />);

    fireEvent.changeText(screen.getByLabelText('PIN'), '12');
    fireEvent.press(screen.getByText('Unlock'));

    expect(onUnlock).not.toHaveBeenCalled();
  });

  it('submits once a 4-digit PIN is entered', async () => {
    const onUnlock = jest.fn().mockResolvedValue(true);
    const screen = render(<UnlockScreen onUnlock={onUnlock} />);

    fireEvent.changeText(screen.getByLabelText('PIN'), '1234');
    fireEvent.press(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith('1234');
    });
  });

  it('clears the PIN and shows error on failed attempt', async () => {
    // Simulate the store tracking the failure
    const onUnlock = jest.fn().mockImplementation(async () => {
      useSessionStore.setState({ failedAttempts: 1 });
      return false;
    });
    const screen = render(<UnlockScreen onUnlock={onUnlock} />);

    fireEvent.changeText(screen.getByLabelText('PIN'), '9999');
    fireEvent.press(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByText(/attempt/i)).toBeTruthy();
    });

    expect(screen.getByLabelText('PIN').props.value).toBe('');
  });
});
