import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  bump, bumped, checkModules, listEntry, locked, modules, readZipEntry, releaseUrl, sourceIndex, status,
} from './modules.mjs';

const BASE = 'https://github.com/gaterook/gaterook-plugins/releases/download/';

/** A ZIP with deflated and stored entries, as a JAR holds its manifest and its classes. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, { data, stored }] of Object.entries(files)) {
    const raw = Buffer.from(data);
    const body = stored ? raw : deflateRawSync(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(Buffer.byteLength(name), 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(Buffer.byteLength(name), 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(head, Buffer.from(name), body);
    central.push(entry, Buffer.from(name));
    offset += 30 + Buffer.byteLength(name) + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (version) => ({
  manifestVersion: 2, id: 'alpha', version, name: 'Alpha', description: 'The first module.',
  requires: { gateway: '>=0.9.2 & <1.0.0', connectorApi: '>=1.2.0 & <2.0.0' },
  types: [{ id: 'alpha', name: 'Alpha', icon: 'database', group: 'Databases', description: 'Reads alpha.',
    tools: [{ name: 'alpha_read' }, { name: 'alpha_write' }] }],
});

/** A checkout with the module `alpha`, built unless `built` is false; `content` changes its package's bytes. */
function fixture(t, { version = '1.0.0', built = true, content = 'classes', pomVersion = version, inReactor = true,
  descriptor = {} } = {}) {
  const scratch = new URL('../ai/', import.meta.url);
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(new URL('modules-test-', scratch));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'modules', 'alpha', 'target'), { recursive: true });
  writeFileSync(join(root, 'pom.xml'), `<project><modules><!-- <module>modules/gone</module> -->${inReactor
    ? '<module>modules/alpha</module>' : ''}</modules></project>`);
  writeFileSync(join(root, 'modules', 'alpha', 'module.json'),
    `${JSON.stringify({ id: 'alpha', version, name: 'Alpha', ...descriptor }, null, 2)}\n`);
  writeFileSync(join(root, 'modules', 'alpha', 'pom.xml'),
    `<project><properties><module.version>${pomVersion}</module.version></properties></project>`);
  if (built) {
    writeFileSync(join(root, 'modules', 'alpha', 'target', `alpha-${version}.jar`), zip({
      'mcp-gateway-plugin.json': { data: JSON.stringify(manifest(version)) },
      'com/example/Alpha.class': { data: content, stored: true },
    }));
  }
  return root;
}

