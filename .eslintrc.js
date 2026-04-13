module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    'react-native/no-inline-styles': 'off',
  },
  overrides: [
    {
      files: ['jest.setup.js', '**/*.test.ts', '**/*.test.tsx'],
      env: { jest: true },
    },
  ],
};
