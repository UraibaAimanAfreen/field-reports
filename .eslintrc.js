module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['dist-harness/', 'server/', 'node_modules/', 'vendor/'],
  rules: {
    // `void somePromise()` is how this codebase marks a promise that is
    // deliberately not awaited -- fire-and-forget cleanup, background
    // refreshes, handlers that cannot be async. Without it those calls are
    // indistinguishable from a forgotten await, which is the bug it would be
    // hiding. Off on purpose, not by neglect.
    'no-void': 'off',
  },
};
