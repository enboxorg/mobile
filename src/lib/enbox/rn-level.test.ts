import { normalizeLocation } from '@/lib/enbox/rn-level';

describe('normalizeLocation', () => {
  it('flattens nested SDK paths into a single directory name', () => {
    expect(normalizeLocation('DATA/AGENT/VAULT_STORE')).toBe('DATA__AGENT__VAULT_STORE');
  });

  it('strips leading separators and sanitizes unsafe characters', () => {
    expect(normalizeLocation('/DATA/AGENT:SYNC?STORE')).toBe('DATA__AGENT_SYNC_STORE');
  });
});
