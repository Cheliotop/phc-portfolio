// Local Docker test keys only. No embedded private key.
const { execFileSync } = require('child_process');
const container = process.env.PHC_LOCAL_AUTH_CONTAINER || 'supabase_auth_PHC';
if (!/^supabase_auth_[A-Za-z0-9_-]+$/.test(container)) throw new Error('Expected a local Supabase Auth container');
const lines = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', container], { encoding: 'utf8' });
const keyEntry = JSON.parse(lines).find((v) => v.startsWith('GOTRUE_JWT_KEYS='));
if (!keyEntry) throw new Error('Local container has no JWT signing keys');
const parsedKeys = JSON.parse(keyEntry.slice('GOTRUE_JWT_KEYS='.length));
const keys = Array.isArray(parsedKeys) ? parsedKeys : parsedKeys.keys;
const jwk = keys.find((key) => key.kty === 'EC' && key.d);
if (!jwk) throw new Error('No local EC signing key available');

module.exports = jwk;
