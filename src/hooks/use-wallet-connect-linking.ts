import { useEffect } from 'react';
import { Linking } from 'react-native';

import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';

export function useWalletConnectLinking() {
  const handleIncomingUrl = useWalletConnectStore((s) => s.handleIncomingUrl);

  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => {
        if (url) {
          handleIncomingUrl(url).catch(() => {});
        }
      })
      .catch(() => {});

    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleIncomingUrl(url).catch(() => {});
    });

    return () => subscription.remove();
  }, [handleIncomingUrl]);
}
