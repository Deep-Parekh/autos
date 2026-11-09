/**
 * Disposable bare Git remote seeded from tests/fixtures/java for the synthetic scenario.
 * TEST FIXTURE ONLY. Uses an isolated Git environment and never touches a real repository.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const fixtureJavaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'java');
export const regressionTestPath = 'src/test/java/example/tasks/CompleteTaskRegression.java';
export const ROOT_RULE = 'RULE-AUTOS-FIXTURE-7';
export const NESTED_RULE = 'RULE-AUTOS-FIXTURE-NESTED-9';
export const taskServicePath = 'src/main/java/example/tasks/TaskService.java';

export function isolatedGitEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Autos Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Autos Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

/** Deterministic compile + baseline (+ regression when present) check script seeded into the repository. */
export const checkScript = `import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { spawnSync } from 'node:child_process';
const files = []; function walk(p) { for (const item of readdirSync(p, {withFileTypes:true})) { const path = join(p,item.name); if(item.isDirectory()) walk(path); else if(path.endsWith('.java')) files.push(path); } }
walk('src'); const classes=mkdtempSync(join(tmpdir(),'autos-java-classes-')); let status=0;
try { const compile=spawnSync('javac',['--release','17','-d',classes,...files],{stdio:'pipe'}); if(compile.status!==0) status=1;
else { for(const name of ['FixtureBaseline', ...(files.some(p=>p.endsWith('CompleteTaskRegression.java'))?['CompleteTaskRegression']:[])]) { const run=spawnSync('java',['-ea','-cp',classes,'example.tasks.'+name],{stdio:'pipe'}); if(run.status!==0) status=1; } }
} finally { rmSync(classes,{recursive:true,force:true}); } process.exit(status);
`;

export interface FixtureRemote {
  /** Absolute path to the bare remote (for GitRunner testOnlyRemoteOverrides). */
  remotePath: string;
  /** Commit SHA at the head of `develop`. */
  baseSha: string;
  gitEnv: Record<string, string>;
  /** Run Git with the isolated environment. */
  git(args: string[], cwd?: string): Promise<string>;
}

/**
 * Create `<root>/remote.git` containing a `develop` branch: the Java/Struts/JS fixture WITHOUT its regression test,
 * plus AGENTS.md, a baseline check, and scripts/check.mjs. The seed worktree lives in `<root>/seed`.
 */
export async function seedFixtureRemote(root: string): Promise<FixtureRemote> {
  const gitEnv = isolatedGitEnvironment(root);
  const git = async (args: string[], cwd = root): Promise<string> => (await execFile('git', args, { cwd, env: gitEnv })).stdout.trim();
  const seed = join(root, 'seed');
  const remotePath = join(root, 'remote.git');
  await cp(fixtureJavaDirectory, seed, { recursive: true });
  await rm(join(seed, regressionTestPath));
  await mkdir(join(seed, 'scripts'), { recursive: true });
  await writeFile(join(seed, 'src/test/java/example/tasks/FixtureBaseline.java'), 'package example.tasks; public class FixtureBaseline { public static void main(String[] args) { if (!"success".equals(new CompleteTaskAction(new TaskService()).execute(new Task("SAMPLE-123")))) throw new AssertionError("baseline action failed"); } }\n');
  await writeFile(join(seed, 'AGENTS.md'), 'Preserve the Action to Service boundary. Add a regression test for the completion status.\nRULE-AUTOS-FIXTURE-7: regression tests live in src/test/java.\n');
  await writeFile(join(seed, 'src/main/java/example/tasks/AGENTS.md'), 'RULE-AUTOS-FIXTURE-NESTED-9: TaskService changes only the task status; keep persistence concerns out of this package.\n');
  await writeFile(join(seed, 'scripts/check.mjs'), checkScript);
  await git(['init', '-b', 'develop', seed]);
  await git(['add', '.'], seed);
  await git(['commit', '-m', 'Seed passing baseline and unfixed completion status'], seed);
  const baseSha = await git(['rev-parse', 'HEAD'], seed);
  await git(['init', '--bare', remotePath]);
  await git(['remote', 'add', 'origin', remotePath], seed);
  await git(['push', 'origin', 'develop'], seed);
  return { remotePath, baseSha, gitEnv, git };
}
