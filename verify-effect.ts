#!/usr/bin/env bun
/**
 * verify-effect — INDEPENDENT effect check, run outside the monitor process.
 * HTTP 200 is not evidence; the protected file is. Reports sha256, line count, and whether
 * a given attempt's marker is present.
 *   bun verify-effect.ts [attempt_id ...]
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
const P = (process.env.PROTECTED_DIR || `${process.env.INQ_DIR || import.meta.dir}/protected`) + '/deployments.log';
const body = readFileSync(P, 'utf8');
const lines = body.split('\n').filter(Boolean);
const out: any = { resource: P, sha256: createHash('sha256').update(body).digest('hex').slice(0, 32), lines: lines.length, markers: lines };
for (const id of process.argv.slice(2)) out[`effect:${id}`] = body.includes(`DEPLOYED:${id}`);
console.log(JSON.stringify(out, null, 1));
