#!/usr/bin/env node
// Checks the signed lists of this repository: modules/index.json and catalog/index.json with their signatures.
//
// GateRook itself verifies a list before it trusts it. This check keeps a broken one from being published at all:
//   - index.json and index.json.sig come together, and the signature holds for the exact bytes of the index under
//     the public key that keys.json lists for the signature's key id;
//   - the list has a sequence, a time it was made and a time it expires, at most 90 days apart and not yet passed;
//   - every entry is of a kind its list may hold, has a valid id and version, and pins its package by an https
//     address in this repository's releases, a size and a SHA-256;
//   - against the list before it (--previous <git ref>): the sequence never goes back and grows when the list
//     changes, and a package version that was listed keeps its SHA-256.
//
//   node tools/check.mjs [--previous HEAD~1] [--now 2026-11-12T00:00:00Z]
//
// Exit code: 0 the lists are fine (or none is published yet), 1 with every problem found, 2 usage error.

import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The lists of this repository and the kinds of entry each may hold. */
export const LISTS = Object.freeze({
  modules: Object.freeze(['module']),
  catalog: Object.freeze(['plugin', 'template', 'mcp-server']),
});
/** Where every package lives. */
export const RELEASES = 'https://github.com/gaterook/gaterook-plugins/releases/download/';
export const MAX_DAYS = 90;

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
/** SPKI header of an Ed25519 public key; the 32 raw bytes follow. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Whether `sig` is an Ed25519 signature of `bytes` by the raw 32-byte public key `raw`. */
export function signatureHolds(bytes, sig, raw) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

/** The package references of an entry: what the list pins by address, size and SHA-256. */
function pinned(entry) {
  if (entry.kind === 'module' || entry.kind === 'plugin') return [['artifact', entry.artifact]];
  if (entry.kind === 'mcp-server') return [['npm.lockfile', entry.npm?.lockfile]];
  return [];
}

/**
 * Every problem of one list.
 *
 * @param name     `modules` or `catalog`
 * @param index    the bytes of index.json, or null when the file is absent
 * @param sig      the bytes of index.json.sig, or null
 * @param keys     the public keys of this list by key id (base64url of the 32 raw bytes)
 * @param previous the bytes of the list before this one, or null
 * @param now      the time the check runs at
 */
