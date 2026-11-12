import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectionReasonText } from '../src/domain/rejectedWork.ts';

test('Revisión reads the Spanish server wording (2026-11-10) as well as the old English one', () => {
  assert.equal(rejectionReasonText('No se pueden agregar barras sin conexión después de enviar la Ficha (55000)'),
    'La Ficha del pozo ya se había enviado.');
  assert.equal(rejectionReasonText('Offline drilling evidence cannot be added after Ficha submission (55000)'),
    'La Ficha del pozo ya se había enviado.');
  assert.equal(rejectionReasonText('El turno cerrado necesita su informe de consumo antes de reenviar barras sin conexión (55000)'),
    'El turno ya estaba cerrado sin informe.');
});
