import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function patchReactNativeLevelDb() {
  const gradlePath = resolve(
    process.cwd(),
    'node_modules/react-native-leveldb/android/build.gradle',
  );

  if (!existsSync(gradlePath)) {
    return;
  }

  const original = readFileSync(gradlePath, 'utf8');
  let next = original;

  // Remove the package-local buildscript block. It pulls in AGP 7.2.2 and
  // broken repositories, which fails modern RN/Gradle builds in CI.
  next = next.replace(
    /buildscript\s*\{[\s\S]*?^\}\n\n/m,
    '',
  );

  // Ensure google() is present alongside mavenCentral() for Android deps.
  next = next.replace(
    /repositories \{\n(\s*)mavenCentral\(\)\n\}/m,
    'repositories {\n$1google()\n$1mavenCentral()\n}',
  );

  if (next !== original) {
    writeFileSync(gradlePath, next, 'utf8');
    console.log('[postinstall] Patched react-native-leveldb/android/build.gradle');
  }
}

patchReactNativeLevelDb();
