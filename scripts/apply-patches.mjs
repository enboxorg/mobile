import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function patchReactNativeLevelDb() {
  const gradlePath = resolve(
    process.cwd(),
    'node_modules/react-native-leveldb/android/build.gradle',
  );
  const iosCppPath = resolve(
    process.cwd(),
    'node_modules/react-native-leveldb/cpp/leveldb/util/env_posix.cc',
  );

  if (existsSync(gradlePath)) {
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

  if (existsSync(iosCppPath)) {
    const original = readFileSync(iosCppPath, 'utf8');
    const next = original
      .replaceAll('std::memory_order::memory_order_relaxed', 'std::memory_order_relaxed');

    if (next !== original) {
      writeFileSync(iosCppPath, next, 'utf8');
      console.log('[postinstall] Patched react-native-leveldb/cpp/leveldb/util/env_posix.cc');
    }
  }
}

patchReactNativeLevelDb();
