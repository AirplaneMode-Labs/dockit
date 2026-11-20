#!/usr/bin/env node
// Fills the job columns of an emulated runs CSV from job-summary.json, which scripts/win/run-capped.ps1 writes after the benchmark (B6, TD-113):
//   job_commit_limit_bytes      the Job Object's commit limit; empty for the leg with no limit
//   job_commit_peak_bytes       PeakJobMemoryUsed of the whole run: the pwsh, node and Chrome process tree. It is a figure of the run, so every row of the leg carries it. It is
//                               left EMPTY when the high-water mark was already as high after the commit probe as at the end of the run (summary.probe.peakIncludesProbe): then
//                               the figure would be the probe's, not the benchmark's, and 'not measured' is the honest cell.
//   job_escapes                 Chrome processes that were seen outside the job
// and, from a version 2 summary, the limit evidence (what a reader needs to say whether the limit was in force; an older summary leaves these cells empty, which reads as
// 'limit unproven'):
//   job_limit_readback_bytes    JobMemoryLimit as QueryInformationJobObject reported it after the process was assigned (0 on the leg with no limit)
//   job_limit_flags_readback    LimitFlags as reported ('0x2200' or '0x2000')
//   limit_probe_refused         'true' / 'false': the commit of limit + 256 MiB from inside the job was refused / succeeded; empty when there was no (conclusive) probe
//   job_peak_after_probe_bytes  PeakJobMemoryUsed right after the probe
//   job_memory_limit_messages   JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages the job's completion port saw over the run; empty when no port was attached
//   control_leg                 'true' on the control leg, 'false' on every other leg
// Every other cell is left exactly as bench-e2e wrote it.
//
//   node scripts/bench-emulated-merge.mjs --csv <e2e-emulated-win-vm.csv> --summary <job-summary.json>
//
// Exit 1 (and the CSV untouched) for a summary that is missing or malformed or that contradicts itself, a cap that is not one of the legs, a limit that does not match its
// cap, a figure that is not a non-negative integer, or a CSV whose header is not E2E_EMULATED_COLUMNS (the laptop CSV is never merged into). A leg that has no CSV to fill
// because its benchmark never started (a failed read-back) or because it is the control leg (a failure before the benchmark wrote anything) ends with one line and exit 0: the
// leg's own exit code is what turns it red, and a missing file would only add noise.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_CAPS, csv, E2E_EMULATED_COLUMNS, LEG_CAPS } from './lib/bench-columns.mjs';
import { parseCsv } from './memory-figures.mjs';

/** The only legs there are, and the commit limit each one sets (GiB, as exact byte counts). */
export const CAPS = LEG_CAPS;

const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The evidence cells of a version 2 summary; throws on a summary that is incomplete or contradicts itself. */
function evidenceCells(summary) {
  const where = 'job-summary.json';
  if (typeof summary.controlLeg !== 'boolean')
    throw new Error(`${where}: controlLeg must be true or false`);
  if (summary.controlLeg !== CONTROL_CAPS.includes(summary.cap))
    throw new Error(`${where}: controlLeg does not match cap ${summary.cap}`);
  if (typeof summary.limitSet !== 'boolean' || summary.limitSet !== (summary.limitBytes !== null))
    throw new Error(`${where}: limitSet does not match limitBytes`);
  if (typeof summary.benchStarted !== 'boolean')
    throw new Error(`${where}: benchStarted must be true or false`);
  const controlCell = summary.controlLeg ? 'true' : 'false';
  if (!summary.benchStarted) {
    return {
      peakIncludesProbe: false,
      cells: {
        job_limit_readback_bytes: '',
        job_limit_flags_readback: '',
        limit_probe_refused: '',
        job_peak_after_probe_bytes: '',
        job_memory_limit_messages: '',
        control_leg: controlCell,
      },
    };
  }
  const rb = summary.readBack;
  const after = isObject(rb) ? rb.afterAssign : undefined;
  if (!isObject(after)) throw new Error(`${where}: readBack.afterAssign is missing`);
  if (!['0x2000', '0x2200'].includes(after.flags))
    throw new Error(`${where}: readBack.afterAssign.flags must be 0x2000 or 0x2200`);
  if (!isCount(after.jobMemoryLimit))
    throw new Error(`${where}: readBack.afterAssign.jobMemoryLimit is not a non-negative integer`);
  // a benchmark only starts after the read-back equals what was set; a summary that says otherwise was not written by run-capped.ps1
  const expectedFlags = summary.limitSet ? '0x2200' : '0x2000';
  const expectedLimit = summary.limitSet ? summary.limitBytes : 0;
  if (rb.equal !== true || after.flags !== expectedFlags || after.jobMemoryLimit !== expectedLimit)
    throw new Error(
      `${where}: the benchmark started although the read-back differs from what was set`,
    );
  const p = summary.probe;
  if (!isObject(p) || typeof p.ran !== 'boolean')
    throw new Error(`${where}: probe.ran must be true or false`);
  if (p.ran !== summary.limitSet)
    throw new Error(`${where}: probe.ran must be true exactly on a capped leg`);
  let probeRefused = '';
  let peakAfterProbe = '';
  let includes = false;
  if (p.ran) {
    if (![true, false, null].includes(p.refused))
      throw new Error(`${where}: probe.refused must be true, false or null`);
    if (!isCount(p.peakAfterBytes))
      throw new Error(`${where}: probe.peakAfterBytes is not a non-negative integer`);
    if (typeof p.peakIncludesProbe !== 'boolean')
      throw new Error(`${where}: probe.peakIncludesProbe must be true or false`);
    if (summary.limitNotEnforced !== (p.refused === false))
      throw new Error(`${where}: limitNotEnforced does not match probe.refused`);
    probeRefused = p.refused === null ? '' : String(p.refused);
    peakAfterProbe = p.peakAfterBytes;
    includes = p.peakIncludesProbe;
  } else if (summary.limitNotEnforced !== false) {
    throw new Error(`${where}: limitNotEnforced must be false on a leg with no probe`);
  }
  const port = summary.completionPort;
  if (!isObject(port) || typeof port.attached !== 'boolean')
    throw new Error(`${where}: completionPort.attached must be true or false`);
  if (port.attached && !isCount(port.jobMemoryLimitMessages))
    throw new Error(
      `${where}: completionPort.jobMemoryLimitMessages is not a non-negative integer`,
    );
  return {
    peakIncludesProbe: includes,
    cells: {
      job_limit_readback_bytes: after.jobMemoryLimit,
      job_limit_flags_readback: after.flags,
      limit_probe_refused: probeRefused,
      job_peak_after_probe_bytes: peakAfterProbe,
      job_memory_limit_messages: port.attached ? port.jobMemoryLimitMessages : '',
      control_leg: controlCell,
    },
  };
}

