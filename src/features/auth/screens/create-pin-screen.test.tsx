import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { CreatePinScreen } from '@/features/auth/screens/create-pin-screen';

describe('CreatePinScreen', () => {
  it('shows the enter step first', () => {
    const screen = render(<CreatePinScreen onComplete={jest.fn()} />);
    expect(screen.getByText('Create a PIN')).toBeTruthy();
    expect(screen.getByLabelText('New PIN')).toBeTruthy();
  });

  it('advances to confirm step after entering a full PIN', () => {
    const screen = render(<CreatePinScreen onComplete={jest.fn()} />);

    fireEvent.changeText(screen.getByLabelText('New PIN'), '1234');
    fireEvent.press(screen.getByText('Next'));

    expect(screen.getByText('Confirm your PIN')).toBeTruthy();
    expect(screen.getByLabelText('Confirm PIN')).toBeTruthy();
  });

  it('shows error when confirmation does not match', async () => {
    const screen = render(<CreatePinScreen onComplete={jest.fn()} />);

    fireEvent.changeText(screen.getByLabelText('New PIN'), '1234');
    fireEvent.press(screen.getByText('Next'));

    fireEvent.changeText(screen.getByLabelText('Confirm PIN'), '5678');
    fireEvent.press(screen.getByText('Set PIN'));

    await waitFor(() => {
      expect(screen.getByText(/do not match/i)).toBeTruthy();
    });
  });

  it('calls onComplete when PINs match', async () => {
    const onComplete = jest.fn().mockResolvedValue(undefined);
    const screen = render(<CreatePinScreen onComplete={onComplete} />);

    fireEvent.changeText(screen.getByLabelText('New PIN'), '1234');
    fireEvent.press(screen.getByText('Next'));

    fireEvent.changeText(screen.getByLabelText('Confirm PIN'), '1234');
    fireEvent.press(screen.getByText('Set PIN'));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith('1234');
    });
  });

  it('allows going back to change the PIN', () => {
    const screen = render(<CreatePinScreen onComplete={jest.fn()} />);

    fireEvent.changeText(screen.getByLabelText('New PIN'), '1234');
    fireEvent.press(screen.getByText('Next'));
    fireEvent.press(screen.getByText('Back'));

    expect(screen.getByText('Create a PIN')).toBeTruthy();
  });
});
