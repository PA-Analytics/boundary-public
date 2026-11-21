'use strict';

/**
 * Importes: conversion a centavos enteros y formateo de vuelta.
 *
 * Contrato (lo fija `acceptance.js`, no este comentario):
 *  - se redondea al centavo mas cercano (mitad hacia arriba), nunca se trunca;
 *  - el formato siempre muestra dos decimales.
 */

function parseAmountToCents(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new TypeError(`importe no valido: ${raw}`);
    return Math.round(raw * 100);
  }
  const text = String(raw).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new TypeError(`importe no valido: ${raw}`);
  const value = Number.parseFloat(text);
  return Math.round(value * 100);
}

function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`centavos no enteros: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.trunc(abs / 100);
  const rest = abs - units * 100;
  return `${sign}${units}.${String(rest).padStart(2, '0')}`;
}

module.exports = { parseAmountToCents, formatCents };