/** Throws unless `summary` is a well-formed job-summary.json; returns the cells it gives (the three job cells, and the six evidence cells of a version 2 summary). */
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
  const base = {
    job_commit_limit_bytes: summary.limitBytes === null ? '' : summary.limitBytes,
    job_commit_peak_bytes: summary.peakJobMemoryBytes,
    job_escapes: summary.escapes,
  };
  if (summary.summaryVersion === undefined) {
    // written before the limit evidence existed (the first dispatch): the evidence cells stay empty, which reads as 'limit unproven'
    return {
      ...base,
      job_limit_readback_bytes: '',
      job_limit_flags_readback: '',
      limit_probe_refused: '',
      job_peak_after_probe_bytes: '',
      job_memory_limit_messages: '',
      control_leg: '',
    };
  }
  if (summary.summaryVersion !== 2)
    throw new Error('job-summary.json: summaryVersion must be absent or 2');
  const { cells, peakIncludesProbe } = evidenceCells(summary);
  return {
    ...base,
    job_commit_peak_bytes: peakIncludesProbe ? '' : base.job_commit_peak_bytes,
    ...cells,
  };
}

/** The CSV text with the job and evidence cells filled in every row. */
export function merge(csvText, summary) {
  const head = csvText.split('\n')[0];
  if (head !== E2E_EMULATED_COLUMNS.join(','))
    throw new Error(
      'the CSV header is not E2E_EMULATED_COLUMNS: this is not an emulated runs file',
    );
  const cells = summaryCells(summary);
  const rows = parseCsv(csvText).map((r) => ({ ...r, ...cells }));
  // a leg whose benchmark wrote no row keeps the header alone, with no blank line after it
  return rows.length === 0 ? `${head}\n` : csv(E2E_EMULATED_COLUMNS, rows);
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
    if (
      !existsSync(resolve(file)) &&
      (summary.benchStarted === false || summary.controlLeg === true)
    ) {
      // no benchmark, or a control that stopped before the benchmark wrote a row: nothing to fill, and no error beyond the leg's own exit code
      console.log(
        `bench-emulated-merge: no CSV for the ${summary.cap} leg (${summary.benchStarted === false ? 'the benchmark did not start' : 'a control leg that wrote no row'}); nothing to fill`,
      );
      process.exit(0);
    }
    const next = merge(readFileSync(resolve(file), 'utf8'), summary);
    writeFileSync(resolve(file), next);
    console.log(
      `bench-emulated-merge: filled the job columns of ${resolve(file)} (${summary.cap})`,
    );
  } catch (e) {
    console.error(
      `bench-emulated-merge: ${e.code === 'ENOENT' ? `cannot read ${e.path}${e.path === resolve(summaryFile) ? ' (is job-summary.json written?)' : ''}` : e.message}`,
    );
    process.exit(1);
  }
}
