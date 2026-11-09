import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTomcat, listToolchains, sanitizeTomcat } from '../../scripts/install-toolchains.js';

async function fakeTomcat(root: string, version = '11.0.24', serverXml = '<Server port="8005"><Service name="Catalina"/></Server>') {
  const home = join(root, `apache-tomcat-${version}`);
  for (const dir of ['bin', 'lib', 'conf/Catalina/localhost', 'webapps/ROOT', 'logs', 'work', 'temp']) await mkdir(join(home, dir), { recursive: true });
  const files: Record<string, string> = {
    'RELEASE-NOTES': `                     Apache Tomcat Version ${version}\n`,
    'bin/catalina.sh': '#!/bin/sh\n', 'bin/startup.sh': '#!/bin/sh\n', 'bin/bootstrap.jar': 'jar', 'bin/tomcat-juli.jar': 'jar',
    'bin/setenv.sh': 'JAVA_OPTS="-Djava.security.krb5.conf=/etc/krb5.conf"\n', 'bin/catalina.bat': 'rem', 'bin/tcnative-1.dll': 'dll', 'bin/hs_err_pid1.log': 'crash',
    'lib/catalina.jar': 'jar', 'lib/mssql-jdbc-12.10.0.jre11.jar': 'jar', 'lib/ojdbc11.jar': 'jar', 'lib/sqljdbc_auth.dll': 'dll',
    'conf/server.xml': serverXml,
    'conf/context.xml': '<Context><Resource name="jdbc/app" driverClassName="com.microsoft.sqlserver.jdbc.SQLServerDriver" url="jdbc:sqlserver://db;integratedSecurity=true" password="hunter2"/></Context>',
    'conf/tomcat-users.xml': '<tomcat-users><user username="admin" password="admin"/></tomcat-users>',
    'conf/catalina.properties': 'common.loader="${catalina.home}/lib/*.jar"\njava.security.krb5.conf=/etc/krb5.conf\nkeep.me=true\n',
    'conf/web.xml': '<web-app/>', 'conf/logging.properties': 'handlers=java.util.logging.ConsoleHandler\n',
    'conf/jaas.config': 'Kerberos { required; };', 'conf/krb5.ini': '[libdefaults]', 'conf/keystore.jks': 'binary',
    'conf/Catalina/localhost/app.xml': '<Context password="x"/>',
  };
  for (const [rel, text] of Object.entries(files)) await writeFile(join(home, rel), text);
  return home;
}

async function allText(dir: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    // The manifest lists excluded file names (e.g. conf/krb5.ini), never contents.
    if (entry.isFile() && entry.name !== '.autos-toolchain.json') text +=await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return text;
}

test('sanitizeTomcat keeps scripts, jars and JDBC drivers but no credentials, Kerberos or Windows binaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-tc-'));
  try {
    const home = await fakeTomcat(root);
    const dest = join(root, 'out');
    const report = await sanitizeTomcat(home, dest);
    assert.equal(report.version, '11.0.24');
    assert.deepEqual(report.drivers.sort(), ['mssql-jdbc-12.10.0.jre11.jar', 'ojdbc11.jar']);
    assert.ok((await stat(join(dest, 'bin/catalina.sh'))).mode & 0o100);
    for (const kept of ['bin/bootstrap.jar', 'lib/catalina.jar', 'lib/ojdbc11.jar', 'conf/web.xml', 'conf/server.xml', 'conf/logging.properties']) await stat(join(dest, kept));
    for (const gone of ['bin/setenv.sh', 'bin/catalina.bat', 'bin/tcnative-1.dll', 'lib/sqljdbc_auth.dll', 'conf/jaas.config', 'conf/krb5.ini', 'conf/keystore.jks', 'conf/Catalina', 'webapps', 'logs', 'work', 'temp']) {
      await assert.rejects(stat(join(dest, gone)), `${gone} must not be copied`);
    }
    const context = await readFile(join(dest, 'conf/context.xml'), 'utf8');
    assert.doesNotMatch(context, /<Resource\b|password|jdbc:/i);
    assert.doesNotMatch(await readFile(join(dest, 'conf/tomcat-users.xml'), 'utf8'), /username|password/i);
    const props = await readFile(join(dest, 'conf/catalina.properties'), 'utf8');
    assert.match(props, /keep\.me=true/);
    assert.doesNotMatch(props, /krb5/);
    assert.equal(report.dropped_property_lines['conf/catalina.properties'], 1);
    const everything = await allText(dest);
    assert.doesNotMatch(everything, /hunter2|krb5|integratedSecurity/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('server.xml with a datasource or password is replaced by a minimal one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-tc-'));
  try {
    const home = await fakeTomcat(root, '9.0.50', '<Server><GlobalNamingResources><Resource name="jdbc/x" password="s3cret" url="jdbc:oracle:thin:@db"/></GlobalNamingResources></Server>');
    const dest = join(root, 'out');
    const report = await sanitizeTomcat(home, dest);
    assert.ok(report.replaced.includes('conf/server.xml'));
    const server = await readFile(join(dest, 'conf/server.xml'), 'utf8');
    assert.doesNotMatch(server, /s3cret|jdbc:/);
    assert.match(server, /<Connector port="8080"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlinked files are not followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-tc-'));
  try {
    const home = await fakeTomcat(root);
    await writeFile(join(root, 'secret.txt'), 'password=leak');
    await symlink(join(root, 'secret.txt'), join(home, 'lib', 'evil.jar'));
    const dest = join(root, 'out');
    const report = await sanitizeTomcat(home, dest);
    assert.ok(report.excluded.includes('lib/evil.jar'));
    await assert.rejects(stat(join(dest, 'lib/evil.jar')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installTomcat installs by version, refuses to overwrite without force, and lists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-tc-'));
  try {
    const home = await fakeTomcat(root);
    const toolchains = join(root, 'toolchains');
    await installTomcat(toolchains, home, false);
    await assert.rejects(installTomcat(toolchains, home, false), /already installed/);
    await installTomcat(toolchains, home, true);
    assert.deepEqual(await listToolchains(toolchains), { jdk: [], tomcat: ['11.0.24'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a folder without RELEASE-NOTES is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-tc-'));
  try {
    await mkdir(join(root, 'bin'));
    await assert.rejects(sanitizeTomcat(root, join(root, 'out')), /Tomcat version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
