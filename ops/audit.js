'use strict';
// Ops Terminal audit log + usage metrics. One JSON object per command, stored as
// JSON Lines per ET day (`ops-audit-YYYY-MM-DD.jsonl`) through the app's existing
// store (private blob container via SAS, or local data dir). Also mirrored to
// stdout as `{"type":"ops_audit",...}` so Container Apps log streaming keeps a copy.
const RETAIN_DAYS = 30;
const MAX_PER_DAY = 5000;
const FLUSH_MS = 1500;
const NAME_RE = /^ops-audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const etDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function etStamp(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}

function createAudit(store) {
  const days = new Map(); // day -> array of entries
  const dirty = new Set();
  let timer = null, flushing = Promise.resolve();

  async function load() {
    try {
      const names = (await store.list()).filter(n => NAME_RE.test(n)).sort().slice(-RETAIN_DAYS);
      for (const n of names) {
        const t = await store.get(n); if (!t) continue;
        days.set(n.match(NAME_RE)[1], t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
      console.log(`ops audit loaded: ${days.size} day(s)`);
    } catch (e) { console.error('ops audit load failed:', e.message); }
  }

  async function flush() {
    const todo = [...dirty]; dirty.clear();
    for (const d of todo) {
      try { await store.put(`ops-audit-${d}.jsonl`, days.get(d).map(e => JSON.stringify(e)).join('\n') + '\n'); }
      catch (e) { dirty.add(d); console.error('ops audit flush failed:', e.message); }
    }
    const all = [...days.keys()].sort();
    while (all.length > RETAIN_DAYS) { const old = all.shift(); days.delete(old); try { await store.del(`ops-audit-${old}.jsonl`); } catch {} }
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; flushing = flushing.then(flush); }, FLUSH_MS); }
  async function flushNow() { if (timer) { clearTimeout(timer); timer = null; } flushing = flushing.then(flush); return flushing; }

  function record(e) {
    const now = new Date();
    const entry = { ts: now.toISOString(), ts_et: etStamp(now), ...e };
    const d = etDay(now);
    if (!days.has(d)) days.set(d, []);
    const arr = days.get(d);
    if (arr.length < MAX_PER_DAY) arr.push(entry); else if (arr.length === MAX_PER_DAY) arr.push({ ...entry, command: '[audit day cap reached; further entries only on stdout]' });
    dirty.add(d); schedule();
    console.log(JSON.stringify({ type: 'ops_audit', ...entry }));
    return entry;
  }

  function usage(nDays = 14, recentN = 50) {
    const keys = [...days.keys()].sort().slice(-nDays);
    const per = keys.map(day => {
      const es = days.get(day);
      const ran = es.filter(e => !e.blocked);
      const fails = ran.filter(e => e.exit_code !== 0);
      const dur = ran.map(e => e.duration_ms).filter(Number.isFinite);
      return {
        day, commands: es.length, ran: ran.length, failures: fails.length,
        timeouts: ran.filter(e => e.timed_out).length, blocked: es.filter(e => e.blocked).length,
        avg_duration_ms: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) : null,
        bytes_out: ran.reduce((a, e) => a + (e.bytes_out || 0), 0),
        cpu_ms: ran.reduce((a, e) => a + (e.cpu_user_ms || 0) + (e.cpu_sys_ms || 0), 0),
        runs: new Set(es.map(e => e.run_id).filter(Boolean)).size,
        tokens_in: es.reduce((a, e) => a + (e.tokens_in || 0), 0), tokens_out: es.reduce((a, e) => a + (e.tokens_out || 0), 0),
      };
    });
    const recent = [];
    for (const day of [...days.keys()].sort().reverse()) { for (const e of [...days.get(day)].reverse()) { recent.push(e); if (recent.length >= recentN) break; } if (recent.length >= recentN) break; }
    return { days: per, recent, today: etDay(new Date()) };
  }

  return { load, record, usage, flushNow };
}

module.exports = { createAudit, etStamp };
