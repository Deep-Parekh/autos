import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(offset, -1, 'zip end record exists');
  const count = bytes.readUInt16LE(offset + 10); let cursor = bytes.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const size = bytes.readUInt32LE(cursor + 24); const nameLength = bytes.readUInt16LE(cursor + 28); const extraLength = bytes.readUInt16LE(cursor + 30); const commentLength = bytes.readUInt16LE(cursor + 32); const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtraLength = bytes.readUInt16LE(localOffset + 28); const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, bytes.subarray(dataStart, dataStart + size)); cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('Teams app package contains the configured manifest and generated PNG icons', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-app-'));
  try {
    const example = await readFile(resolve('config/config.example.yaml'), 'utf8');
    const appId = '11111111-2222-4333-8444-555555555555';
    const configPath = join(dir, 'autos.yaml');
    await writeFile(configPath, `${example.trimEnd()}\nteams_bot:\n  app_id: ${appId}\n  tenant_id: 22222222-3333-4444-8555-666666666666\n  client_secret_env: AUTOS_TEAMS_SECRET\n  allowed_users:\n    - 33333333-4444-4555-8666-777777777777\n`);
    const out = join(dir, 'package');
    const run = spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', 'scripts/teams-app-package.ts', '--config', configPath, '--out', out], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const files = unzip(await readFile(join(out, 'autos-teams-app.zip')));
    assert.deepEqual([...files.keys()], ['manifest.json', 'color.png', 'outline.png']);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as Record<string, any>;
    assert.equal(manifest.manifestVersion, '1.17'); assert.equal(manifest.id, appId);
    assert.deepEqual(manifest.bots[0].scopes, ['personal', 'team', 'groupChat']);
    assert.equal(manifest.bots[0].botId, appId); assert.equal(manifest.bots[0].supportsFiles, false);
    assert.deepEqual(manifest.validDomains, []);
    assert.deepEqual(manifest.bots[0].commandLists[0].commands.map((command: { title: string }) => command.title), ['help', 'run', 'status', 'show']);
    for (const [name, size] of [['color.png', 192], ['outline.png', 32]] as const) {
      const png = files.get(name)!;
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
