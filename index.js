/**
 * Enbox Mobile entry point.
 * Polyfills MUST be loaded before any @enbox/* imports.
 */

import './src/lib/polyfills';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
