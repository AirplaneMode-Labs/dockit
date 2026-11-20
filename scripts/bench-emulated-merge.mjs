#!/usr/bin/env node
// Fills the job columns of an emulated runs CSV from job-summary.json, which scripts/win/run-capped.ps1 writes after the benchmark (B6, TD-113):
//   job_commit_limit_bytes   the Job Object's commit limit; empty for the leg with no limit
//   job_commit_peak_bytes    PeakJobMemoryUsed of the whole run: the pwsh, node and Chrome process tree. It is a figure of the run, so every row of the leg carries it.
//   job_escapes              Chrome processes that were seen outside the job
// Every other cell is left exactly as bench-e2e wrote it.
//
//   node scripts/bench-emulated-merge.mjs --csv <e2e-emulated-win-vm.csv> --summary <job-summary.json>
//
// Exit 1 (and the CSV untouched) for a summary that is missing or malformed, a cap that is not none, 8GiB, 6GiB or 5GiB, a limit that does not match its cap,
// a figure that is not a non-negative integer, or a CSV whose header is not E2E_EMULATED_COLUMNS (the laptop CSV is never merged into).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csv, E2E_EMULATED_COLUMNS } from './lib/bench-columns.mjs';
import { parseCsv } from './memory-figures.mjs';

/** The only legs there are, and the commit limit each one sets (GiB, as exact byte counts). */
export const CAPS = Object.freeze({
  none: null,
  '8GiB': 8589934592,
  '6GiB': 6442450944,
  '5GiB': 5368709120,
});

const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Throws unless `summary` is a well-formed job-summary.json; returns the three cells it gives. */
export function summaryCells(summary) {
  if (summary === null || typeof summary !== 'object')
    throw new Error('job-summary.json is not an object');
  if (!Object.hasOwn(CAPS, summary.cap))
    throw new Error(`job-summary.json: cap must be one of ${Object.keys(CAPS).join(', ')}`);
  if (!('limitBytes' in summary)) throw new Error('job-summary.json: limitBytes is missing');
  if (summary.limitBytes !== CAPS[summary.cap])
    throw new Error(
      `job-summary.json: limitBytes ${summary.limitBytes} does not match cap ${summary.cap}`,
    );
  if (!isCount(summary.peakJobMemoryBytes))
    throw new Error('job-summary.json: peakJobMemoryBytes is not a non-negative integer');
  if (!isCount(summary.escapes))
    throw new Error('job-summary.json: escapes is not a non-negative integer');
  return {
    job_commit_limit_bytes: summary.limitBytes === null ? '' : summary.limitBytes,
    job_commit_peak_bytes: summary.peakJobMemoryBytes,
    job_escapes: summary.escapes,
  };
}

/** The CSV text with the three columns filled in every row. */
export function merge(csvText, summary) {
  const head = csvText.split('\n')[0];
  if (head !== E2E_EMULATED_COLUMNS.join(','))
    throw new Error(
      'the CSV header is not E2E_EMULATED_COLUMNS: this is not an emulated runs file',
    );
  const cells = summaryCells(summary);
  const rows = parseCsv(csvText).map((r) => ({ ...r, ...cells }));
  return csv(E2E_EMULATED_COLUMNS, rows);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = opt('--csv');
  const summaryFile = opt('--summary');
  if (!file || !summaryFile) {
    console.error(
      'usage: bench-emulated-merge.mjs --csv <e2e-emulated-win-vm.csv> --summary <job-summary.json>',
    );
    process.exit(2);
  }
  try {
    const summary = JSON.parse(readFileSync(resolve(summaryFile), 'utf8').replace(/^﻿/u, ''));
    const next = merge(readFileSync(resolve(file), 'utf8'), summary);
    writeFileSync(resolve(file), next);
    console.log(
      `bench-emulated-merge: filled the job columns of ${resolve(file)} (${summary.cap})`,
    );
  } catch (e) {
    console.error(
      `bench-emulated-merge: ${e.code === 'ENOENT' ? `cannot read ${e.path} (is job-summary.json written?)` : e.message}`,
    );
    process.exit(1);
  }
}
