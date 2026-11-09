import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const fixture = resolve('tests/fixtures/java');
const sourceFiles = [
  'src/main/java/example/tasks/Task.java', 'src/main/java/example/tasks/TaskService.java',
  'src/main/java/example/tasks/CompleteTaskAction.java', 'src/test/java/example/tasks/CompleteTaskRegression.java',
];

test('AUTO-17 regression fails on the seeded candidate and passes after the one-line fix', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'autos-fixture-'));
  try {
    const source = join(scratch, 'source');
    const classes = join(scratch, 'classes');
    await mkdir(classes);
    for (const file of sourceFiles) {
      const target = join(source, file);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, await readFile(join(fixture, file), 'utf8'));
    }
    const files = sourceFiles.map((file) => join(source, file));
    const baselineCompile = spawnSync('javac', ['--release', '17', '-d', classes, ...files], { encoding: 'utf8' });
    assert.equal(baselineCompile.status, 0, 'seeded Java fixture should compile');
    const baseline = spawnSync('java', ['-ea', '-cp', classes, 'example.tasks.CompleteTaskRegression'], { encoding: 'utf8' });
    assert.notEqual(baseline.status, 0, 'regression must fail before the fix');
    assert.match(baseline.stderr, /Expected completed task status RESOLVED/);

    const service = join(source, 'src/main/java/example/tasks/TaskService.java');
    const buggy = await readFile(service, 'utf8');
    await writeFile(service, buggy.replace('        return task;', '        task.setStatus("RESOLVED");\n        return task;'));
    await rm(classes, { recursive: true, force: true });
    await mkdir(classes);
    execFileSync('javac', ['--release', '17', '-d', classes, ...files], { stdio: 'pipe' });
    const fixed = spawnSync('java', ['-ea', '-cp', classes, 'example.tasks.CompleteTaskRegression'], { encoding: 'utf8' });
    assert.equal(fixed.status, 0, fixed.stderr);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
