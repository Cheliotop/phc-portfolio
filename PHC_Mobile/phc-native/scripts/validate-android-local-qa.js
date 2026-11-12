#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const EXPECTED_URL = 'http://10.0.2.2:54321';

const fail = (message) => {
  console.error(`[local-qa-check] ${message}`);
  process.exit(1);
};

if (process.env.EXPO_PUBLIC_PHC_LOCAL_QA !== 'true') {
  fail('EXPO_PUBLIC_PHC_LOCAL_QA must be exactly "true".');
}
if (process.env.EXPO_PUBLIC_SUPABASE_URL !== EXPECTED_URL) {
  fail(`EXPO_PUBLIC_SUPABASE_URL must be exactly ${EXPECTED_URL}.`);
}

const apiKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
if (!apiKey) {
  fail('EXPO_PUBLIC_SUPABASE_ANON_KEY must contain the local stack API key/JWT.');
}
if (apiKey.startsWith('sb_secret_')) {
  fail('Do not embed an sb_secret_ key. Use the local stack publishable key or an anon JWT.');
}
if (apiKey.startsWith('sb_publishable_')) {
  // Preferred local-app key. A real seeded password login is part of the
  // local release gate; service/admin endpoints intentionally use a separate
  // local-only token and must never leak into the APK.
} else if (apiKey.split('.').length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url').toString('utf8'));
    if (payload.role !== 'anon') {
      fail(`Local app API JWT role must be anon, received ${String(payload.role)}.`);
    }
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.startsWith('[local-qa-check]')) throw error;
    fail('EXPO_PUBLIC_SUPABASE_ANON_KEY is not a decodable local API JWT.');
  }
} else {
  fail('EXPO_PUBLIC_SUPABASE_ANON_KEY must be a local sb_publishable_ key or an anon JWT.');
}

if (!process.env.PHC_VERSION_NAME || !/^\d+\.\d+\.\d+$/.test(process.env.PHC_VERSION_NAME)) {
  fail('PHC_VERSION_NAME must be an explicit semantic version (for example 2.0.15).');
}
if (!process.env.PHC_VERSION_CODE || !/^\d+$/.test(process.env.PHC_VERSION_CODE)) {
  fail('PHC_VERSION_CODE must be an explicit integer (for example 17).');
}

const staleBundle = path.resolve(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.android.bundle');
if (fs.existsSync(staleBundle)) {
  fail(`Stale pre-bundled JS found at ${staleBundle}.`);
}

console.log('[local-qa-check] Inputs are pinned to the emulator-local Supabase stack.');
