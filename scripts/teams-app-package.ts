import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { parseConfigYaml } from '@autos/contracts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function icon(size: number, outline: boolean): Buffer {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const bg = outline ? [0, 0, 0, 0] : [79, 70, 229, 255];
  const scale = size / 32;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); pixels[row] = 0;
    for (let x = 0; x < size; x++) {
      let color = bg;
      // A simple white geometric A mark, generated directly into RGBA pixels.
      const nx = x / scale; const ny = y / scale;
      const inside = nx >= 7 && nx <= 25 && ny >= 7 && ny <= 26 &&
        (ny >= 22 || (nx >= 10 + Math.abs(16 - nx) * 0.35 && nx <= 22 - Math.abs(16 - nx) * 0.35));
      const stroke = Math.abs(ny - (26 - Math.abs(nx - 16) * 1.45)) < 2.2 && nx >= 7 && nx <= 25;
      const bar = ny >= 18 && ny <= 21 && nx >= 11 && nx <= 21;
      if (inside && (stroke || bar)) color = [255, 255, 255, 255];
      const at = row + 1 + x * 4; pixels[at] = color[0]!; pixels[at + 1] = color[1]!; pixels[at + 2] = color[2]!; pixels[at + 3] = color[3]!;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const checksum = crc32(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function args(argv: string[]): { configPath: string; outDir: string } {
  let configPath: string | undefined; let outDir = resolve(process.cwd(), 'artifacts/teams-app');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === '--config' || arg === '--out') && argv[i + 1]) {
      if (arg === '--config') configPath = resolve(argv[++i]!); else outDir = resolve(argv[++i]!);
    } else throw new Error('Usage: teams-app-package --config PATH [--out DIRECTORY]');
  }
  if (!configPath) throw new Error('Usage: teams-app-package --config PATH [--out DIRECTORY]');
  return { configPath, outDir };
}

async function main(): Promise<void> {
  try {
    const options = args(process.argv.slice(2));
    const config = parseConfigYaml(await readFile(options.configPath, 'utf8'));
    if (!config.teams_bot) throw new Error('teams_bot is not configured');
    const appId = config.teams_bot.app_id;
    const template = await readFile(resolve(root, 'teams-app/manifest.template.json'), 'utf8');
    const manifest = template.replaceAll('{{APP_ID}}', appId);
    const archive = zip([
      { name: 'manifest.json', data: Buffer.from(manifest) },
      { name: 'color.png', data: icon(192, false) },
      { name: 'outline.png', data: icon(32, true) },
    ]);
    await mkdir(options.outDir, { recursive: true });
    const output = resolve(options.outDir, 'autos-teams-app.zip');
    await writeFile(output, archive);
    process.stdout.write(`Created ${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to package Teams app'}\n`);
    process.exitCode = 1;
  }
}

await main();
