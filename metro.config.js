const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // Redirect `level` imports to our RN-native LevelDB wrapper.
    // The @enbox/* SDK packages import `level` internally, which
    // defaults to IndexedDB (browser) or native LevelDB (Node).
    // Neither works in React Native, so we intercept and provide
    // our own adapter backed by react-native-leveldb.
    extraNodeModules: {
      level: path.resolve(__dirname, 'src/lib/enbox/level-shim.ts'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
