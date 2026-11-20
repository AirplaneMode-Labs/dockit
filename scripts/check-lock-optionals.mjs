#!/usr/bin/env node
// Checks package-lock.json before a build-tool bump is accepted (Sprint 7, B5, TD-112):
//   1. every package with a resolved URL has an integrity hash, and a native optional package is resolved from the npm registry (the lock stays hash-pinned);
//   2. every native optional family (a name with a platform in it: @rolldown/binding-darwin-arm64, @esbuild/linux-x64, ...) that has more than one platform has all
//      three the lab builds and runs on: linux-x64-gnu, darwin-arm64 and win32-x64-msvc (linux-x64 and win32-x64 for families that do not say gnu or msvc);
//      A platform that a family does not ship at all is accepted only by name, with its reason, in the same list (missingPlatformsAccepted).
//   3. every package with hasInstallScript is on the accepted list (scripts/lock-install-scripts.allow.json: a name and who accepted it). .npmrc sets
//      ignore-scripts=true, so an accepted install script still never runs on `npm ci`.
//
//   node scripts/check-lock-optionals.mjs [--lock <package-lock.json>] [--allow <list.json>]     exit 0 ok, 1 problems, 2 usage
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REQUIRED_TRIPLES = Object.freeze(['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc']);
const REGISTRY = 'https://registry.npmjs.org/';
const PLATFORM =
  /(?:^|[-/])((?:android|darwin|freebsd|linux|linuxmusl|win32|openharmony|netbsd|openbsd|sunos|aix)(?:-[a-z0-9_]+)*)$/u;
const nameOf = (key) => key.split('node_modules/').at(-1);

/** The triple of a native package name ('@rolldown/binding-linux-x64-gnu' gives 'linux-x64-gnu'), or null. */
const tripleOf = (name) => PLATFORM.exec(name)?.[1] ?? null;
/** Whether `triple` satisfies a required one: 'linux-x64' (esbuild, no libc in the name) satisfies linux-x64-gnu, 'win32-x64' satisfies win32-x64-msvc. */
const satisfies = (have, want) =>
  have === want ||
  (want === 'linux-x64-gnu' && have === 'linux-x64') ||
  (want === 'win32-x64-msvc' && have === 'win32-x64');

/**
 * @param {{ packages: Record<string, any> }} lock
 * @param {{ allowed: { name: string, accepted: string }[], missingAccepted?: { family: string, triple: string, reason: string }[] }} o
 * @returns {{ problems: string[], families: string[] }}
 */
export function checkLock(lock, { allowed, missingAccepted = [] }) {
  const problems = [];
  const packages = lock.packages ?? {};
  const native = new Map(); // family -> [{ name, triple }]
  for (const [key, p] of Object.entries(packages)) {
    if (key === '' || p.link) continue;
    const name = nameOf(key);
    if (typeof p.resolved === 'string' && typeof p.integrity !== 'string')
      problems.push(`${name}: resolved but has no integrity`);
    const isNative = p.optional === true && (p.os !== undefined || p.cpu !== undefined);
    if (isNative) {
      if (typeof p.resolved !== 'string')
        problems.push(`${name}: native optional with no resolved URL`);
      else if (!p.resolved.startsWith(REGISTRY))
        problems.push(
          `${name}: native optional not resolved from the npm registry (${p.resolved})`,
        );
      const triple = tripleOf(name);
      if (triple !== null) {
        const family = name.slice(0, name.length - triple.length - 1);
        native.set(family, [...(native.get(family) ?? []), { name, triple }]);
      }
    }
    if (p.hasInstallScript === true && !allowed.some((a) => a.name === name))
      problems.push(
        `${name}: has an install script that is not on the accepted list (S1 accepts each one in writing; scripts/lock-install-scripts.allow.json)`,
      );
  }
  const families = [];
  for (const [family, members] of [...native].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (members.length < 2) continue; // a single-platform package (fsevents) has no sibling to be missing
    families.push(family);
    for (const want of REQUIRED_TRIPLES)
      if (
        !members.some((m) => satisfies(m.triple, want)) &&
        !missingAccepted.some((a) => a.family === family && a.triple === want)
      )
        problems.push(`${family}: no ${want} package in the lock`);
  }
  return { problems, families };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? resolve(args[args.indexOf(n) + 1] ?? '') : d);
  try {
    const lock = JSON.parse(
      readFileSync(opt('--lock', join(here, '..', 'package-lock.json')), 'utf8'),
    );
    if (typeof lock?.packages !== 'object' || lock.packages === null)
      throw new Error('not a lockfileVersion 2 or 3 package-lock.json (no packages object)');
    const allow = JSON.parse(
      readFileSync(opt('--allow', join(here, 'lock-install-scripts.allow.json')), 'utf8'),
    );
    const r = checkLock(lock, {
      allowed: allow.accepted ?? [],
      missingAccepted: allow.missingPlatformsAccepted ?? [],
    });
    console.log(
      `check-lock-optionals: ${Object.keys(lock.packages).length - 1} packages, native families checked: ${r.families.join(', ') || 'none'}`,
    );
    for (const p of r.problems) console.error(`check-lock-optionals: ${p}`);
    process.exit(r.problems.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`check-lock-optionals: ${e.message}`);
    process.exit(1);
  }
}
