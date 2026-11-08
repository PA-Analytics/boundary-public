'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { renderReport } = require('./lib/report');

const DEFAULT_DATA = join(__dirname, 'data', 'orders.json');

function main(argv) {
  const file = argv[2] === undefined ? DEFAULT_DATA : argv[2];
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  if (!payload || !Array.isArray(payload.orders)) throw new TypeError('payload sin "orders"');
  for (const row of renderReport(payload.orders)) console.log(row);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, DEFAULT_DATA };
