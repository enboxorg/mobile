import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { MAX_UNLOCK_ATTEMPTS, PIN_LENGTH } from '@/constants/auth';
import { useSessionStore } from '@/features/session/session-store';
import { useAppTheme } from '@/theme';

export interface UnlockScreenProps {
  onUnlock: (pin: string) => Promise<boolean>;
}

export function UnlockScreen({ onUnlock }: UnlockScreenProps) {
  const theme = useAppTheme();
  const inputRef = useRef<TextInput>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lockedUntil = useSessionStore((s) => s.lockedUntil);

  const isLockedOut = lockedUntil !== null && Date.now() < lockedUntil;
  const canSubmit = pin.length === PIN_LENGTH && !isLockedOut;

  useEffect(() => {
    if (!isLockedOut) return;

    const remaining = lockedUntil! - Date.now();
    const timer = setTimeout(() => {
      setError(null);
      // Store will have already cleared lockedUntil on next hydrate/attempt
    }, remaining);

    return () => clearTimeout(timer);
  }, [isLockedOut, lockedUntil]);

  useEffect(() => {
    if (lockedUntil !== null && Date.now() < lockedUntil) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      setError(`Too many attempts. Try again in ${secs} seconds.`);
    }
  }, [lockedUntil]);

  async function handleUnlock() {
    if (!canSubmit || loading) return;

    setLoading(true);
    setError(null);

    try {
      const didUnlock = await onUnlock(pin);
      if (!didUnlock) {
        setPin('');
        inputRef.current?.focus();

        // Read updated state after the store has processed the attempt
        const s = useSessionStore.getState();
        if (s.lockedUntil !== null) {
          const secs = Math.ceil((s.lockedUntil - Date.now()) / 1000);
          setError(`Too many attempts. Try again in ${secs} seconds.`);
        } else {
          const remaining = MAX_UNLOCK_ATTEMPTS - s.failedAttempts;
          setError(`Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
        }
      }
    } catch (err) {
      setPin('');
      inputRef.current?.focus();
      setError(err instanceof Error ? err.message : 'Unlock failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <Screen contentContainerStyle={styles.content}>
        <ScreenHeader
          title="Unlock wallet"
          subtitle="Enter your PIN to continue."
        />

        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <View style={styles.form}>
            <Text style={[styles.label, { color: theme.colors.text }]}>PIN</Text>
            <TextInput
              ref={inputRef}
              accessibilityLabel="PIN"
              accessibilityHint={`Enter ${PIN_LENGTH} digit PIN`}
              autoFocus
              editable={!isLockedOut}
              keyboardType="number-pad"
              maxLength={PIN_LENGTH}
              onChangeText={setPin}
              onSubmitEditing={handleUnlock}
              placeholder={'0'.repeat(PIN_LENGTH)}
              placeholderTextColor={theme.colors.textMuted}
              returnKeyType="done"
              secureTextEntry
              style={[
                styles.input,
                {
                  backgroundColor: theme.colors.surfaceMuted,
                  borderColor: theme.colors.border,
                  color: theme.colors.text,
                },
              ]}
              value={pin}
            />
            {error ? (
              <Text accessibilityRole="alert" style={[styles.error, { color: theme.colors.warning }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>

        <AppButton
          label="Unlock"
          loading={loading}
          disabled={!canSubmit}
          onPress={handleUnlock}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { justifyContent: 'center' },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    gap: 8,
  },
  form: { gap: 10 },
  label: { fontSize: 14, fontWeight: '600' },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    fontSize: 24,
    letterSpacing: 10,
    paddingHorizontal: 18,
    paddingVertical: 16,
    textAlign: 'center',
  },
  error: { fontSize: 14, lineHeight: 20 },
});
