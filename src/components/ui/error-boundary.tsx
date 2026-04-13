import { Component, type PropsWithChildren, type ReactNode } from 'react';
import { Appearance, Pressable, StyleSheet, Text, View } from 'react-native';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const isDark = Appearance.getColorScheme() === 'dark';

      return (
        <View style={[styles.container, { backgroundColor: isDark ? '#0B1020' : '#F5F7FB' }]}>
          <Text style={[styles.title, { color: isDark ? '#F7FAFC' : '#0F172A' }]}>
            Something went wrong
          </Text>
          <Text style={[styles.message, { color: isDark ? '#94A3B8' : '#52607A' }]}>
            {this.state.error.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={this.handleReset}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#5B3DF5',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
