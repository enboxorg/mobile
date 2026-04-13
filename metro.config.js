const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const emptyModule = path.resolve(__dirname, 'src/lib/enbox/empty-module.ts');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    extraNodeModules: {
      // Redirect `level` to our RN-native LevelDB adapter
      level: path.resolve(__dirname, 'src/lib/enbox/level-shim.ts'),

      // Shim Node.js built-ins that @enbox/* packages dynamically import.
      // These are guarded at runtime (try/catch or typeof checks), so they
      // just need to resolve without crashing the Metro bundler.
      'node:fs': emptyModule,
      'node:fs/promises': emptyModule,
      'node:path': emptyModule,
      'node:os': emptyModule,
      'node:child_process': emptyModule,
      'node:crypto': emptyModule,
      'node:stream': emptyModule,
      'node:url': emptyModule,
      fs: emptyModule,
      path: emptyModule,
      os: emptyModule,
      crypto: emptyModule,
      stream: emptyModule,
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
