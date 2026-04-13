import { useRef, useState } from 'react';
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
import { PIN_LENGTH } from '@/constants/auth';
import { useAppTheme } from '@/theme';

export interface CreatePinScreenProps {
  onComplete: (pin: string) => void | Promise<void>;
}

type Step = 'enter' | 'confirm';

export function CreatePinScreen({ onComplete }: CreatePinScreenProps) {
  const theme = useAppTheme();
  const confirmRef = useRef<TextInput>(null);
  const [step, setStep] = useState<Step>('enter');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canProceed = step === 'enter' && pin.length === PIN_LENGTH;
  const canConfirm = step === 'confirm' && confirmPin.length === PIN_LENGTH;

  function handleNext() {
    if (!canProceed) return;
    setStep('confirm');
    setError(null);
    setTimeout(() => confirmRef.current?.focus(), 100);
  }

  async function handleConfirm() {
    if (!canConfirm || loading) return;

    if (confirmPin !== pin) {
      setError('PINs do not match. Try again.');
      setConfirmPin('');
      confirmRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onComplete(pin);
    } finally {
      setLoading(false);
    }
  }

  function handleBack() {
    setStep('enter');
    setConfirmPin('');
    setError(null);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <Screen contentContainerStyle={styles.content}>
        <ScreenHeader
          title={step === 'enter' ? 'Create a PIN' : 'Confirm your PIN'}
          subtitle={
            step === 'enter'
              ? `Choose a ${PIN_LENGTH}-digit PIN to secure your wallet. You'll need this PIN every time you open the app.`
              : 'Enter the same PIN again to confirm.'
          }
        />

        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          {step === 'enter' ? (
            <View style={styles.form}>
              <Text style={[styles.label, { color: theme.colors.text }]}>New PIN</Text>
              <TextInput
                accessibilityLabel="New PIN"
                accessibilityHint={`Enter ${PIN_LENGTH} digits`}
                autoFocus
                keyboardType="number-pad"
                maxLength={PIN_LENGTH}
                onChangeText={setPin}
                onSubmitEditing={handleNext}
                placeholder={'0'.repeat(PIN_LENGTH)}
                placeholderTextColor={theme.colors.textMuted}
                returnKeyType="next"
                secureTextEntry
                style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
                value={pin}
              />
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={[styles.label, { color: theme.colors.text }]}>Confirm PIN</Text>
              <TextInput
                ref={confirmRef}
                accessibilityLabel="Confirm PIN"
                accessibilityHint={`Re-enter ${PIN_LENGTH} digits`}
                keyboardType="number-pad"
                maxLength={PIN_LENGTH}
                onChangeText={setConfirmPin}
                onSubmitEditing={handleConfirm}
                placeholder={'0'.repeat(PIN_LENGTH)}
                placeholderTextColor={theme.colors.textMuted}
                returnKeyType="done"
                secureTextEntry
                style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
                value={confirmPin}
              />
              {error ? (
                <Text accessibilityRole="alert" style={[styles.error, { color: theme.colors.warning }]}>
                  {error}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {step === 'enter' ? (
          <AppButton label="Next" disabled={!canProceed} onPress={handleNext} />
        ) : (
          <View style={styles.buttons}>
            <AppButton label="Back" variant="secondary" onPress={handleBack} />
            <AppButton label="Set PIN" disabled={!canConfirm} loading={loading} onPress={handleConfirm} />
          </View>
        )}
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
  buttons: { flexDirection: 'row', gap: 12 },
});
