/* eslint-env node */

// Pin the suite's timezone before Jest forks its workers.
//
// The date helpers deliberately read the DEVICE's local day: an operator
// ordering material at 23:30 in Chaco must get today, not tomorrow. The tests
// that prove that are therefore only meaningful against a fixed zone, and they
// never set one — they inherited the runner's. So the same commit passed on a
// laptop in Paraguay and failed on CI in UTC. A test whose answer depends on
// where you are standing is not a test.
//
// This has to happen here rather than in setupFiles. globalSetup runs once in
// the main process before any worker is forked, so the workers inherit TZ in
// their real environment. setupFiles run inside the per-file sandbox, where the
// assignment only touches a copy of process.env and Node's resolved timezone
// never changes.
module.exports = () => {
  process.env.TZ = 'America/Asuncion';
};
