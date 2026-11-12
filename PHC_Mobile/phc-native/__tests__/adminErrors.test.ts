/**
 * Admin screens must never show raw server text: English sentences, SQLSTATE
 * codes or GoTrue wording. Known refusals get a Spanish sentence; anything
 * unknown and English becomes the generic fallback.
 */
import { adminErrorText, ADMIN_GENERIC_ERROR } from '../src/domain/adminErrors';

describe('adminErrorText', () => {
  it('turns a duplicate catalog name into a plain Spanish sentence', () => {
    const error = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "catalog_materials_normalized_name_uidx"',
      details: 'Key (normalized_name)=(cemento) already exists.',
    };
    expect(adminErrorText(error)).toBe('Ya existe un material con ese nombre.');
  });

  it('explains that a completed well cannot be edited', () => {
    expect(adminErrorText(new Error('completed project core data is immutable')))
      .toBe('Este pozo está completado: sus datos ya no se pueden modificar.');
  });

  it('explains the reconciliation refusal before a Ficha is signed', () => {
    expect(adminErrorText(new Error('Reconcile every flagged shift handover before signing')))
      .toBe('Revisá y resolvé las entregas de turno marcadas antes de firmar.');
  });

  it('explains a username that already exists, in both GoTrue wordings', () => {
    expect(adminErrorText(new Error('A user with this email address has already been registered')))
      .toBe('Ya existe un operador con ese usuario.');
    expect(adminErrorText(new Error('Database error saving new user')))
      .toBe('No se pudo crear el operador: ese usuario ya está en uso.');
  });

  it('names the closing assignment instead of the wrong advice on a delete refusal', () => {
    const text = adminErrorText(new Error('Ese operador tiene registros asociados y no puede eliminarse. Usá Desactivar.'));
    expect(text).toContain('operador de cierre');
    expect(text).toContain('Desactivar');
  });

  it('hides SQLSTATE codes and English from unknown errors', () => {
    expect(adminErrorText({ message: 'new row violates check constraint "x"', code: '23514' }))
      .toBe(ADMIN_GENERIC_ERROR);
    expect(adminErrorText(new Error('permission denied for table projects'))).toBe(ADMIN_GENERIC_ERROR);
  });

  it('keeps a Spanish server message and removes the code in brackets', () => {
    expect(adminErrorText({ message: 'Ese operador ya tiene historial registrado.', code: '23503' }))
      .toBe('Ese operador ya tiene historial registrado.');
  });

  it('rewrites the server sentences written with tú into vos forms', () => {
    expect(adminErrorText(new Error('Completa o actualiza la reconciliación antes de cerrar.')))
      .toBe('Completá o actualizá la reconciliación antes de cerrar.');
    expect(adminErrorText(new Error('No se puede quitar un material con consumo; ajusta el total.')))
      .toBe('No se puede quitar un material con consumo; ajustá el total.');
    expect(adminErrorText(new Error('Resolve las discrepancias abiertas.')))
      .toBe('Resolvé las discrepancias abiertas.');
  });

  it('says the device has no connection in one plain sentence', () => {
    expect(adminErrorText(new Error('Network request failed'))).toBe('Sin conexión con el servidor.');
  });

  it('uses the caller fallback when there is no message at all', () => {
    expect(adminErrorText(null, 'Nada que mostrar')).toBe('Nada que mostrar');
  });
});
