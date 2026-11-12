#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const secretsDir = path.join(repoRoot, 'secrets');
const keystorePath = path.join(secretsDir, 'phc-release-key.jks');
const envPath = path.join(secretsDir, 'android-signing.env');
const keyAlias = process.env.PHC_UPLOAD_KEY_ALIAS || 'phc-release';

const fail = (message) => {
  console.error(`[signing-key] ${message}`);
  process.exit(1);
};

const randomPassword = () =>
  crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/g, '');

if (fs.existsSync(keystorePath)) {
  fail(`Keystore already exists: ${keystorePath}`);
}

if (fs.existsSync(envPath)) {
  fail(`Signing env file already exists: ${envPath}`);
}

fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

const storePassword = randomPassword();
const keyPassword = storePassword;

const keytoolArgs = [
  '-genkeypair',
  '-v',
  '-keystore',
  keystorePath,
  '-alias',
  keyAlias,
  '-keyalg',
  'RSA',
  '-keysize',
  '2048',
  '-validity',
  '10000',
  '-storepass',
  storePassword,
  '-keypass',
  keyPassword,
  '-dname',
  'CN=PHC, OU=Field Operations, O=PHC, L=Asuncion, ST=Central, C=PY',
];

const result = spawnSync('keytool', keytoolArgs, { stdio: 'inherit' });
if (result.error) {
  fail(`Unable to run keytool: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(`keytool exited with status ${result.status}`);
}

const quoteForShell = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const envFile = [
  '# Local Android release signing credentials for PHC.',
  '# Do not commit this file. Keep a private backup with the keystore.',
  `export PHC_UPLOAD_STORE_FILE=${quoteForShell(keystorePath)}`,
  `export PHC_UPLOAD_STORE_PASSWORD=${quoteForShell(storePassword)}`,
  `export PHC_UPLOAD_KEY_ALIAS=${quoteForShell(keyAlias)}`,
  `export PHC_UPLOAD_KEY_PASSWORD=${quoteForShell(keyPassword)}`,
  '',
].join('\n');

fs.writeFileSync(envPath, envFile, { mode: 0o600 });
fs.chmodSync(keystorePath, 0o600);

console.log(`[signing-key] Created ${keystorePath}`);
console.log(`[signing-key] Created ${envPath}`);
console.log('[signing-key] Keep both files backed up privately. Future APK updates need the same key.');
