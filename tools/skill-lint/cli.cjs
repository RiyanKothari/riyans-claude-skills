#!/usr/bin/env node
'use strict';

const path = require('path');
const { lintAll, formatReport } = require('./lint.cjs');

const dir = process.argv[2] || path.join(process.cwd(), 'skills');
const result = lintAll(dir);
console.log(formatReport(result));

// Errors fail the build; warnings do not.
process.exitCode = result.errors ? 1 : 0;
