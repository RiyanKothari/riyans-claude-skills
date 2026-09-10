#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { audit, formatReport } = require('./audit.cjs');

const argv = process.argv.slice(2);
const dir = argv.includes('--global')
  ? path.join(os.homedir(), '.claude')
  : path.join(process.cwd(), '.claude');

const result = audit({ dir });
console.log(formatReport(result));

// Non-zero on warnings so this can gate CI if a project wants it to.
if (argv.includes('--strict') && result.warnings.length) process.exitCode = 1;
