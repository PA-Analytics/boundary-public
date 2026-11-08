'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAmountToCents, formatCents } = require('./lib/parse');
const { computeTotals } = require('./lib/total');
const { renderReport } = require('./lib/report');
const orders = require('./data/orders.json').orders;

test('parse: redondea al centavo, nunca trunca', () => {
  assert.equal(parseAmountToCents('2.999'), 300);
  assert.equal(parseAmountToCents('10.50'), 1050);
  assert.equal(parseAmountToCents('0.005'), 1);
  assert.equal(parseAmountToCents('1,25'), 125);
  assert.equal(parseAmountToCents(12.34), 1234);
  assert.throws(() => parseAmountToCents('abc'), TypeError);
});

test('formato: siempre dos decimales', () => {
  assert.equal(formatCents(1050), '10.50');
  assert.equal(formatCents(3), '0.03');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(-250), '-2.50');
});

test('totales: descuento y gestion redondeados al centavo', () => {
  const totals = computeTotals(orders[0]);
  assert.equal(totals.subtotal, 1230);
  assert.equal(totals.discount, 185);
  assert.equal(totals.handling, 3);
  assert.equal(totals.total, 1048);
});

test('informe: agrupado por moneda, ordenado por codigo ISO y con dos decimales', () => {
  assert.deepEqual(renderReport(orders), [
    'EUR: subtotal 8.40 | descuento 0.00 | gestion 0.03 | total 8.43',
    'USD: subtotal 12.30 | descuento 1.85 | gestion 0.03 | total 10.48',
  ]);
});

test('entradas invalidas fallan explicitamente', () => {
  assert.throws(() => computeTotals({ lines: [] }), TypeError);
  assert.throws(() => computeTotals({ lines: [{ amount: '1.00', quantity: 0 }] }), TypeError);
  assert.throws(
    () => renderReport([{ id: 'x', currency: 'EURO', lines: [{ amount: '1.00', quantity: 1 }] }]),
    TypeError,
  );
});
