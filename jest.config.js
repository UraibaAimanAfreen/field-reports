module.exports = {
  preset: '@react-native/jest-preset',
  // Only files that actually contain tests. Shared fakes live beside them.
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx', '<rootDir>/__tests__/**/*.test.tsx'],
  collectCoverageFrom: ['src/core/**/*.ts', '!src/core/__tests__/**'],
};
