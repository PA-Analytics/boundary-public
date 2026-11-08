'use strict';

const { formatCents } = require('./parse');
const { computeTotals } = require('./total');

/**
 * Informe agregado por moneda.
 *
 * El orden de los grupos y el formato exacto de cada importe los fija la
 * suite de pruebas (`index.test.js`): hay que ejecutarla para conocerlos.
 */
function renderReport(orders) {
  if (!Array.isArray(orders)) throw new TypeError('se esperaba una lista de pedidos');
  const byCurrency = new Map();
  for (const order of orders) {
    const currency = String(order.currency === undefined ? '' : order.currency).toUpperCase();
    if (currency.length !== 3) throw new TypeError(`moneda no valida: ${order.currency}`);
    const totals = computeTotals(order);
    const acc = byCurrency.get(currency) || { subtotal: 0, discount: 0, handling: 0, total: 0 };
    acc.subtotal += totals.subtotal;
    acc.discount += totals.discount;
    acc.handling += totals.handling;
    acc.total += totals.total;
    byCurrency.set(currency, acc);
  }
  const rows = [];
  // DEFECTO-4: no ordena los grupos por codigo ISO.
  for (const [currency, acc] of byCurrency) {
    rows.push(
      `${currency}: subtotal ${formatCents(acc.subtotal)} | descuento ${formatCents(acc.discount)} | gestion ${formatCents(acc.handling)} | total ${formatCents(acc.total)}`,
    );
  }
  return rows;
}

module.exports = { renderReport };
