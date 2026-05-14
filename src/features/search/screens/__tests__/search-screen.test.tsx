/**
 * SearchScreen regression tests (VAL-UX-052).
 *
 * The biometric-first refactor must not change the DID-resolution
 * surface: when the user types a DID and presses Resolve, the screen
 * still calls `agent.did.resolve(did)` and renders the resolved
 * document. Biometric/PIN copy must not leak into Search.
 */

 

jest.mock('@/lib/enbox/agent-store', () => {
  const { create } = require('zustand');
  const mockResolve = jest.fn();
  const agentStub: {
    did: { resolve: jest.Mock };
  } = { did: { resolve: mockResolve } };
  const useAgentStore = create(() => ({
    agent: agentStub,
  }));
  return {
    useAgentStore,
    __mockResolve: mockResolve,
    __setAgent: (next: { did: { resolve: jest.Mock } } | null) => {
      useAgentStore.setState({ agent: next });
    },
  };
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { SearchScreen } from '@/features/search/screens/search-screen';

const agentStoreMock = require('@/lib/enbox/agent-store') as {
  __mockResolve: jest.Mock;
  __setAgent: (next: { did: { resolve: jest.Mock } } | null) => void;
};

describe('SearchScreen — VAL-UX-052 regression', () => {
  beforeEach(() => {
    agentStoreMock.__mockResolve.mockReset();
    // Ensure the agent stub is restored between tests.
    agentStoreMock.__setAgent({ did: { resolve: agentStoreMock.__mockResolve } });
  });

  it('renders the Search header + DID input placeholder', () => {
    const screen = render(<SearchScreen />);

    expect(screen.getByText('Search')).toBeTruthy();
    // The placeholder hints at a DID format.
    expect(screen.getByPlaceholderText(/did:/)).toBeTruthy();
  });

  it('calls agent.did.resolve with the trimmed DID and renders the document on success', async () => {
    const document = {
      id: 'did:dht:abc',
      service: [{ type: 'IdentityHub', serviceEndpoint: 'https://dwn.example' }],
      verificationMethod: [{ id: 'did:dht:abc#0', type: 'Ed25519VerificationKey2020' }],
    };
    agentStoreMock.__mockResolve.mockResolvedValue({
      didResolutionMetadata: {},
      didDocument: document,
    });

    const screen = render(<SearchScreen />);
    const input = screen.getByLabelText('Search DID');

    await act(async () => {
      fireEvent.changeText(input, '  did:dht:abc  ');
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });

    await waitFor(() => {
      expect(agentStoreMock.__mockResolve).toHaveBeenCalledWith('did:dht:abc');
    });
    expect(screen.getByText('Resolved')).toBeTruthy();
    expect(screen.getByText('did:dht:abc')).toBeTruthy();
    expect(screen.getByText('IdentityHub')).toBeTruthy();
  });

  it('renders the inline error card when the resolver reports an error', async () => {
    agentStoreMock.__mockResolve.mockResolvedValue({
      didResolutionMetadata: {
        error: 'notFound',
        errorMessage: 'DID not found on the DHT',
      },
      didDocument: null,
    });

    const screen = render(<SearchScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search DID'), 'did:dht:missing');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });

    await waitFor(() => {
      expect(screen.getByText('Resolution failed')).toBeTruthy();
    });
    expect(screen.getByText('DID not found on the DHT')).toBeTruthy();
  });

  it('renders the Resolution failed card when resolve throws', async () => {
    agentStoreMock.__mockResolve.mockRejectedValue(new Error('network down'));

    const screen = render(<SearchScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Search DID'),
        'did:dht:example',
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });

    await waitFor(() => {
      expect(screen.getByText('Resolution failed')).toBeTruthy();
    });
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('does not call resolve when the query is empty or does not start with did:', async () => {
    const screen = render(<SearchScreen />);
    // Press with empty query — noop.
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });
    expect(agentStoreMock.__mockResolve).not.toHaveBeenCalled();

    // Type a non-DID query — the CTA is disabled and pressing it does nothing.
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search DID'), 'hello');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });
    expect(agentStoreMock.__mockResolve).not.toHaveBeenCalled();
  });

  it('does not call resolve when the agent is absent (locked/uninitialized state)', async () => {
    agentStoreMock.__setAgent(null);

    const screen = render(<SearchScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Search DID'),
        'did:dht:abc',
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });
    expect(agentStoreMock.__mockResolve).not.toHaveBeenCalled();
  });

  it('does not render any PIN-era copy (regression guard)', () => {
    const screen = render(<SearchScreen />);
    expect(screen.queryByText(/\bPIN\b/i)).toBeNull();
    expect(screen.queryByText(/passcode/i)).toBeNull();
  });
});
