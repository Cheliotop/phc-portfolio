const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecure.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));
jest.mock('../src/lib/supabase', () => ({ __esModule: true, default: { auth: { onAuthStateChange: jest.fn(), storageKey: 'sb-test-auth-token' } } }));
jest.mock('../src/api/supabase-auth', () => ({ auth: { getSession: jest.fn(), rememberSignedInUser: jest.fn() } }));

import { forgetVaultOperator, listVaultOperators, saveVaultOperator, verifyVaultPassword } from '../src/utils/operatorVault';
import { PBKDF2_ITERATIONS } from '../src/utils/operatorVault';

const session = (id: string) => ({ access_token: `access-${id}`, refresh_token: `refresh-${id}`, token_type: 'bearer', expires_in: 3600, expires_at: 9999999999, user: { id } }) as any;
let randomSeed = 0;

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (randomSeed++ % 255) + 1;
    return bytes;
  } } });
});
beforeEach(() => { mockSecure.clear(); randomSeed = 0; });

describe('tablet operator vault', () => {
  it('does not lose either login when two vault writes overlap', async () => {
    await Promise.all([
      saveVaultOperator({ id: 'a', username: 'ana' }, 'password-a', session('a')),
      saveVaultOperator({ id: 'b', username: 'bea' }, 'password-b', session('b')),
    ]);
    expect((await listVaultOperators()).map((operator) => operator.id).sort()).toEqual(['a', 'b']);
  });
  it('does not authenticate an operator whose removal is already queued', async () => {
    await saveVaultOperator({ id: 'a', username: 'ana' }, 'password-a', session('a'));
    const removal = forgetVaultOperator('a');
    const verification = verifyVaultPassword('ana', 'password-a');
    await removal;
    await expect(verification).resolves.toBeNull();
  });

  it('saves identity, session, and verifier without saving the password', async () => {
    await saveVaultOperator({ id: 'a', username: 'ana', full_name: 'Ana Rojas' }, 'correct horse', session('a'));
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(20_000);
    const operators = await listVaultOperators();
    expect(operators).toEqual([{ id: 'a', username: 'ana', fullName: 'Ana Rojas' }]);
    const serialized = [...mockSecure.values()][0];
    expect(serialized).toContain('refresh-a');
    expect(serialized).not.toContain('correct horse');
    await expect(verifyVaultPassword('ana', 'correct horse')).resolves.toMatchObject({ id: 'a' });
    await expect(verifyVaultPassword('ana', 'wrong')).resolves.toBeNull();
  });

  it('keeps six most recent operators and forgets an operator', async () => {
    for (let i = 1; i <= 7; i++) {
      await saveVaultOperator({ id: String(i), username: `op${i}` }, `password${i}`, session(String(i)));
    }
    expect((await listVaultOperators()).map((operator) => operator.id)).toEqual(['7', '6', '5', '4', '3', '2']);
    await forgetVaultOperator('4');
    expect((await listVaultOperators()).map((operator) => operator.id)).toEqual(['7', '6', '5', '3', '2']);
  });
});
