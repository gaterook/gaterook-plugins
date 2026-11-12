import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { checkList, checkRepository, RELEASES } from './check.mjs';

const NOW = new Date('2026-11-12T12:00:00Z');
const pair = generateKeyPairSync('ed25519');
const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const KEYS = { 'modules-2026-1': raw };

const moduleEntry = (over = {}) => ({
  kind: 'module', id: 'cassandra', version: '1.0.0', name: 'Apache Cassandra',
  requires: { gateway: '>=0.10.0 & <1.0.0', connectorApi: '>=1.2.0 & <2.0.0' },
  artifact: { url: `${RELEASES}module-cassandra-1.0.0/cassandra-1.0.0.jar`, sha256: 'a'.repeat(64), size: 9_871_234 },
  types: [{ id: 'cassandra', name: 'Cassandra', group: 'Databases', tools: ['cassandra_query'] }],
  ...over,
});

const list = (over = {}) => ({
  schema: 1, sequence: 7, generatedAt: '2026-11-10T00:00:00Z', expiresAt: '2026-12-10T00:00:00Z',
  entries: [moduleEntry()], revoked: [], ...over,
});

/** A list as it is published: its bytes and their signature. */
function published(value, { keyId = 'modules-2026-1', key = pair.privateKey } = {}) {
  const index = Buffer.from(JSON.stringify(value, null, 2));
  const sig = Buffer.from(JSON.stringify({ keyId, alg: 'Ed25519', sig: sign(null, index, key).toString('base64') }));
  return { index, sig, keys: KEYS, now: NOW };
}

test('this checkout: the lists are fine', () => {
  assert.deepEqual(checkRepository(), []);
});

test('nothing published yet is fine, half a list is not', () => {
  assert.deepEqual(checkList('modules', { index: null, sig: null }), []);
  assert.deepEqual(checkList('modules', { index: Buffer.from('{}'), sig: null }),
    ['modules: index.json and index.json.sig are published together']);
});

test('a signed list of modules passes', () => {
  assert.deepEqual(checkList('modules', published(list())), []);
});

test('a list is refused when its bytes, its key or its signature file are wrong', () => {
  const good = published(list());
  const edited = { ...good, index: Buffer.from(good.index.toString().replace('Apache Cassandra', 'Apache  Cassandra')) };
  assert.deepEqual(checkList('modules', edited), ['modules: the signature does not match the bytes of index.json']);
  const other = generateKeyPairSync('ed25519');
  assert.deepEqual(checkList('modules', published(list(), { key: other.privateKey })),
    ['modules: the signature does not match the bytes of index.json']);
  assert.deepEqual(checkList('modules', published(list(), { keyId: 'unknown-key' })),
    ['modules: the list is signed with unknown-key, which keys.json does not list for modules']);
  assert.deepEqual(checkList('modules', { ...good, sig: Buffer.from('not json') }), ['modules: index.json.sig is not JSON']);
});

test('the times of a list are checked', () => {
  const problems = (over) => checkList('modules', published(list(over)));
  assert.deepEqual(problems({ expiresAt: '2026-11-11T00:00:00Z' }),
    ['modules: the list expired on 2026-11-11T00:00:00Z: GateRook installs nothing from it']);
  assert.deepEqual(problems({ expiresAt: '2027-06-01T00:00:00Z' }), ['modules: the list is valid for more than 90 days']);
  assert.deepEqual(problems({ sequence: -1 }), ['modules: sequence must be a non-negative integer']);
  assert.deepEqual(problems({ generatedAt: 'yesterday' }), ['modules: generatedAt is not a time']);
});

test('an entry belongs to its list and pins a package of this repository', () => {
  const problems = (entry, name = 'modules') => checkList(name, published(list({ entries: [entry] })));
  assert.deepEqual(problems({ kind: 'plugin', id: 'jira', version: '1.0.0' }),
    ['modules: jira@1.0.0: an entry of kind plugin does not belong in this list']);
  assert.deepEqual(problems(moduleEntry({ artifact: { url: 'https://example.com/x.jar', sha256: 'a'.repeat(64), size: 1 } })),
    [`modules: cassandra@1.0.0: artifact.url must be an address under ${RELEASES}`]);
  assert.deepEqual(problems(moduleEntry({ artifact: { url: `${RELEASES}t/x.jar`, sha256: 'ABC', size: 0 } })), [
    'modules: cassandra@1.0.0: artifact.sha256 is not 64 lower-case hex digits',
    'modules: cassandra@1.0.0: artifact.size must be a positive integer',
  ]);
  assert.deepEqual(problems(moduleEntry({ types: [] })), ['modules: cassandra@1.0.0: a module lists the connector types it adds']);
  assert.deepEqual(problems(moduleEntry({ types: [{ id: 'cassandra', tools: ['Bad-Name'] }] })),
    ['modules: cassandra@1.0.0: type cassandra lists its tool names']);
  assert.deepEqual(problems(moduleEntry({ requires: {} })),
    ['modules: cassandra@1.0.0: a module says which application and connector API versions it runs with']);
  assert.deepEqual(problems(moduleEntry({ version: '1.0' })), ['modules: cassandra@1.0: the version is not a semantic version']);
  assert.deepEqual(checkList('modules', published(list({ entries: [moduleEntry(), moduleEntry()] }))),
    ['modules: cassandra@1.0.0: listed twice']);
  assert.deepEqual(checkList('modules', published(list({ revoked: [{ sha256: 'b'.repeat(64) }] }))),
    ['modules: every revoked package has a sha256 and a reason']);
});

test('a list never goes back, grows when it changes, and a released package keeps its hash', () => {
  const before = published(list()).index;
  const next = (over) => checkList('modules', { ...published(list(over)), previous: before });
  assert.deepEqual(next({}), []);
  assert.deepEqual(next({ sequence: 8, entries: [moduleEntry(), moduleEntry({ version: '1.1.0' })] }), []);
  assert.deepEqual(next({ sequence: 6 }), ['modules: sequence went back from 7 to 6']);
  assert.deepEqual(next({ generatedAt: '2026-11-11T00:00:00Z' }), ['modules: the list changed but its sequence is still 7']);
  const replaced = moduleEntry({ artifact: { ...moduleEntry().artifact, sha256: 'c'.repeat(64) } });
  assert.deepEqual(next({ sequence: 8, entries: [replaced] }),
    ['modules: cassandra@1.0.0: a released package never changes, but its SHA-256 did']);
});
