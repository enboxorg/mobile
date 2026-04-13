/**
 * Drop-in replacement for the `level` package.
 * When @enbox/* packages do `import { Level } from 'level'`,
 * Metro resolves it to this file instead, providing our RN-native LevelDB.
 */

export { RNLevel as Level } from './rn-level';
