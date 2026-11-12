import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyApiError } from '../src/api/supabase-api-errors.ts';

// Messages that used to reach the admin in English (code read W9).
test('known server and auth messages read in Spanish', () => {
  assert.equal(friendlyApiError({ message: 'completed project core data is immutable' }, 'x').message,
    'Un proyecto completado no se puede editar.');
  assert.equal(friendlyApiError({ message: 'A user with this email address has already been registered' }, 'x').message,
    'Ya existe una cuenta con ese usuario. Elegí otro.');
  assert.equal(friendlyApiError(new Error('Failed to fetch'), 'x').message,
    'Sin conexión con el servidor. Revisá la conexión e intentá de nuevo.');
});

test('anything else keeps its message, or the fallback', () => {
  assert.equal(friendlyApiError({ message: 'Algo concreto' }, 'x').message, 'Algo concreto');
  assert.equal(friendlyApiError(null, 'No se pudo').message, 'No se pudo');
});

test('crew assignment errors are shown in Spanish', () => {
  assert.equal(friendlyApiError({ code: '22023', message: 'Ese operador ya es el responsable del pozo' }, 'x').message,
    'El operador principal no puede ser también operador 2 del equipo.');
  assert.equal(friendlyApiError({ code: '23505', message: 'duplicate key project_secondary_operators' }, 'x').message,
    'Ese operador ya forma parte del equipo de este pozo.');
});

// GoTrue messages from password change and sign-in reached the admin in English (WEB-16).
test('auth password and rate-limit messages read in Spanish', () => {
  assert.equal(friendlyApiError({ message: 'New password should be different from the old password.' }, 'x').message,
    'La nueva contraseña debe ser distinta de la anterior.');
  assert.equal(friendlyApiError({ code: 'same_password', message: 'anything' }, 'x').message,
    'La nueva contraseña debe ser distinta de la anterior.');
  assert.equal(friendlyApiError({ code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.' }, 'x').message,
    'La contraseña es muy débil o no cumple los requisitos. Elegí una más segura.');
  assert.equal(friendlyApiError({ message: 'Password should be at least 6 characters.' }, 'x').message,
    'La contraseña es demasiado corta. Elegí una más larga.');
  assert.equal(friendlyApiError({ code: 'over_request_rate_limit', message: 'Request rate limit reached' }, 'x').message,
    'Hiciste demasiados intentos seguidos. Esperá un momento e intentá de nuevo.');
  assert.equal(friendlyApiError({ message: 'For security purposes, you can only request this after 47 seconds.' }, 'x').message,
    'Hiciste demasiados intentos seguidos. Esperá un momento e intentá de nuevo.');
});

test('a GoTrue message with no Spanish mapping keeps its text', () => {
  assert.equal(friendlyApiError({ message: 'Email not confirmed' }, 'No se pudo iniciar sesión.').message, 'Email not confirmed');
});
