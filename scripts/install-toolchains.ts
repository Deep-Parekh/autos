#!/usr/bin/env node
/**
 * Installs JDK and Tomcat toolchains for Autos agent and check containers.
 *
 *   node --conditions=development --import tsx scripts/install-toolchains.ts jdk 21 25
 *   node --conditions=development --import tsx scripts/install-toolchains.ts tomcat ~/sunnet/software/apache-tomcat-11.0.24 [--force]
 *   node --conditions=development --import tsx scripts/install-toolchains.ts list
 *
 * Root: --root <dir>, else AUTOS_TOOLCHAIN_ROOT, else ~/.autos/toolchains. Layout (see packages/contracts/src/toolchain.ts):
 *   <root>/jdk/<major>/        Linux Amazon Corretto JDK copied out of the official amazoncorretto:<major>-al2023 image
 *                              for this machine's Docker architecture (macOS JDKs cannot run in Linux containers).
 *   <root>/tomcat/<version>/   a sanitized copy of a local Tomcat: bin scripts and jars, lib jars (JDBC drivers kept),
 *                              standard conf files. Never copied: setenv.*, Windows binaries (.dll/.exe/.bat),
 *                              tomcat-users.xml, keystores, Kerberos/JAAS files, webapps, logs, work, temp.
 *                              context.xml and tomcat-users.xml are replaced with credential-free stock files;
 *                              server.xml is replaced with a minimal one if it contains credentials or datasources;
 *                              property-file lines carrying credentials or Kerberos settings are dropped.
 *
 * Toolchains must never contain credentials: they are mounted read-only into agent containers.
 * Database access (Autos-specific logins, datasources) is a later phase and does not use these files.
 */
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { jdkVersionSchema, tomcatVersionSchema } from '@autos/contracts';

const run = promisify(execFile);

export interface TomcatReport { version: string; drivers: string[]; excluded: string[]; replaced: string[]; dropped_property_lines: Record<string, number> }

const CONF_ALLOW = new Set(['catalina.policy', 'catalina.properties', 'context.xml', 'jaspic-providers.xml', 'jaspic-providers.xsd', 'logging.properties', 'server.xml', 'tomcat-users.xsd', 'web.xml']);
/** Credential or identity markers. Matching is case-insensitive on file text; only marker names are ever reported. */
const SECRET_MARKERS = [/password\s*=/i, /\bpwd\s*=/i, /passphrase/i, /keystorepass/i, /truststorepass/i, /certificatekeystorepassword/i, /connectionpassword/i, /krb5/i, /kerberos/i, /\bjaas\b/i, /login\.config/i, /integratedsecurity/i, /\bsecret\b/i, /\btoken\s*=/i];
const DATASOURCE_MARKERS = [/<Resource\b/i, /driverClassName/i, /jdbc:/i];
const DRIVER_JAR = /(mssql-jdbc|sqljdbc|jtds|ojdbc|postgresql|mysql-connector|mariadb-java-client|db2jcc|h2-)[^/]*\.jar$/i;

const STOCK_CONTEXT = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Installed by Autos: credential-free stock context. Datasources are not configured in phase 1. -->
<Context>
    <WatchedResource>WEB-INF/web.xml</WatchedResource>
    <WatchedResource>WEB-INF/tomcat-web.xml</WatchedResource>
    <WatchedResource>\${catalina.base}/conf/web.xml</WatchedResource>
</Context>
`;
const STOCK_USERS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Installed by Autos: no users. -->
<tomcat-users xmlns="http://tomcat.apache.org/xml" version="1.0"/>
`;
const MINIMAL_SERVER = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Installed by Autos: minimal server.xml (the original contained credentials or datasources). -->
<Server port="-1" shutdown="SHUTDOWN">
  <Listener className="org.apache.catalina.startup.VersionLoggerListener" />
  <Service name="Catalina">
    <Connector port="8080" protocol="HTTP/1.1" connectionTimeout="20000" />
    <Engine name="Catalina" defaultHost="localhost">
      <Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="false" />
    </Engine>
  </Service>
