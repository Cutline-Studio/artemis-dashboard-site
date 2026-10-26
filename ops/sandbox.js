'use strict';
// Ops Terminal sandbox executor. Runs ONE command in an ephemeral temp dir as an
// unprivileged uid, with a scrubbed env, rlimits, a hard timeout (process-group
// SIGKILL), output caps, and Linux namespaces (no network, private pid/mount)
// when the kernel allows them. Used by ops/runner.js (root helper) or in-process.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./policy');

const LIMITS = {
  timeout_default_ms: 5000,
  timeout_max_ms: 30000,
  stdout_cap_bytes: 64 * 1024,
  stderr_cap_bytes: 64 * 1024,
  kill_after_bytes: 8 * 1024 * 1024,   // runaway output: kill the process group
  cpu_seconds: 10,                     // RLIMIT_CPU
  address_space_bytes: 256 * 1024 * 1024, // RLIMIT_AS
  file_size_bytes: 16 * 1024 * 1024,   // RLIMIT_FSIZE (largest file it may write)
  nproc: 32,                           // RLIMIT_NPROC (per sandbox uid)
  nofile: 64,                          // RLIMIT_NOFILE
};

const cfg = {
  uid: process.env.OPS_SANDBOX_UID ? parseInt(process.env.OPS_SANDBOX_UID, 10) : null,
  gid: process.env.OPS_SANDBOX_GID ? parseInt(process.env.OPS_SANDBOX_GID, 10) : null,
  sweepUid: process.env.OPS_SWEEP_UID === '1', // uid is dedicated: kill all its processes after each run
  tmpRoot: process.env.OPS_TMP_ROOT || os.tmpdir(),
  mode: process.env.OPS_POLICY === 'denylist' ? 'denylist' : 'allowlist',
};

function which(name) {
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

let state = null; // { binDir, prlimit, ns: [...], isolation: {...} }

// Build a private PATH dir that only holds the allow-listed tools.
function buildBinDir() {
  const dir = fs.mkdtempSync(path.join(cfg.tmpRoot, 'ops-bin-'));
  for (const name of policy.ALLOW) {
    const real = which(name);
    if (real) try { fs.symlinkSync(real, path.join(dir, name)); } catch {}
  }
  fs.chmodSync(dir, 0o755);
  return dir;
}

function spawnOpts(extra = {}) {
  const o = { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], ...extra };
  if (cfg.uid != null && process.getuid && process.getuid() === 0) { o.uid = cfg.uid; o.gid = cfg.gid != null ? cfg.gid : cfg.uid; }
  return o;
}

function probeNamespaces(unshare) {
  if (!unshare) return { ns: [], level: 'none', note: 'unshare not installed' };
  const tries = [
    { level: 'net+pid+mount', args: ['--user', '--map-current-user', '--net', '--pid', '--kill-child', '--mount', '--mount-proc'] },
    { level: 'net+pid+mount', args: ['--user', '--map-root-user', '--net', '--pid', '--kill-child', '--mount', '--mount-proc'] },
    { level: 'net', args: ['--user', '--map-current-user', '--net'] },
    { level: 'net', args: ['--user', '--map-root-user', '--net'] },
  ];
  for (const t of tries) {
    const r = spawnSync(unshare, [...t.args, '--', '/bin/sh', '-c', 'cat /proc/net/dev | wc -l'], { ...spawnOpts(), timeout: 3000, encoding: 'utf8' });
    // A fresh net namespace only has "lo": header (2 lines) + lo = 3 lines.
    if (r.status === 0 && parseInt((r.stdout || '').trim(), 10) <= 3) return { ns: t.args, level: t.level };
  }
  return { ns: [], level: 'none', note: 'user namespaces not permitted by this host (no kernel-level network block)' };
}

