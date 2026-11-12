#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const variant = process.argv[2] || 'release';
const artifactType = process.argv[3] || 'apk';
const projectRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const releasesDir = path.join(repoRoot, 'releases');
const date = new Date().toISOString().slice(0, 10);

const candidates = artifactType === 'aab'
  ? [
    path.join(projectRoot, 'android', 'app', 'build', 'outputs', 'bundle', variant, `app-${variant}.aab`),
  ]
  : [
    path.join(projectRoot, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`),
    path.join(projectRoot, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}-unsigned.apk`),
  ];

const source = candidates.find((candidate) => fs.existsSync(candidate));
if (!source) {
  console.error(`[release-copy] No ${artifactType.toUpperCase()} artifact found for ${variant}. Checked:\n${candidates.join('\n')}`);
  process.exit(1);
}

fs.mkdirSync(releasesDir, { recursive: true });

const unsigned = source.includes('unsigned') || process.env.ALLOW_UNSIGNED_RELEASE === 'true';
const label = process.env.PHC_RELEASE_LABEL
  ? `-${process.env.PHC_RELEASE_LABEL.replace(/[^a-zA-Z0-9._-]/g, '-')}`
  : '';
const suffix = unsigned ? `${variant}${label}-unsigned` : `${variant}${label}`;
const target = path.join(releasesDir, `PHC_${date}_${suffix}.${artifactType}`);

fs.copyFileSync(source, target);
console.log(`[release-copy] Copied ${source} -> ${target}`);
