#!/usr/bin/env node
// The connector modules whose source lives in this repository (docs/module-architecture.md): the folders under
// modules/, their versions, their built packages, and what the list of modules says about each.
//
// A module has a version of its own, in modules/<id>/module.json. It changes only when the package does: the build
// is reproducible, so the same sources give the same bytes, and modules/modules.lock.json records the size and the
// SHA-256 of every version that was released. A package whose bytes differ from the released ones of its version
// needs a new version before it can be released; one whose bytes are the same needs nothing.
//
//   node tools/modules.mjs check                 the layout: module.json, the poms, the lock and the published list
//   node tools/modules.mjs status                every built package against the lock; exit 1 when a released
//                                                version was built with other bytes
//   node tools/modules.mjs bump <id> [patch|minor|major]
//   node tools/modules.mjs index --base <url> [--previous <index.json>] [--out <file>]
//                                                the source of a list: the entries of the previous list and one
//                                                for every built package it doesn't have, ready to be signed
//   node tools/modules.mjs lock                  records the built packages as released
//
// Build the packages first: mvn -B -ntp package -DskipTests (README.md). `check` needs no build and no Java.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = 'mcp-gateway-plugin.json';
export const LOCK = 'modules/modules.lock.json';
export const LIST = 'modules/index.json';
const ID = /^[a-z][a-z0-9-]{1,47}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The entries of a ZIP archive, from its central directory. */
export function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: no end of central directory.');
  const count = bytes.readUInt16LE(eocd + 10);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  const entries = [];
  let at = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    entries.push({ name, method, compressedSize, dataStart });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry of a JAR, inflated; `null` when the JAR has no such entry. */
export function readZipEntry(bytes, name) {
  const entry = zipEntries(bytes).find((e) => e.name === name);
  if (!entry) return null;
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  return entry.method === 0 ? Buffer.from(data) : inflateRawSync(data);
}

/** The module folders of a checkout, with each module's descriptor and its package when it is built. */
export function modules(root = ROOT) {
  const dir = join(root, 'modules');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const descriptorFile = join(dir, d.name, 'module.json');
    if (!d.isDirectory() || !existsSync(descriptorFile)) continue;
    const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8'));
    const jar = join(dir, d.name, 'target', `${descriptor.id}-${descriptor.version}.jar`);
    out.push({ dir: d.name, descriptor, descriptorFile, pom: join(dir, d.name, 'pom.xml'), jar: existsSync(jar) ? jar : null });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function readLock(root = ROOT) {
  const file = join(root, LOCK);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema: 1, modules: {} };
}

/**
 * Every disagreement between the module folders, the build, the lock and the published list; empty when they agree.
 * The list may hold modules whose source isn't here: only the modules of this repository are compared with it.
 */