function init() {
  if (state) return state;
  const isRoot = process.getuid && process.getuid() === 0;
  const prlimit = which('prlimit');
  const unshare = which('unshare');
  const binDir = buildBinDir();
  const nsp = probeNamespaces(unshare);
  state = {
    binDir, prlimit, unshare, ns: nsp.ns,
    isolation: {
      sandbox_uid: isRoot && cfg.uid != null ? cfg.uid : (process.getuid ? process.getuid() : null),
      separate_uid: !!(isRoot && cfg.uid != null),
      rlimits: prlimit ? 'prlimit' : 'none',
      namespaces: nsp.level,
      namespace_note: nsp.note || null,
      env: 'scrubbed (PATH, HOME, TMPDIR, LANG, TERM only)',
      path: 'private dir with allow-listed tools only',
      policy: cfg.mode,
      uid_sweep_after_run: cfg.sweepUid && isRoot,
    },
  };
  return state;
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

function sweepUid() {
  if (!cfg.sweepUid || !(process.getuid && process.getuid() === 0) || cfg.uid == null) return;
  // kill(-1) as the sandbox uid signals every process that uid owns (background leftovers).
  const kill = which('kill');
  if (kill) spawnSync(kill, ['-9', '-1'], { ...spawnOpts(), timeout: 2000 });
}

// Parse POSIX `times` output; 2nd line = children user/sys. Reported by the sandbox
// shell itself, so treat as a measurement the command could in theory spoof.
function cpuTimes(txt) {
  const lines = txt.trim().split('\n');
  const m = lines.length >= 2 ? [...lines[1].matchAll(/(\d+)m\s*([\d.]+)s/g)] : [];
  if (m.length < 2) return { cpu_user_ms: null, cpu_sys_ms: null };
  const toMs = x => Math.round((parseInt(x[1], 10) * 60 + parseFloat(x[2])) * 1000);
  return { cpu_user_ms: toMs(m[0]), cpu_sys_ms: toMs(m[1]) };
}

// Runs a command. Resolves to the API result shape; never rejects.
function run(command, timeoutMs) {
  const st = init();
  const t0 = process.hrtime.bigint();
  const ms = () => Number((process.hrtime.bigint() - t0) / 1000000n);
  const verdict = policy.check(command, cfg.mode);
  if (!verdict.ok) return Promise.resolve({ stdout: '', stderr: '', exit_code: null, duration_ms: ms(), timed_out: false, truncated: false, blocked: verdict.reason, stdout_bytes: 0, stderr_bytes: 0, cpu_user_ms: null, cpu_sys_ms: null });
  let timeout = Number.isFinite(timeoutMs) ? Math.round(timeoutMs) : LIMITS.timeout_default_ms;
  timeout = Math.max(100, Math.min(LIMITS.timeout_max_ms, timeout));

  const work = fs.mkdtempSync(path.join(cfg.tmpRoot, 'ops-sb-'));
  if (st.isolation.separate_uid) fs.chownSync(work, cfg.uid, cfg.gid != null ? cfg.gid : cfg.uid);
  fs.chmodSync(work, 0o700);

  const argv = [];
  if (st.prlimit) argv.push(st.prlimit, `--cpu=${LIMITS.cpu_seconds}`, `--as=${LIMITS.address_space_bytes}`, `--fsize=${LIMITS.file_size_bytes}`, ...(st.isolation.separate_uid ? [`--nproc=${LIMITS.nproc}`] : []), `--nofile=${LIMITS.nofile}`, '--core=0', '--');
  if (st.ns.length) argv.push(st.unshare, ...st.ns, '--');
  // The command is passed as $1 and eval'd in a subshell, so it cannot alter the wrapper.
  // `times` then reports the CPU time used by the command's processes (to fd 3).
  argv.push('/bin/sh', '-c', 'cd "$HOME" 2>/dev/null; ( eval "$1" ); rc=$?; times >&3 2>/dev/null; exit $rc', 'sandbox', command);

  return new Promise(resolve => {
    const t3 = []; const out = [], err = []; let outN = 0, errN = 0, outKept = 0, errKept = 0, truncated = false, timedOut = false, done = false;
    const child = spawn(argv[0], argv.slice(1), spawnOpts({
      cwd: work, detached: true,
      env: { PATH: st.binDir, HOME: work, TMPDIR: work, LANG: 'C.UTF-8', TERM: 'dumb', USER: 'sandbox' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    }));
    child.stdio[3].on('data', b => { if (t3.reduce((a, x) => a + x.length, 0) < 512) t3.push(b); });
    const take = (buf, arr, cap, kept) => { const room = cap - kept; if (room <= 0) { truncated = true; return kept; } if (buf.length > room) { truncated = true; arr.push(buf.subarray(0, room)); return cap; } arr.push(buf); return kept + buf.length; };
    child.stdout.on('data', b => { outN += b.length; outKept = take(b, out, LIMITS.stdout_cap_bytes, outKept); if (outN + errN > LIMITS.kill_after_bytes) killGroup(child); });
    child.stderr.on('data', b => { errN += b.length; errKept = take(b, err, LIMITS.stderr_cap_bytes, errKept); if (outN + errN > LIMITS.kill_after_bytes) killGroup(child); });
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeout);
    const finish = (code, signal, spawnErr) => {
      if (done) return; done = true; clearTimeout(timer);
      killGroup(child); // reap any background job still in the group
      sweepUid();
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      const sig = signal ? (os.constants.signals[signal] || 9) : null;
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (spawnErr ? `\n[sandbox] spawn failed: ${spawnErr.code || 'error'}` : ''),
        exit_code: spawnErr ? 127 : (code != null ? code : 128 + sig),
        duration_ms: ms(), timed_out: timedOut, truncated, blocked: null,
        stdout_bytes: outN, stderr_bytes: errN, ...cpuTimes(Buffer.concat(t3).toString('utf8')),
      });
    };
    child.on('error', e => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

module.exports = { run, init, LIMITS, cfg, info: () => init().isolation };
