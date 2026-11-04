import fs from 'node:fs';
import path from 'node:path';

/**
 * "The upload logic must be exercisable without rendering a screen."
 *
 * That property is easy to state and easy to lose: one convenient import of
 * Alert or AsyncStorage inside the queue and the whole core needs an emulator
 * to run. This test is the guard rail. If it fails, the fix is a new port in
 * ports.ts, not an exception here.
 */
const CORE_DIR = path.join(__dirname, '..');
const BANNED = [/from\s+'react-native'/, /from\s+'react'/, /from\s+'@react-native[^']*'/, /require\(\s*'react-native'/];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('src/core is platform-free', () => {
  const files = sourceFiles(CORE_DIR);

  it('finds the core modules', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map(file => [path.relative(CORE_DIR, file), file]))('%s imports nothing from React Native', (_name, file) => {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of BANNED) {
      expect(contents).not.toMatch(pattern);
    }
  });
});