export function checkList(name, { index, sig, keys = {}, previous = null, now = new Date() }) {
  const problems = [];
  const say = (text) => problems.push(`${name}: ${text}`);
  if (index === null && sig === null) return problems;
  if (index === null || sig === null) {
    say('index.json and index.json.sig are published together');
    return problems;
  }
  let list;
  try {
    list = JSON.parse(index.toString('utf8'));
  } catch (e) {
    say(`index.json is not JSON: ${e.message}`);
    return problems;
  }

  // ── The signature ──────────────────────────────────────────────────────────────────────────────────────────
  let signature = null;
  try {
    signature = JSON.parse(sig.toString('utf8'));
  } catch {
    say('index.json.sig is not JSON');
  }
  if (signature) {
    const raw = keys[signature.keyId];
    if (signature.alg !== 'Ed25519' || typeof signature.sig !== 'string' || typeof signature.keyId !== 'string') {
      say('index.json.sig needs keyId, alg "Ed25519" and sig');
    } else if (!raw) {
      say(`the list is signed with ${signature.keyId}, which keys.json does not list for ${name}`);
    } else if (!signatureHolds(index, Buffer.from(signature.sig, 'base64'), Buffer.from(raw, 'base64url'))) {
      say('the signature does not match the bytes of index.json');
    }
  }

  // ── Sequence and times ─────────────────────────────────────────────────────────────────────────────────────
  if (!Number.isInteger(list.sequence) || list.sequence < 0) say('sequence must be a non-negative integer');
  const made = Date.parse(list.generatedAt);
  const expires = Date.parse(list.expiresAt);
  if (Number.isNaN(made)) say('generatedAt is not a time');
  if (Number.isNaN(expires)) say('expiresAt is not a time');
  if (!Number.isNaN(made) && !Number.isNaN(expires)) {
    if (expires <= made) say('expiresAt is not after generatedAt');
    if (expires - made > MAX_DAYS * 86_400_000) say(`the list is valid for more than ${MAX_DAYS} days`);
    if (expires <= now.getTime()) say(`the list expired on ${list.expiresAt}: GateRook installs nothing from it`);
  }

  // ── Entries ────────────────────────────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(list.entries)) {
    say('entries must be an array');
    return problems;
  }
  const seen = new Set();
  const packages = new Map();
  for (const entry of list.entries) {
    const what = `${entry?.id ?? '?'}@${entry?.version ?? '?'}`;
    if (!LISTS[name].includes(entry?.kind)) {
      say(`${what}: an entry of kind ${entry?.kind} does not belong in this list`);
      continue;
    }
    if (!ID.test(entry.id ?? '')) say(`${what}: the id is not [a-z][a-z0-9-]{0,47}`);
    const version = entry.version ?? entry.displayVersion;
    if (entry.kind !== 'template' && !SEMVER.test(version ?? '')) say(`${what}: the version is not a semantic version`);
    const key = `${entry.kind}:${entry.id}@${version}`;
    if (seen.has(key)) say(`${what}: listed twice`);
    seen.add(key);
    for (const [where, ref] of pinned(entry)) {
      if (!ref || typeof ref !== 'object') {
        say(`${what}: no ${where}`);
        continue;
      }
      if (typeof ref.url !== 'string' || !ref.url.startsWith(RELEASES)) {
        say(`${what}: ${where}.url must be an address under ${RELEASES}`);
      }
      if (!SHA256.test(ref.sha256 ?? '')) say(`${what}: ${where}.sha256 is not 64 lower-case hex digits`);
      if (!Number.isInteger(ref.size) || ref.size <= 0) say(`${what}: ${where}.size must be a positive integer`);
      packages.set(key, ref.sha256);
    }
    if (entry.kind === 'module') {
      if (!Array.isArray(entry.types) || entry.types.length === 0) say(`${what}: a module lists the connector types it adds`);
      for (const type of entry.types ?? []) {
        if (!ID.test(type?.id ?? '')) say(`${what}: ${type?.id} is not a connector type id`);
        if (!Array.isArray(type?.tools) || type.tools.some((t) => !TOOL.test(t))) {
          say(`${what}: type ${type?.id} lists its tool names`);
        }
      }
      if (typeof entry.requires?.gateway !== 'string' || typeof entry.requires?.connectorApi !== 'string') {
        say(`${what}: a module says which application and connector API versions it runs with`);
      }
    }
  }
  for (const revoked of list.revoked ?? []) {
    if (!SHA256.test(revoked?.sha256 ?? '') || typeof revoked?.reason !== 'string' || !revoked.reason) {
      say('every revoked package has a sha256 and a reason');
    }
  }

  // ── Against the list before it ─────────────────────────────────────────────────────────────────────────────
  if (previous !== null) {
    let before = null;
    try {
      before = JSON.parse(previous.toString('utf8'));
    } catch {
      // A list that was never valid constrains nothing.
    }
    if (before && Number.isInteger(before.sequence) && Number.isInteger(list.sequence)) {
      if (list.sequence < before.sequence) {
        say(`sequence went back from ${before.sequence} to ${list.sequence}`);
      } else if (list.sequence === before.sequence && !previous.equals(index)) {
        say(`the list changed but its sequence is still ${list.sequence}`);
      }
      for (const entry of before.entries ?? []) {
        const version = entry.version ?? entry.displayVersion;
        const key = `${entry.kind}:${entry.id}@${version}`;
        for (const [, ref] of pinned(entry)) {
          if (ref?.sha256 && packages.has(key) && packages.get(key) !== ref.sha256) {
            say(`${entry.id}@${version}: a released package never changes, but its SHA-256 did`);
          }
        }
      }
    }
  }
  return problems;
}

/** The bytes of `path` at the Git revision `ref`, or null when it isn't there. */
function atRevision(root, ref, path) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${ref}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Every problem of every list of the checkout at `root`. */
export function checkRepository(root = ROOT, { previous = null, now = new Date() } = {}) {
  let keys = {};
  const problems = [];
  try {
    keys = JSON.parse(readFileSync(join(root, 'keys.json'), 'utf8'));
  } catch (e) {
    problems.push(`keys.json can't be read: ${e.message}`);
  }
  for (const name of Object.keys(LISTS)) {
    const read = (file) => (existsSync(join(root, name, file)) ? readFileSync(join(root, name, file)) : null);
    problems.push(...checkList(name, {
      index: read('index.json'),
      sig: read('index.json.sig'),
      keys: keys[name] ?? {},
      previous: previous ? atRevision(root, previous, `${name}/index.json`) : null,
      now,
    }));
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const known = new Set(['--previous', '--now']);
  if (args.some((a, i) => a.startsWith('--') ? !known.has(a) || args[i + 1] === undefined : !known.has(args[i - 1]))) {
    console.error('Usage: node tools/check.mjs [--previous <git ref>] [--now <time>]');
    process.exit(2);
  }
  const now = option('--now') ? new Date(option('--now')) : new Date();
  const problems = checkRepository(ROOT, { previous: option('--previous'), now });
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('check: the lists of this repository are fine');
}