</Server>
`;

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AUTOS_TOOLCHAIN_ROOT || join(homedir(), '.autos', 'toolchains'));
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

/** Reads "Apache Tomcat Version X.Y.Z" from RELEASE-NOTES (falls back to RUNNING.txt-free detection failing closed). */
export async function tomcatVersion(source: string): Promise<string> {
  const notes = await readFile(join(source, 'RELEASE-NOTES'), 'utf8').catch(() => '');
  const match = /Apache Tomcat Version\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(notes);
  if (!match || !tomcatVersionSchema.safeParse(match[1]).success) throw new Error('Could not determine the Tomcat version from RELEASE-NOTES');
  return match[1]!;
}

function hasMarker(text: string, markers: RegExp[]): boolean { return markers.some((marker) => marker.test(text)); }

/** Copies a sanitized Tomcat home from `source` into `destination` (which must not exist). */
export async function sanitizeTomcat(source: string, destination: string): Promise<TomcatReport> {
  const version = await tomcatVersion(source);
  for (const required of ['bin/catalina.sh', 'lib/catalina.jar', 'conf/server.xml']) {
    if (!(await exists(join(source, required)))) throw new Error(`Not a Tomcat home: missing ${required}`);
  }
  const report: TomcatReport = { version, drivers: [], excluded: [], replaced: [], dropped_property_lines: {} };
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const copyFile = async (rel: string, mode: number) => {
    await mkdir(dirname(join(destination, rel)), { recursive: true, mode: 0o755 });
    await cp(join(source, rel), join(destination, rel), { dereference: false, errorOnExist: true, force: false });
    await chmod(join(destination, rel), mode);
  };
  const regular = async (rel: string) => { const info = await lstat(join(source, rel)); return info.isFile(); };

  for (const name of (await readdir(join(source, 'bin'))).sort()) {
    const rel = `bin/${name}`;
    const keep = /\.(sh|jar)$/i.test(name) && !/^setenv\./i.test(name) && await regular(rel);
    if (keep) await copyFile(rel, name.endsWith('.sh') ? 0o755 : 0o644); else report.excluded.push(rel);
  }
  for (const name of (await readdir(join(source, 'lib'))).sort()) {
    const rel = `lib/${name}`;
    if (/\.jar$/i.test(name) && await regular(rel)) {
      await copyFile(rel, 0o644);
      if (DRIVER_JAR.test(name)) report.drivers.push(name);
    } else report.excluded.push(rel);
  }
  for (const name of (await readdir(join(source, 'conf'))).sort()) {
    const rel = `conf/${name}`;
    if (!CONF_ALLOW.has(name) || !(await regular(rel))) { report.excluded.push(rel); continue; }
    const text = await readFile(join(source, rel), 'utf8');
    if (name === 'context.xml') { await writeConf(destination, rel, STOCK_CONTEXT); report.replaced.push(rel); continue; }
    if (name === 'server.xml') {
      if (hasMarker(text, SECRET_MARKERS) || hasMarker(text, DATASOURCE_MARKERS)) { await writeConf(destination, rel, MINIMAL_SERVER); report.replaced.push(rel); }
      else await writeConf(destination, rel, text);
      continue;
    }
    if (name.endsWith('.properties') || name === 'catalina.policy') {
      const lines = text.split(/\r?\n/);
      const kept = lines.filter((line) => !hasMarker(line, SECRET_MARKERS));
      if (kept.length !== lines.length) report.dropped_property_lines[rel] = lines.length - kept.length;
      await writeConf(destination, rel, kept.join('\n'));
      continue;
    }
    if (hasMarker(text, SECRET_MARKERS) || hasMarker(text, DATASOURCE_MARKERS)) throw new Error(`${rel} contains credential or datasource settings; remove them from the source Tomcat and retry`);
    await writeConf(destination, rel, text);
  }
  await writeConf(destination, 'conf/tomcat-users.xml', STOCK_USERS); report.replaced.push('conf/tomcat-users.xml');
  for (const name of ['RELEASE-NOTES', 'LICENSE', 'NOTICE']) if (await exists(join(source, name)) && await regular(name)) await copyFile(name, 0o644);
  for (const top of await readdir(source)) {
    if (!['bin', 'lib', 'conf', 'RELEASE-NOTES', 'LICENSE', 'NOTICE'].includes(top)) report.excluded.push(top);
  }
  // Final guard: nothing credential-like may remain in the installed conf.
  for (const name of await readdir(join(destination, 'conf'))) {
    const text = await readFile(join(destination, 'conf', name), 'utf8');
    if (hasMarker(text, SECRET_MARKERS)) throw new Error(`conf/${name} still contains a credential marker after sanitizing`);
  }
  await writeFile(join(destination, '.autos-toolchain.json'), `${JSON.stringify({ schema_version: 1, kind: 'tomcat', ...report, installed_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o644 });
  return report;
}

async function writeConf(destination: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(destination, rel)), { recursive: true, mode: 0o755 });
  await writeFile(join(destination, rel), text, { mode: 0o644, flag: 'wx' });
}

