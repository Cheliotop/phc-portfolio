import { errorMessage, operatorErrorText, toFriendlyLoginMessage } from '../src/utils/errorMessage';

describe('errorMessage', () => {
  it('uses .message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns plain strings as-is', () => {
    expect(errorMessage('just text')).toBe('just text');
  });

  it('extracts message + code from Supabase/PostgREST error objects', () => {
    // The exact shape that produced "[object Object]" before: a plain object,
    // NOT an Error instance.
    const supabaseError = { message: 'JWT expired', code: 'PGRST301', details: null, hint: null };
    expect(errorMessage(supabaseError)).toBe('JWT expired (PGRST301)');
  });

  it('never returns "[object Object]" for a message-less object', () => {
    const result = errorMessage({ foo: 'bar' });
    expect(result).not.toBe('[object Object]');
    expect(result).toContain('bar');
  });

  it('falls back to a readable default for null/empty', () => {
    expect(errorMessage(null)).toBe('Error desconocido');
    expect(errorMessage({})).toBe('Error desconocido');
  });
});

describe('toFriendlyLoginMessage', () => {
  it('maps bad credentials to the friendly line', () => {
    expect(toFriendlyLoginMessage(new Error('Invalid login credentials'))).toBe(
      'Email o contraseña incorrectos',
    );
  });

  it('uses username wording for operators', () => {
    expect(toFriendlyLoginMessage(new Error('Invalid login credentials'), 'operator')).toBe(
      'Usuario o contraseña incorrectos',
    );
  });

  it('never leaks raw server payloads (500 blob with cookies)', () => {
    const blob = '{"status":500,"headers":{"map":{"set-cookie":"__cf_bm=secret","cf-ray":"abc"}},"url":"https://xyz.supabase.co"}';
    const result = toFriendlyLoginMessage(new Error(blob));
    expect(result).not.toContain('__cf_bm');
    expect(result).not.toContain('supabase.co');
    expect(result).toBe('No se pudo iniciar sesión. Revisá tu conexión e intentá de nuevo.');
  });

  it('preserves the friendly deactivation message', () => {
    expect(toFriendlyLoginMessage(new Error('Usuario desactivado. Contactá al administrador.'))).toBe(
      'Usuario desactivado. Contactá al administrador.',
    );
  });

  it('maps non-Error throws to the generic line', () => {
    expect(toFriendlyLoginMessage(null)).toBe(
      'No se pudo iniciar sesión. Revisá tu conexión e intentá de nuevo.',
    );
  });
});

describe('errors that never reached the server (B4)', () => {
  // The shape the Supabase client returns when fetch itself fails.
  const fetchFailure = {
    message: 'OfflineError: Sin conexión. Se muestra lo último guardado en este dispositivo.',
    details: 'OfflineError: Sin conexión.\n    at anonymous (index.android.bundle:1:2345)\n    at next (native)',
    hint: '',
    code: '',
  };

  it('drops the stack trace and the class name', () => {
    expect(errorMessage(fetchFailure)).toBe('Sin conexión. Se muestra lo último guardado en este dispositivo.');
  });

  it('keeps details that are not a stack trace', () => {
    expect(errorMessage({ message: 'duplicate key', details: 'Key (id)=(4) already exists.', code: '23505' }))
      .toBe('duplicate key · Key (id)=(4) already exists. (23505)');
  });
});

describe('operatorErrorText', () => {
  it('says the same thing for every kind of missing signal', () => {
    expect(operatorErrorText('OfflineError: Sin conexión. Se muestra lo último guardado en este dispositivo.'))
      .toBe('Sin conexión con el servidor.');
    expect(operatorErrorText('TypeError: Network request failed')).toBe('Sin conexión con el servidor.');
    expect(operatorErrorText('AbortError: Aborted')).toBe('Sin conexión con el servidor.');
  });

  it('cuts a stored stack trace', () => {
    expect(operatorErrorText('El pozo no está activo · Error: x\n    at foo (bundle:1:2)')).toBe('El pozo no está activo');
  });

  it('drops the SQLSTATE in brackets', () => {
    expect(operatorErrorText('Este pozo ya no está asignado a vos (42501)')).toBe('Este pozo ya no está asignado a vos');
    expect(operatorErrorText('JWT expired (PGRST301)')).toBe('JWT expired');
  });

  it('is empty for nothing', () => {
    expect(operatorErrorText(null)).toBe('');
    expect(operatorErrorText('  ')).toBe('');
  });
});
