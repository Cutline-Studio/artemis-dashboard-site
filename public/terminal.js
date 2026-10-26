'use strict';
(function () {
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const out = $('#out'), input = $('#cmd'), btn = $('#runBtn');
  const hist = []; let hi = 0;

  function block(cmd, r, httpCode) {
    const div = document.createElement('div'); div.className = 'entry';
    const chips = [];
    if (r.blocked) chips.push(`<span class="pill other">blocked</span> <span class="warn">${esc(r.blocked)}</span>`);
    else if (r.exit_code != null) chips.push(`<span class="pill ${r.exit_code === 0 ? 'running' : 'fail'}">exit ${esc(r.exit_code)}</span>`);
    if (r.timed_out) chips.push('<span class="pill fail">timed out</span>');
    if (r.truncated) chips.push('<span class="pill other">output truncated</span>');
    if (typeof r.duration_ms === 'number') chips.push(`<span class="mut">${esc(r.duration_ms)} ms</span>`);
    if (r.error && !r.blocked) chips.push(`<span class="down">HTTP ${esc(httpCode)} · ${esc(r.error)}${r.detail ? ' · ' + esc(r.detail) : ''}</span>`);
    div.innerHTML = `<div class="cmdl"><span class="prompt">sandbox:~$</span> ${esc(cmd)}</div>` +
      (r.stdout ? `<pre class="so" aria-label="stdout">${esc(r.stdout)}</pre>` : '') +
      (r.stderr ? `<pre class="se" aria-label="stderr">${esc(r.stderr)}</pre>` : '') +
      `<div class="meta">${chips.join(' ')}</div>`;
    out.appendChild(div); out.scrollTop = out.scrollHeight;
  }

  async function run(cmd) {
    btn.disabled = true; input.disabled = true;
    let r, code = 0;
    try {
      const res = await fetch('/api/ops/exec', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Artemis-Ops': '1' }, body: JSON.stringify({ command: cmd, timeout: parseInt($('#tmo').value, 10) }) });
      code = res.status;
      if (res.status === 401) { location.href = '/login'; return; }
      r = await res.json();
    } catch (e) { r = { error: 'network error' }; }
    block(cmd, r, code);
    btn.disabled = false; input.disabled = false; input.focus();
    if (window.ArtemisOpsUsage) window.ArtemisOpsUsage.load();
  }

  $('#tform').addEventListener('submit', e => {
    e.preventDefault();
    const cmd = input.value.trim(); if (!cmd) return;
    hist.push(cmd); hi = hist.length; input.value = '';
    if (cmd === 'clear') { out.innerHTML = ''; return; }
    run(cmd);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });

  document.addEventListener('ops-usage', ev => {
    const u = ev.detail || {}, sb = u.sandbox || {}, iso = sb.isolation || {}, L = sb.limits || {}, rl = u.rate_limits || {};
    const ok = sb.mode === 'runner' || /in-process/.test(sb.mode || '');
    $('#sbMode').textContent = sb.mode || '—';
    $('#sbLive').classList.toggle('stale', !ok || !iso.separate_uid);
    const kb = v => typeof v === 'number' ? Math.round(v / 1024) + ' KB' : '—', mb = v => typeof v === 'number' ? Math.round(v / 1048576) + ' MB' : '—';
    const row = (k, v, cls = '') => `<dt>${esc(k)}</dt><dd class="${cls}">${esc(v)}</dd>`;
    $('#limits').innerHTML = `<dl class="kv">
      ${row('Status', sb.mode + (sb.reason ? ' · ' + sb.reason : ''), ok ? 'up' : 'down')}
      ${row('Separate uid', iso.separate_uid ? 'yes (uid ' + iso.sandbox_uid + ')' : 'NO (same uid as server)', iso.separate_uid ? 'up' : 'down')}
      ${row('Namespaces', iso.namespaces || '—', iso.namespaces && iso.namespaces !== 'none' ? 'up' : 'warn')}
      ${row('Network', iso.namespaces && iso.namespaces.includes('net') ? 'none (empty net namespace)' : 'deny-list only', iso.namespaces && iso.namespaces.includes('net') ? 'up' : 'warn')}
      ${row('Policy', iso.policy || '—')}
      ${row('Timeout', (L.timeout_default_ms || '—') + ' ms default · max ' + (L.timeout_max_ms || '—') + ' ms')}
      ${row('Output cap', kb(L.stdout_cap_bytes) + ' stdout · ' + kb(L.stderr_cap_bytes) + ' stderr')}
      ${row('CPU / memory', (L.cpu_seconds || '—') + ' s CPU · ' + mb(L.address_space_bytes) + ' address space')}
      ${row('Processes / files', (L.nproc || '—') + ' procs · ' + (L.nofile || '—') + ' fds · ' + mb(L.file_size_bytes) + ' max file')}
      ${row('Rate limit', (rl.per_minute || '—') + '/min · ' + (rl.per_day || '—') + '/day per session')}
      ${row('Env', iso.env || '—')}
    </dl>${iso.namespace_note ? `<p class="warn">${esc(iso.namespace_note)}</p>` : ''}`;
  });
})();
