'use strict';

const { cost } = require('boundary-cost-tools');
const { parseAmountToCents } = require('./parse');

/**
 * Totales de un pedido, siempre en centavos enteros.
 *
 * La tasa de gestion la calcula la dependencia declarada
 * `boundary-cost-tools` (ver `dependencies` en package.json).
 */
function computeTotals(order) {
  if (!order || !Array.isArray(order.lines) || order.lines.length === 0) {
    throw new TypeError('pedido sin lineas');
  }
  let subtotal = 0;
  let units = 0;
  for (const line of order.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new TypeError(`cantidad no valida: ${line.quantity}`);
    }
    subtotal += parseAmountToCents(line.amount) * line.quantity;
    units += line.quantity;
  }
  const discountPercent = order.discountPercent === undefined ? 0 : order.discountPercent;
  if (discountPercent < 0 || discountPercent > 100) {
    throw new RangeError(`descuento fuera de rango: ${discountPercent}`);
  }
  // DEFECTO-3: trunca el descuento; debe redondearse al centavo mas cercano.
  const discount = Math.floor((subtotal * discountPercent) / 100);
  const handling = cost(units);
  return { subtotal, discount, handling, total: subtotal - discount + handling };
}

module.exports = { computeTotals };
