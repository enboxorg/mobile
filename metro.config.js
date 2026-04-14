const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const levelShim = path.resolve(__dirname, 'src/lib/enbox/level-shim.ts');
const emptyModule = path.resolve(__dirname, 'src/lib/enbox/empty-module.ts');

// Node.js built-ins that @enbox/* packages reference.
// These are guarded at runtime, so empty shims are sufficient.
const nodeBuiltinShims = {
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
};

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    extraNodeModules: nodeBuiltinShims,

    // Intercept module resolution at the resolver level.
    // extraNodeModules only works for imports from project source files.
    // resolveRequest intercepts ALL imports, including from within node_modules.
    resolveRequest: (context, moduleName, platform) => {
      // Redirect `level` and `browser-level` to our RN-native LevelDB adapter.
      // The @enbox/* SDK packages import `level` which resolves to `browser-level`
      // (IndexedDB) via its `browser` field. IndexedDB doesn't exist in RN.
      if (moduleName === 'level' || moduleName === 'browser-level') {
        return {
          filePath: levelShim,
          type: 'sourceFile',
        };
      }

      // Shim classic-level too (Node.js native LevelDB, imported by level/index.js)
      if (moduleName === 'classic-level') {
        return {
          filePath: levelShim,
          type: 'sourceFile',
        };
      }

      // Shim Node built-ins when imported from within node_modules
      if (nodeBuiltinShims[moduleName]) {
        return {
          filePath: nodeBuiltinShims[moduleName],
          type: 'sourceFile',
        };
      }

      // Fall through to default resolution for everything else
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
