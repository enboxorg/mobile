/**
 * SearchScreen regression tests (VAL-UX-052).
 *
 * Search mirrors the web wallet's public-profile lookup surface: when
 * the user types a DID and presses Resolve, the screen performs an
 * anonymous DWN profile query and renders public profile data.
 * Biometric/PIN copy must not leak into Search.
 */

const mockRecordsQuery = jest.fn();

jest.mock(
  '@enbox/api',
  () => ({
    __esModule: true,
    Enbox: {
      anonymous: jest.fn(() => ({
        dwn: {
          records: {
            query: mockRecordsQuery,
          },
        },
      })),
    },
  }),
  { virtual: true },
);

jest.mock(
  '@enbox/protocols',
  () => ({
    __esModule: true,
    ProfileDefinition: { protocol: 'https://identity.foundation/protocols/profile' },
  }),
  { virtual: true },
);

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
    mockRecordsQuery.mockReset();
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

  it('queries the public profile with the trimmed DID and renders profile data on success', async () => {
    mockRecordsQuery.mockResolvedValue({
      records: [
        {
          data: {
            json: jest.fn(async () => ({
              displayName: 'Alice',
              tagline: 'Decentralized builder',
              bio: 'Building with Enbox.',
            })),
          },
        },
      ],
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
      expect(mockRecordsQuery).toHaveBeenCalledWith({
        from: 'did:dht:abc',
        filter: {
          protocol: 'https://identity.foundation/protocols/profile',
          protocolPath: 'profile',
        },
      });
    });
    expect(screen.getByText('Public profile')).toBeTruthy();
    expect(screen.getByText('did:dht:abc')).toBeTruthy();
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/Decentralized builder/)).toBeTruthy();
  });

  it('renders an unnamed profile card when no profile record exists', async () => {
    mockRecordsQuery.mockResolvedValue({ records: [] });

    const screen = render(<SearchScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search DID'), 'did:dht:missing');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });

    await waitFor(() => {
      expect(screen.getByText('Unnamed identity')).toBeTruthy();
    });
  });

  it('renders the Resolution failed card when profile lookup throws', async () => {
    mockRecordsQuery.mockRejectedValue(new Error('network down'));

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
    expect(mockRecordsQuery).not.toHaveBeenCalled();

    // Type a non-DID query — the CTA is disabled and pressing it does nothing.
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search DID'), 'hello');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Resolve'));
    });
    expect(mockRecordsQuery).not.toHaveBeenCalled();
  });

  it('does not render any PIN-era copy (regression guard)', () => {
    const screen = render(<SearchScreen />);
    expect(screen.queryByText(/\bPIN\b/i)).toBeNull();
    expect(screen.queryByText(/passcode/i)).toBeNull();
  });
});
