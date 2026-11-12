// Synthetic fixture for a fresh LOCAL database only; created through GoTrue.
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const base = 'http://127.0.0.1:54321';
const token = process.env.PHC_LOCAL_SUPABASE_SECRET_KEY || execFileSync(process.execPath,
  [path.join(__dirname, 'mint-local-jwt.js'), 'service_role', '--quiet'], { encoding: 'utf8' }).trim();
const headers = { apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function request(route, method, body) {
  const res = await fetch(base + route, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Local fixture ${method} failed: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
(async () => {
  const username = `orphan_${randomUUID().replaceAll('-', '')}`;
  const user = await request('/auth/v1/admin/users', 'POST', {
    email: `${username}@phc.local`, password: randomUUID(), email_confirm: true,
    user_metadata: { username },
  });
  if (!user.id) throw new Error('Local fixture identity missing');
  await request(`/rest/v1/profiles?id=eq.${user.id}`, 'PATCH', { is_active: false });
  await request(`/auth/v1/admin/users/${user.id}`, 'DELETE', { should_soft_delete: true });
  console.log('Local soft-deleted identity fixture ready; no credentials printed.');
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
