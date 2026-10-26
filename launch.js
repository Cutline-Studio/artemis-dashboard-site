'use strict';
// Container entrypoint. Started as root ONLY so it can run sandbox commands as a
// separate uid. It never parses requests: it spawns the web server (server.js) as the
// unprivileged OPS_SERVER_UID and executes commands the server sends over IPC, each as
// the dedicated OPS_SANDBOX_UID. Without root (or OPS_SANDBOX_UID) it just runs server.js.
const path = require('path');
const { spawn } = require('child_process');

const isRoot = process.getuid && process.getuid() === 0;
if (!isRoot || !process.env.OPS_SANDBOX_UID || process.env.OPS_TERMINAL === '0') {
  require('./server.js');
} else {
  const sandbox = require('./ops/sandbox'); // reads OPS_* config at load time
  const info = sandbox.init().isolation;
  const su = parseInt(process.env.OPS_SERVER_UID || '1000', 10);
  const sg = parseInt(process.env.OPS_SERVER_GID || String(su), 10);
  const env = { ...process.env, OPS_PARENT_RUNNER: '1' };
  for (const k of Object.keys(env)) if (/^OPS_(SANDBOX|SERVER|SWEEP|TMP|POLICY)/.test(k)) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { uid: su, gid: sg, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  // Scrub what this root process no longer needs to hold in its JS heap.
  for (const k of ['DASHBOARD_PASSWORD', 'INGEST_TOKEN', 'SESSION_SECRET', 'BLOB_SAS_URL']) delete process.env[k];
  let queue = Promise.resolve();
  child.on('message', m => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') child.send({ type: 'ready', info, limits: sandbox.LIMITS });
    if (m.type === 'run' && typeof m.id === 'string' && typeof m.command === 'string') {
      queue = queue.then(() => sandbox.run(m.command, m.timeout)).then(
        r => { if (child.connected) child.send({ type: 'result', id: m.id, result: r }); },
        () => { if (child.connected) child.send({ type: 'result', id: m.id, result: { stdout: '', stderr: '', exit_code: null, duration_ms: 0, timed_out: false, truncated: false, blocked: 'sandbox error' } }); });
    }
  });
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { try { child.kill(s); } catch {} });
  child.on('exit', (code, sig) => process.exit(code != null ? code : 1));
}