export function checkModules(root = ROOT) {
  const problems = [];
  const found = modules(root);
  const rootPomFile = join(root, 'pom.xml');
  const rootPom = existsSync(rootPomFile) ? readFileSync(rootPomFile, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ') : null;
  if (found.length && rootPom === null) problems.push('pom.xml is missing: it builds the modules');
  for (const m of found) {
    const { descriptor } = m;
    if (descriptor.id !== m.dir) problems.push(`modules/${m.dir}: module.json names the module ${descriptor.id}`);
    if (!ID.test(descriptor.id ?? '')) problems.push(`modules/${m.dir}: ${descriptor.id} is not a module id`);
    if (!SEMVER.test(descriptor.version ?? '')) problems.push(`modules/${m.dir}: version must be major.minor.patch`);
    if (descriptor.types !== undefined || descriptor.manifestVersion !== undefined) {
      problems.push(`modules/${m.dir}: module.json declares neither manifestVersion nor types: the build writes both `
        + 'from the module\'s connectors');
    }
    if (!existsSync(m.pom)) {
      problems.push(`modules/${m.dir} has no pom.xml`);
    } else {
      const version = /<module\.version>\s*([^<\s]+)\s*<\/module\.version>/.exec(readFileSync(m.pom, 'utf8'))?.[1];
      if (version !== descriptor.version) {
        problems.push(`modules/${m.dir}: pom.xml says module.version ${version}, module.json says ${descriptor.version}`);
      }
    }
    if (rootPom !== null && !new RegExp(`<module>\\s*modules/${m.dir}\\s*</module>`).test(rootPom)) {
      problems.push(`modules/${m.dir} is not a module of the root pom`);
    }
  }

  const lock = readLock(root);
  if (lock.schema !== 1) problems.push(`${LOCK}: schema must be 1`);
  const here = new Set(found.map((m) => m.descriptor.id));
  for (const [id, versions] of Object.entries(lock.modules ?? {})) {
    if (!here.has(id)) problems.push(`${LOCK} records ${id}, which has no folder under modules/`);
    for (const [version, pin] of Object.entries(versions ?? {})) {
      if (!SEMVER.test(version) || !SHA256.test(pin?.sha256 ?? '') || !Number.isInteger(pin?.size) || pin.size <= 0) {
        problems.push(`${LOCK}: ${id} ${version} needs a version, a SHA-256 and a size`);
      }
    }
  }

  const listFile = join(root, LIST);
  if (existsSync(listFile)) {
    const listed = (JSON.parse(readFileSync(listFile, 'utf8')).entries ?? []).filter((e) => e.kind === 'module' && here.has(e.id));
    for (const e of listed) {
      const pin = lock.modules?.[e.id]?.[e.version];
      if (!pin) {
        problems.push(`${e.id} ${e.version} is listed but ${LOCK} doesn't record it`);
      } else if (pin.sha256 !== e.artifact?.sha256 || pin.size !== e.artifact?.size) {
        problems.push(`${e.id} ${e.version} is listed with another package than ${LOCK} records`);
      }
    }
  }
  return problems;
}

/** A built package: its bytes' hash and size, and the manifest inside it. */
export function readPackage(jar) {
  const bytes = readFileSync(jar);
  const manifest = readZipEntry(bytes, MANIFEST);
  if (!manifest) throw new Error(`${jar} has no ${MANIFEST}`);
  return { sha256: sha256(bytes), size: bytes.length, manifest: JSON.parse(manifest.toString('utf8')) };
}

/**
 * Where each module stands against the lock: `unbuilt`, `released` (this version was released with these bytes),
 * `new` (this version was never released) or `changed` (this version was released with other bytes: it needs a new
 * version).
 */
export function status(root = ROOT, lock = readLock(root)) {
  return modules(root).map((m) => {
    const { id, version } = m.descriptor;
    if (!m.jar) return { id, version, state: 'unbuilt' };
    const built = readPackage(m.jar);
    const released = lock.modules?.[id]?.[version];
    const state = !released ? 'new' : released.sha256 === built.sha256 ? 'released' : 'changed';
    return { id, version, state, sha256: built.sha256, size: built.size, releasedSha256: released?.sha256 ?? null };
  });
}

/** The entry of a list of modules for a built package: what its own manifest says, and where the package is. */
export function listEntry(manifest, { url, sha256: hash, size }) {
  if (manifest.manifestVersion !== 2) throw new Error(`${manifest.id} is not a connector module`);
  return {
    kind: 'module',
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description ?? '',
    requires: { gateway: manifest.requires?.gateway, connectorApi: manifest.requires?.connectorApi },
    artifact: { url, sha256: hash, size },
    types: manifest.types.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon ?? null,
      group: t.group,
      description: t.description ?? '',
      tools: t.tools.map((tool) => tool.name),
    })),
  };
}

/** Where a module's package is released: `<base>module-<id>-<version>/<id>-<version>.jar`. */
export function releaseUrl(base, id, version) {
  return `${base.endsWith('/') ? base : `${base}/`}module-${id}-${version}/${id}-${version}.jar`;
}

/**
 * The source of the next list: every entry of the previous list, and an entry for each built package that it doesn't
 * list yet. A version that is listed stays as it was released; a built package of a listed version must be the same
 * bytes.
 */