async function docker(args: string[], timeout = 600_000): Promise<string> {
  const { stdout } = await run('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** Replace symlinks that escape the JDK (e.g. lib/security/cacerts -> /etc/pki/...) with the file they point to inside the image. */
async function inlineEscapingLinks(container: string, containerHome: string, root: string, dir = root): Promise<number> {
  let fixed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { fixed += await inlineEscapingLinks(container, containerHome, root, path); continue; }
    if (!entry.isSymbolicLink()) continue;
    const target = await readlink(path);
    const resolved = resolve(dirname(path), target);
    if (!isAbsolute(target) && (resolved === root || resolved.startsWith(root + sep))) continue;
    const containerPath = `${containerHome}/${relative(root, path).split(sep).join('/')}`;
    await rm(path);
    await docker(['cp', '-L', `${container}:${containerPath}`, path]);
    fixed += 1;
  }
  return fixed;
}

export async function installJdk(root: string, major: string, force: boolean): Promise<string> {
  if (!jdkVersionSchema.safeParse(major).success) throw new Error(`Invalid JDK major version: ${major}`);
  const destination = join(root, 'jdk', major);
  if (await exists(destination) && !force) throw new Error(`JDK ${major} is already installed (use --force to replace it)`);
  const image = `amazoncorretto:${major}-al2023`;
  await docker(['pull', '--quiet', image]);
  const env = await docker(['image', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', image]);
  const home = /^JAVA_HOME=(\/[A-Za-z0-9._/-]+)$/m.exec(env)?.[1];
  if (!home) throw new Error(`${image} does not declare JAVA_HOME`);
  await mkdir(join(root, 'jdk'), { recursive: true, mode: 0o755 });
  const staging = join(root, 'jdk', `.${major}.staging`);
  await rm(staging, { recursive: true, force: true });
  const container = await docker(['create', image]);
  try {
    await docker(['cp', '-L', `${container}:${home}/.`, staging]);
    const fixed = await inlineEscapingLinks(container, home, staging);
    const release = await readFile(join(staging, 'release'), 'utf8');
    const version = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1] ?? '';
    if (!/^OS_NAME="Linux"/m.test(release) || version.split(/[.+]/)[0] !== major) throw new Error(`${image} did not contain a Linux JDK ${major}`);
    if (!(await stat(join(staging, 'bin', 'java'))).isFile()) throw new Error('bin/java missing');
    await writeFile(join(staging, '.autos-toolchain.json'), `${JSON.stringify({ schema_version: 1, kind: 'jdk', major, java_version: version, image, inlined_links: fixed, installed_at: new Date().toISOString() }, null, 2)}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return version;
  } finally {
    await docker(['rm', '-f', container]).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installTomcat(root: string, source: string, force: boolean): Promise<TomcatReport> {
  const version = await tomcatVersion(source);
  const destination = join(root, 'tomcat', version);
  if (await exists(destination) && !force) throw new Error(`Tomcat ${version} is already installed (use --force to replace it)`);
  await mkdir(join(root, 'tomcat'), { recursive: true, mode: 0o755 });
  const staging = join(root, 'tomcat', `.${version}.staging`);
  await rm(staging, { recursive: true, force: true });
  try {
    const report = await sanitizeTomcat(source, staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return report;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function listToolchains(root: string): Promise<{ jdk: string[]; tomcat: string[] }> {
  const names = async (kind: string) => (await readdir(join(root, kind)).catch(() => [] as string[])).filter((name) => !name.startsWith('.')).sort();
  return { jdk: await names('jdk'), tomcat: await names('tomcat') };
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  let root = defaultRoot();
  const rootIndex = args.indexOf('--root');
  if (rootIndex >= 0) { root = resolve(args[rootIndex + 1] ?? ''); args.splice(rootIndex, 2); }
  const force = args.includes('--force');
  const [command, ...rest] = args.filter((arg) => arg !== '--force');
  await mkdir(root, { recursive: true, mode: 0o755 });
  if (command === 'jdk' && rest.length) {
    for (const major of rest) console.log(`JDK ${major}: installed Corretto ${await installJdk(root, major, force)} at ${join(root, 'jdk', major)}`);
  } else if (command === 'tomcat' && rest.length) {
    for (const source of rest) {
      const report = await installTomcat(root, resolve(source.replace(/^~(?=$|\/)/, homedir())), force);
      console.log(`Tomcat ${report.version}: installed at ${join(root, 'tomcat', report.version)}`);
      console.log(`  JDBC drivers kept: ${report.drivers.join(', ') || 'none'}`);
      console.log(`  replaced with credential-free files: ${report.replaced.join(', ')}`);
      for (const [file, count] of Object.entries(report.dropped_property_lines)) console.log(`  dropped ${count} credential/Kerberos line(s) from ${file}`);
      console.log(`  not copied: ${report.excluded.join(', ') || 'nothing'}`);
    }
  } else if (command === 'list') {
    const installed = await listToolchains(root);
    console.log(`Toolchain root: ${root}\n  JDK: ${installed.jdk.join(', ') || 'none'}\n  Tomcat: ${installed.tomcat.join(', ') || 'none'}`);
  } else {
    console.error('Usage: install-toolchains.ts [--root DIR] jdk <major>... | tomcat <tomcat-home>... [--force] | list');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error: unknown) => { console.error(`install-toolchains: ${error instanceof Error ? error.message : 'failed'}`); process.exitCode = 1; });
}
