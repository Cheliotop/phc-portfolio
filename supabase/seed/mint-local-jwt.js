// Mint an ES256 service_role JWT signed with the local GoTrue EC private key
// (from GOTRUE_JWT_KEYS). Prints the token, then verifies it against the
// admin API and PostgREST. Output is deliberately tiny.
const crypto = require('crypto');

// Read only the local container key; never embed or commit a signing key.
const jwk = require('./local-signing-key.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);

// Role comes from argv so this can mint an anon key for browser/app clients
// as well as the service_role key the seeder needs.
//   node mint-local-jwt.js              -> service_role (default)
//   node mint-local-jwt.js anon         -> anon
//   node mint-local-jwt.js anon --quiet -> anon, token only, no probes
const role = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'service_role';
const quiet = process.argv.includes('--quiet');

const header = b64({ alg: 'ES256', typ: 'JWT', kid: jwk.kid });
const payload = b64({
  role,
  iss: 'http://127.0.0.1:54321/auth/v1',
  aud: 'authenticated',
  iat: now,
  exp: now + 60 * 60 * 24 * 30,
});

const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
const sig = crypto
  .sign('sha256', Buffer.from(header + '.' + payload), { key, dsaEncoding: 'ieee-p1363' })
  .toString('base64url');

const token = `${header}.${payload}.${sig}`;

(async () => {
  if (!quiet && role === 'service_role') {
    const admin = await fetch('http://127.0.0.1:54321/auth/v1/admin/users?page=1&per_page=1', {
      headers: { apikey: token, Authorization: 'Bearer ' + token },
    });
    console.log('admin_api', admin.status, (await admin.text()).slice(0, 60));

    const rest = await fetch('http://127.0.0.1:54321/rest/v1/profiles?select=id&limit=1', {
      headers: { apikey: token, Authorization: 'Bearer ' + token },
    });
    console.log('postgrest', rest.status, (await rest.text()).slice(0, 60));
  }
  console.log(quiet ? token : 'TOKEN=' + token);
})();