export function sourceIndex(root, { base, previous = null }) {
  const entries = (previous?.entries ?? []).filter((e) => e.kind === 'module').map((e) => structuredClone(e));
  for (const m of modules(root)) {
    if (!m.jar) continue;
    const built = readPackage(m.jar);
    const listed = entries.find((e) => e.id === built.manifest.id && e.version === built.manifest.version);
    if (listed) {
      if (listed.artifact?.sha256 !== built.sha256) {
        throw new Error(`${built.manifest.id} ${built.manifest.version} is listed with other bytes: give the changed `
          + 'package a new version (node tools/modules.mjs bump)');
      }
      continue;
    }
    entries.push(listEntry(built.manifest, {
      url: releaseUrl(base, built.manifest.id, built.manifest.version), sha256: built.sha256, size: built.size,
    }));
  }
  entries.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version, 'en', { numeric: true }));
  return { schema: 1, entries, revoked: previous?.revoked ?? [] };
}

/** The lock with every built package recorded as released. A released version is never overwritten with other bytes. */
export function locked(root = ROOT, lock = readLock(root)) {
  const next = structuredClone(lock);
  next.schema = 1;
  next.modules ??= {};
  for (const s of status(root, lock)) {
    if (s.state === 'unbuilt') continue;
    if (s.state === 'changed') {
      throw new Error(`${s.id} ${s.version} was released with other bytes: bump its version first`);
    }
    next.modules[s.id] = { ...(next.modules[s.id] ?? {}), [s.version]: { sha256: s.sha256, size: s.size } };
  }
  return next;
}

/** The next version of `version` for a patch, minor or major change. */
export function bumped(version, part = 'patch') {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`${version} is not major.minor.patch`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('A bump is patch, minor or major');
}

/** Writes a module's next version to its module.json and its pom. */
export function bump(root, id, part = 'patch') {
  const m = modules(root).find((x) => x.descriptor.id === id);
  if (!m) throw new Error(`There is no module ${id}`);
  const next = bumped(m.descriptor.version, part);
  const descriptor = readFileSync(m.descriptorFile, 'utf8');
  writeFileSync(m.descriptorFile, descriptor.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
  const pom = readFileSync(m.pom, 'utf8');
  writeFileSync(m.pom, pom.replace(/(<module\.version>)[^<]+(<\/module\.version>)/, `$1${next}$2`));
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  try {
    if (command === 'check') {
      const problems = checkModules();
      if (problems.length) {
        console.error(problems.map((p) => `modules: ${p}`).join('\n'));
        process.exit(1);
      }
      console.log('modules: the module folders, the build, the lock and the list agree');
    } else if (command === 'status') {
      const all = status();
      for (const s of all) {
        console.log(`${s.state.padEnd(9)} ${s.id.padEnd(14)} ${s.version.padEnd(8)} ${s.sha256 ?? ''}`);
      }
      const changed = all.filter((s) => s.state === 'changed');
      if (changed.length) {
        console.error(changed.map((s) => `modules: ${s.id} ${s.version} was released with other bytes: `
          + `node tools/modules.mjs bump ${s.id}`).join('\n'));
        process.exit(1);
      }
    } else if (command === 'bump') {
      if (!args[0]) throw new Error('Usage: node tools/modules.mjs bump <id> [patch|minor|major]');
      console.log(`${args[0]} is now ${bump(ROOT, args[0], args[1] ?? 'patch')}`);
    } else if (command === 'index') {
      const base = option('--base');
      if (!base) throw new Error('Usage: node tools/modules.mjs index --base <release url> [--previous <index.json>] [--out <file>]');
      const previous = option('--previous') ? JSON.parse(readFileSync(option('--previous'), 'utf8')) : null;
      const text = `${JSON.stringify(sourceIndex(ROOT, { base, previous }), null, 2)}\n`;
      if (option('--out')) writeFileSync(option('--out'), text);
      else process.stdout.write(text);
    } else if (command === 'lock') {
      writeFileSync(join(ROOT, LOCK), `${JSON.stringify(locked(), null, 2)}\n`);
      console.log(`modules: ${LOCK} records the built packages`);
    } else {
      console.error('Usage: node tools/modules.mjs check | status | bump <id> [part] | index --base <url> | lock');
      process.exit(2);
    }
  } catch (e) {
    console.error(`modules: ${e.message}`);
    process.exit(1);
  }
}
