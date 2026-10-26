'use strict';
// Ops Terminal usage panel + audit table. Renders into #opsUsage (terminal page) or
// appends a panel to the main dashboard grid (#main).
(function () {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => typeof v === 'number' && isFinite(v);
  const panel = (cls, title, body, sub = '') => `<section class="p ${cls}" aria-label="${esc(title)}"><h2>${esc(title)}${sub ? `<small>${sub}</small>` : ''}</h2>${body}</section>`;
  const fmtMs = v => num(v) ? (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v + ' ms') : '—';
  const fmtB = v => !num(v) ? '—' : v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : v >= 1024 ? (v / 1024).toFixed(1) + ' KB' : v + ' B';

  function bars(days) {
    if (!days.length) return '<p class="mut">No commands yet.</p>';
    const W = 640, H = 160, L = 30, B = 22, T = 8, R = 6;
    const mx = Math.max(1, ...days.map(d => d.commands));
    const bw = (W - L - R) / days.length;
    let g = `<line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>`;
    for (let i = 0; i <= 2; i++) { const v = Math.round(mx * i / 2), y = T + (1 - i / 2) * (H - T - B); g += `<text x="${L - 4}" y="${y + 3}" text-anchor="end">${v}</text><line class="axis" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" opacity=".3"/>`; }
    days.forEach((d, i) => {
      const w = Math.max(2, Math.min(40, bw * 0.7)), x = L + i * bw + (bw - w) / 2, sc = v => v / mx * (H - T - B);
      const ok = d.ran - d.failures, hOk = sc(ok), hF = sc(d.failures), hB = sc(d.blocked);
      let y = H - B;
      g += `<rect x="${x.toFixed(1)}" y="${(y - hOk).toFixed(1)}" width="${w.toFixed(1)}" height="${hOk.toFixed(1)}" class="b-ok"><title>${esc(d.day)}: ${ok} ok</title></rect>`; y -= hOk;
      g += `<rect x="${x.toFixed(1)}" y="${(y - hF).toFixed(1)}" width="${w.toFixed(1)}" height="${hF.toFixed(1)}" class="b-fail"><title>${esc(d.day)}: ${d.failures} failed</title></rect>`; y -= hF;
      g += `<rect x="${x.toFixed(1)}" y="${(y - hB).toFixed(1)}" width="${w.toFixed(1)}" height="${hB.toFixed(1)}" class="b-block"><title>${esc(d.day)}: ${d.blocked} blocked</title></rect>`;
      if (days.length <= 16 || i % 2 === 0) g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(d.day.slice(5))}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Commands per day">${g}</svg><div class="legend"><span data-c="#2fe08a">ok</span><span data-c="#ff4d61">failed / timed out</span><span data-c="#ffb547">blocked</span></div>`;
  }

  function render(u, compact) {
    const days = u.days || [], today = days.find(d => d.day === u.today) || { commands: 0, ran: 0, failures: 0, blocked: 0, timeouts: 0, avg_duration_ms: null, bytes_out: 0 };
    const tot = days.reduce((a, d) => ({ commands: a.commands + d.commands, failures: a.failures + d.failures, blocked: a.blocked + d.blocked, ran: a.ran + d.ran, durSum: a.durSum + (num(d.avg_duration_ms) ? d.avg_duration_ms * d.ran : 0) }), { commands: 0, failures: 0, blocked: 0, ran: 0, durSum: 0 });
    const avgAll = tot.ran ? Math.round(tot.durSum / tot.ran) : null;
    const kpi = (l, v, d) => panel('c3 kpi', l, `<div class="v">${v}</div><div class="d">${d}</div>`);
    let out = '';
    out += kpi('Commands today', esc(today.commands), `<span class="flat">${esc(tot.commands)} in ${days.length || 0} day(s)</span>`);
    out += kpi('Failures today', `<span class="${today.failures ? 'down' : ''}">${esc(today.failures)}</span>`, `<span class="flat">${esc(today.timeouts)} timed out · ${esc(tot.failures)} total</span>`);
    out += kpi('Blocked today', `<span class="${today.blocked ? 'warn' : ''}">${esc(today.blocked)}</span>`, `<span class="flat">policy + rate limit · ${esc(tot.blocked)} total</span>`);
    out += kpi('Avg duration', esc(fmtMs(today.avg_duration_ms)), `<span class="flat">all days ${esc(fmtMs(avgAll))} · out ${esc(fmtB(today.bytes_out))} · CPU ${esc(fmtMs(today.cpu_ms || 0))} today</span>`);
    out += panel(compact ? 'c12 chart' : 'c5 chart', 'Commands / day', bars(days), 'ET days');
    const rows = (u.recent || []).slice(0, compact ? 8 : 50).map(e => {
      const st = e.status || '';
      const cls = st === 'ok' ? 'running' : (st === 'blocked' || st === 'rate_limited') ? 'other' : st === 'failed' || st === 'timeout' ? 'fail' : 'done';
      return `<tr><td class="nw">${esc((e.ts_et || '').slice(5))}</td><td><code>${esc(e.sid)}</code></td><td class="cmdc" title="${esc(e.command)}">${esc(e.command)}</td><td><span class="pill ${cls}">${esc(st)}</span></td>
        <td class="r">${e.exit_code == null ? '—' : esc(e.exit_code)}</td><td class="r">${esc(fmtMs(e.duration_ms))}</td><td class="r">${esc(fmtB(e.bytes_out))}</td><td class="r">${num(e.cpu_user_ms) ? esc(fmtMs(e.cpu_user_ms + (e.cpu_sys_ms || 0))) : '—'}</td><td class="mut">${esc(e.blocked || '')}</td></tr>`;
    }).join('');
    out += panel(compact ? 'c12' : 'c7', 'Audit log · recent commands', `<div class="scroll audit"><table><thead><tr><th>Time (ET)</th><th>Session</th><th>Command</th><th>Status</th><th class="r">Exit</th><th class="r">Duration</th><th class="r">Out</th><th class="r">CPU</th><th>Blocked reason</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="mut">No commands logged yet.</td></tr>'}</tbody></table></div>`, `newest first · you are <code>${esc(u.you || '')}</code>`);
    return out;
  }
  const paint = root => root.querySelectorAll('.legend span[data-c]').forEach(el => el.style.setProperty('--c', el.dataset.c));

  async function load() {
    let u;
    try { const r = await fetch('/api/ops/usage?days=14', { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) return; u = await r.json(); } catch { return; }
    const host = document.getElementById('opsUsage');
    if (host) { host.innerHTML = render(u, false); paint(host); }
    else {
      const main = document.getElementById('main'); if (!main) return;
      let sec = document.getElementById('opsUsagePanel');
      if (!sec) { sec = document.createElement('div'); sec.id = 'opsUsagePanel'; sec.className = 'c12 subgrid'; main.appendChild(sec); }
      sec.innerHTML = `<section class="p c12 hdr" aria-label="Ops Terminal usage"><h2>Ops Terminal · usage<small><a href="/terminal">open terminal →</a></small></h2></section>` + render(u, true); paint(sec);
    }
    document.dispatchEvent(new CustomEvent('ops-usage', { detail: u }));
  }
  window.ArtemisOpsUsage = { load };
  // on the dashboard, wait for app.js to fill #main first
  setTimeout(load, document.getElementById('opsUsage') ? 0 : 1200);
  setInterval(load, 60 * 1000);
})();