const writeLock = (root, lock) => writeFileSync(join(root, 'modules', 'modules.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
const writeList = (root, list) => writeFileSync(join(root, 'modules', 'index.json'), JSON.stringify(list));

test('this checkout: the module folders, the build, the lock and the list agree', () => {
  assert.deepEqual(checkModules(), []);
  assert.ok(modules().length > 0, 'this repository has module sources');
});

test('an entry of a JAR is read whether it is deflated or stored', () => {
  const jar = zip({ 'a.json': { data: '{"deflated":true}' }, 'b.bin': { data: 'stored', stored: true } });
  assert.equal(readZipEntry(jar, 'a.json').toString(), '{"deflated":true}');
  assert.equal(readZipEntry(jar, 'b.bin').toString(), 'stored');
  assert.equal(readZipEntry(jar, 'missing'), null);
});

test('the layout is checked: ids, versions and the build', (t) => {
  assert.deepEqual(checkModules(fixture(t)), []);
  assert.deepEqual(checkModules(fixture(t, { pomVersion: '0.9.0' })),
    ['modules/alpha: pom.xml says module.version 0.9.0, module.json says 1.0.0']);
  assert.deepEqual(checkModules(fixture(t, { inReactor: false })), ['modules/alpha is not a module of the root pom']);
  assert.deepEqual(checkModules(fixture(t, { version: '1.0' })), ['modules/alpha: version must be major.minor.patch']);
  assert.deepEqual(checkModules(fixture(t, { descriptor: { id: 'beta' } })),
    ['modules/alpha: module.json names the module beta']);
  assert.match(checkModules(fixture(t, { descriptor: { types: [] } }))[0], /declares neither manifestVersion nor types/);
});

test('the lock is checked against the folders and the published list', (t) => {
  const root = fixture(t);
  const pin = { sha256: 'a'.repeat(64), size: 10 };
  writeLock(root, { schema: 1, modules: { alpha: { '1.0.0': pin }, gone: { '1.0.0': pin } } });
  assert.deepEqual(checkModules(root), ['modules/modules.lock.json records gone, which has no folder under modules/']);

  writeLock(root, { schema: 1, modules: { alpha: { '1.0.0': { sha256: 'short', size: 10 } } } });
  assert.deepEqual(checkModules(root), ['modules/modules.lock.json: alpha 1.0.0 needs a version, a SHA-256 and a size']);

  // The list may hold modules whose source lives elsewhere: only the modules of this checkout are compared.
  const entry = (id, version, artifact) => ({ kind: 'module', id, version, artifact });
  writeLock(root, { schema: 1, modules: { alpha: { '1.0.0': pin } } });
  writeList(root, { entries: [entry('alpha', '1.0.0', pin), entry('elsewhere', '2.0.0', pin)] });
  assert.deepEqual(checkModules(root), []);
  writeList(root, { entries: [entry('alpha', '1.0.0', { sha256: 'b'.repeat(64), size: 10 })] });
  assert.deepEqual(checkModules(root), ['alpha 1.0.0 is listed with another package than modules/modules.lock.json records']);
  writeList(root, { entries: [entry('alpha', '1.0.0', pin), entry('alpha', '1.1.0', pin)] });
  assert.deepEqual(checkModules(root), ['alpha 1.1.0 is listed but modules/modules.lock.json doesn\'t record it']);
});

test('a package is new, released, or changed without a new version', (t) => {
  const root = fixture(t);
  assert.equal(status(root)[0].state, 'new');
  const lock = locked(root);
  assert.deepEqual(Object.keys(lock.modules.alpha), ['1.0.0']);
  assert.equal(status(root, lock)[0].state, 'released');

  // The same version with other bytes: it can neither be listed nor recorded until it gets a new version.
  const changed = fixture(t, { content: 'other classes' });
  assert.equal(status(changed, lock)[0].state, 'changed');
  assert.throws(() => locked(changed, lock), /bump its version first/);

  const next = fixture(t, { version: '1.0.1', content: 'other classes' });
  assert.equal(status(next, lock)[0].state, 'new');
  assert.deepEqual(Object.keys(locked(next, lock).modules.alpha), ['1.0.0', '1.0.1']);
  assert.equal(status(fixture(t, { built: false }))[0].state, 'unbuilt');
});

test('a list keeps what it released and adds the built packages it lacks', (t) => {
  const root = fixture(t);
  const first = sourceIndex(root, { base: BASE });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].artifact.url, `${BASE}module-alpha-1.0.0/alpha-1.0.0.jar`);
  assert.deepEqual(first.entries[0].types[0].tools, ['alpha_read', 'alpha_write']);

  // Entries of modules whose source isn't here stay as the list before had them.
  const elsewhere = { kind: 'module', id: 'elsewhere', version: '2.0.0', artifact: { sha256: 'c'.repeat(64), size: 5 } };
  const previous = { entries: [...first.entries, elsewhere], revoked: [{ sha256: 'd'.repeat(64), reason: 'Bad build' }] };
  const again = sourceIndex(root, { base: BASE, previous });
  assert.deepEqual(again.entries.map((e) => `${e.id}@${e.version}`), ['alpha@1.0.0', 'elsewhere@2.0.0']);
  assert.deepEqual(again.revoked, previous.revoked);

  const next = sourceIndex(fixture(t, { version: '1.0.1', content: 'other classes' }), { base: BASE, previous });
  assert.deepEqual(next.entries.map((e) => `${e.id}@${e.version}`), ['alpha@1.0.0', 'alpha@1.0.1', 'elsewhere@2.0.0']);
  assert.throws(() => sourceIndex(fixture(t, { content: 'other classes' }), { base: BASE, previous }),
    /listed with other bytes/);
});

test('a version is bumped in module.json and in the pom together', (t) => {
  const root = fixture(t);
  assert.equal(bump(root, 'alpha', 'minor'), '1.1.0');
  assert.equal(JSON.parse(readFileSync(join(root, 'modules', 'alpha', 'module.json'), 'utf8')).version, '1.1.0');
  assert.match(readFileSync(join(root, 'modules', 'alpha', 'pom.xml'), 'utf8'), /<module\.version>1\.1\.0<\/module\.version>/);
  assert.deepEqual(checkModules(root), []);
  assert.equal(bumped('1.9.9', 'major'), '2.0.0');
  assert.equal(bumped('1.9.9'), '1.9.10');
  assert.throws(() => bump(root, 'beta'), /There is no module beta/);
  assert.throws(() => bumped('1.0', 'patch'), /not major\.minor\.patch/);
});

test('an entry is written from the module\'s own manifest', () => {
  const entry = listEntry(manifest('1.0.0'), { url: releaseUrl(BASE, 'alpha', '1.0.0'), sha256: 'e'.repeat(64), size: 7 });
  assert.deepEqual(entry, {
    kind: 'module', id: 'alpha', version: '1.0.0', name: 'Alpha', description: 'The first module.',
    requires: { gateway: '>=0.9.2 & <1.0.0', connectorApi: '>=1.2.0 & <2.0.0' },
    artifact: { url: `${BASE}module-alpha-1.0.0/alpha-1.0.0.jar`, sha256: 'e'.repeat(64), size: 7 },
    types: [{ id: 'alpha', name: 'Alpha', icon: 'database', group: 'Databases', description: 'Reads alpha.',
      tools: ['alpha_read', 'alpha_write'] }],
  });
  assert.throws(() => listEntry({ ...manifest('1.0.0'), manifestVersion: 1 }, { url: 'x', sha256: 'y', size: 1 }),
    /not a connector module/);
});
