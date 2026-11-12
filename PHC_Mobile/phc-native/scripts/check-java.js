#!/usr/bin/env node
/**
 * Android builds need JDK 17, found through JAVA_HOME (or `java` on the PATH).
 *
 * gradle.properties used to pin org.gradle.java.home to a Homebrew path on the old
 * Mac, so the build failed everywhere else with an error about that path (audit H8).
 * This says what is wrong before Gradle starts.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const javaHome = process.env.JAVA_HOME;
const java = javaHome ? path.join(javaHome, 'bin', 'java') : 'java';
const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
const output = `${result.stdout || ''}${result.stderr || ''}`;
const match = output.match(/version "(\d+)(?:\.(\d+))?/);
const major = match ? Number(match[1] === '1' ? match[2] : match[1]) : null;

if (result.error || major === null) {
  console.error(
    `[java-check] Could not run ${java}. Install JDK 17 and set JAVA_HOME to it, for example\n`
    + '  JAVA_HOME=$(mise where java@temurin-17) npm run build:android:local-qa',
  );
  process.exit(1);
}
if (major !== 17) {
  console.error(`[java-check] Found Java ${major} at ${java}. React Native 0.81 builds need JDK 17; set JAVA_HOME to one.`);
  process.exit(1);
}
console.log(`[java-check] Java ${major} at ${java}`);
