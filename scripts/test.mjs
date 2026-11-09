import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : path.endsWith('.test.ts') ? [path] : [];
  });
}
const files = process.argv.length > 2 ? process.argv.slice(2) : discover(resolve('tests')).sort();
if (!files.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
