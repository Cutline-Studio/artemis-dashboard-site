'use strict';
(function () {
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => typeof v === 'number' && isFinite(v);
  const usd = (v, d = 2) => num(v) ? '$' + v.toFixed(d) : '—';
  const f = (v, d = 3) => num(v) ? v.toFixed(d) : '—';
  const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const COLORS = ['#5ad1ff', '#2fe08a', '#ffb547', '#c78bff', '#ff7aa8', '#9ef0ff', '#f5f07a'];

  // delta: lowerIsBetter flips colouring
  function delta(cur, prev, { lowerIsBetter = false, d = 3, money = false } = {}) {
    if (!num(cur) || !num(prev)) return '<span class="flat">— no prior day</span>';
    const x = cur - prev;
    if (Math.abs(x) < 1e-9) return '<span class="flat">▬ 0</span>';
    const good = lowerIsBetter ? x < 0 : x > 0;
    const s = (x > 0 ? '▲ +' : '▼ ') + (money ? '$' : '') + x.toFixed(d);
    return `<span class="${good ? 'up' : 'down'}">${esc(s)}</span>`;
  }
  function spark(values, color = '#5ad1ff', w = 120, h = 28) {
    const v = values.filter(num);
    if (v.length < 2) return '';
    const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
    const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y - mn) / r * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
  }
  function lineChart(series, { logY = false, xLabel = 'step', yLabel = 'loss' } = {}) {
    const W = 640, H = 220, L = 44, R = 10, T = 10, B = 26;
    const all = series.flatMap(s => s.pts).filter(p => num(p[0]) && num(p[1]) && (!logY || p[1] > 0));
    if (all.length < 2) return '<p class="mut">Not enough points to chart.</p>';
    const ty = y => logY ? Math.log10(y) : y;
    const xs = all.map(p => p[0]), ys = all.map(p => ty(p[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const sx = x => L + (x - x0) / ((x1 - x0) || 1) * (W - L - R);
    const sy = y => T + (1 - (ty(y) - y0) / ((y1 - y0) || 1)) * (H - T - B);
    let g = `<line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>`;
    for (let i = 0; i <= 4; i++) {
      const yv = y0 + (y1 - y0) * i / 4, real = logY ? Math.pow(10, yv) : yv, py = T + (1 - i / 4) * (H - T - B);
      g += `<line class="axis" x1="${L}" y1="${py}" x2="${W - R}" y2="${py}" opacity=".35"/><text x="${L - 4}" y="${py + 3}" text-anchor="end">${esc(real.toFixed(real < 10 ? 2 : 1))}</text>`;
    }
    g += `<text x="${L}" y="${H - 8}">${esc(Math.round(x0))}</text><text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(Math.round(x1))} ${esc(xLabel)}</text>`;
    series.forEach((s, i) => {
      const pts = s.pts.filter(p => num(p[0]) && num(p[1]) && (!logY || p[1] > 0)).map(p => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
      g += `<polyline fill="none" stroke="${s.color || COLORS[i % COLORS.length]}" stroke-width="1.6" points="${pts}"/>`;
    });
    const leg = series.map((s, i) => `<span data-c="${s.color || COLORS[i % COLORS.length]}">${esc(s.name)}</span>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}">${g}</svg><div class="legend">${leg}</div>`;
  }
  const panel = (cls, title, body, sub = '') => `<section class="p ${cls}" aria-label="${esc(title)}"><h2>${esc(title)}${sub ? `<small>${sub}</small>` : ''}</h2>${body}</section>`;

  function render(data) {
    const s = data.latest;
    const hist = (data.history || []).map(h => h.snapshot);
    if (!s) { $('#main').innerHTML = '<p class="mut pad">No snapshot has been pushed yet. Run push.sh on the box.</p>'; return; }
    // previous day's snapshot (for deltas)
    const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    const H = path => hist.map(x => get(x, path));

    // as-of
    $('#asof').textContent = s.as_of || '—';
    if (num(s.as_of_epoch)) {
      const ageH = (Date.now() / 1000 - s.as_of_epoch) / 3600;
      $('#age').textContent = ageH < 1 ? `(${Math.round(ageH * 60)} min ago)` : `(${ageH.toFixed(1)} h ago)`;
      if (ageH > 26) { document.querySelector('.live').classList.add('stale'); $('#age').classList.add('warn'); }
    }

    const vast = s.vast || {}, runs = s.runs || [], tr = s.training || {}, ex = s.expand || {}, repo = s.repo || {}, box = s.box || {};
    const totalBilled = num(vast.charges_total) ? vast.charges_total : runs.reduce((a, r) => a + (num(r.billed) ? r.billed : 0), 0);
    const running = runs.filter(r => r.status === 'running');
    const activeGpus = running.reduce((a, r) => a + (num(get(r, 'instance.num_gpus')) ? r.instance.num_gpus : (r.gpus_planned || 0)), 0);
    const burn = running.reduce((a, r) => a + (num(get(r, 'instance.dph_total')) ? r.instance.dph_total : 0), 0);
    const evals = tr.eval_local || {};
    const bestBpb = Object.values(evals).map(e => e.artemis_val_bpb).filter(num);
    const best = bestBpb.length ? Math.min(...bestBpb) : undefined;
    const cyc = (ex.cycles || []);
    const lastCyc = cyc[cyc.length - 1] || {};
    const t = repo.tests || {};
    const testsOk = t.exit === 0;
    const memUsed = num(box.mem_total_gb) && num(box.mem_available_gb) ? box.mem_total_gb - box.mem_available_gb : undefined;

    // ticker
    const tk = [['VAST CREDIT', usd(vast.credit), delta(vast.credit, get(prev, 'vast.credit'), { d: 2, money: true })],
      ['TOTAL BILLED', usd(totalBilled, 3), ''], ['BURN', num(burn) ? usd(burn, 3) + '/h' : '—', ''], ['GPUS LIVE', String(activeGpus), '']];
    runs.forEach(r => tk.push([String(r.key || r.name).toUpperCase(), `${usd(r.spend, 3)} / ${usd(r.cap)}`, `<span class="${r.status === 'running' ? 'up' : 'flat'}">${esc(r.status || '')}</span>`]));
    if (num(best)) tk.push(['BEST ARTEMIS BPB', f(best), '']);
    if (num(lastCyc.loss)) tk.push(['EXPAND C' + lastCyc.cycle, f(lastCyc.loss, 4), '']);
    tk.push(['TESTS', esc(t.summary || '—'), `<span class="${testsOk ? 'up' : 'down'}">${testsOk ? 'PASS' : 'exit ' + esc(t.exit)}</span>`]);
    if (Array.isArray(box.load)) tk.push(['BOX LOAD', box.load.map(x => f(x, 2)).join(' '), '']);
    const tkHtml = tk.map(([k, v, d]) => `<span class="tk"><b>${esc(k)}</b>${esc(v)} ${d}</span>`).join('');
    $('#ticker').innerHTML = tkHtml + tkHtml.replace(/class="tk"/g, 'class="tk" aria-hidden="true"');

    let out = '';
    // KPIs
    const kpi = (l, v, d, sp) => panel('c2 kpi', l, `<div class="v">${v}</div><div class="d">${d}</div>${sp || ''}`);
    out += kpi('Vast credit', esc(usd(vast.credit)), delta(vast.credit, get(prev, 'vast.credit'), { d: 2, money: true }), spark(H('vast.credit')));
    out += kpi('Billed to date', esc(usd(totalBilled, 3)), num(burn) && burn > 0 ? `<span class="warn">burn ${esc(usd(burn, 3))}/h</span>` : '<span class="flat">no live burn</span>', spark(H('vast.charges_total'), '#ffb547'));
    out += kpi('GPUs live', esc(activeGpus), `<span class="${running.length ? 'up' : 'flat'}">${running.length} run(s) running</span>`);
    out += kpi('Best Artemis bpb', esc(f(best)), '<span class="flat">held-out, lower is better</span>');
    out += kpi('Expand loop', esc(lastCyc.cycle != null ? 'cycle ' + lastCyc.cycle : '—'), `loss ${esc(f(lastCyc.loss, 4))} · next ${esc(ex.next_cycle ?? '—')}`, spark(cyc.map(c => c.loss), '#2fe08a'));
    out += kpi('Tests', `<span class="${testsOk ? 'up' : 'down'}">${testsOk ? 'PASS' : 'FAIL'}</span>`, esc(t.summary || '—'));

    // GPU desk
    let rows = runs.map(r => {
      const i = r.instance || {};
      const pct = num(r.spend) && num(r.cap) && r.cap > 0 ? r.spend / r.cap * 100 : 0;
      const st = r.status === 'running' ? 'running' : (r.status === 'destroyed' ? 'destroyed' : 'other');
      return `<tr><td>${esc(r.name)}<br><span class="mut">#${esc(r.instance_id || '—')}</span></td><td><span class="pill ${st}">${esc(r.status || '?')}</span></td>
      <td class="r">${esc(i.num_gpus ?? r.gpus_planned ?? '—')}× ${esc(i.gpu_name || '')}</td><td class="r">${num(i.dph_total) ? esc(usd(i.dph_total, 3)) : '—'}</td>
      <td class="r">${esc(usd(r.billed, 3))}${num(r.accrued_estimate) ? `<br><span class="mut">accrued est. ${esc(usd(r.accrued_estimate, 3))}</span>` : ''}</td>
      <td class="r">${esc(usd(r.cap))}</td><td><div class="bar"><i data-w="${Math.min(100, pct).toFixed(1)}" class="${pct > 100 ? 'over' : pct > 75 ? 'hot' : ''}"></i></div><span class="mut">${pct.toFixed(1)}% of cap</span></td>
      <td>${esc(r.hard_kill || '—')}${num(r.worst_case_at_hard_kill_estimate) ? `<br><span class="mut">worst case est. ${esc(usd(r.worst_case_at_hard_kill_estimate))}</span>` : ''}</td></tr>`;
    }).join('');
    const other = s.other_charges || {};
    Object.entries(other).forEach(([id, amt]) => { rows += `<tr><td class="mut">Other charge #${esc(id)}</td><td></td><td></td><td></td><td class="r">${esc(usd(amt, 3))}</td><td></td><td></td><td></td></tr>`; });
    out += panel('c12', 'GPU desk · Vast.ai', `<div class="scroll"><table><thead><tr><th>Run</th><th>Status</th><th class="r">GPUs</th><th class="r">$/h</th><th class="r">Billed</th><th class="r">Cap</th><th>Spend vs cap</th><th>Hard kill (ET)</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="mut">No runs</td></tr>'}</tbody></table></div>`,
      `credit ${esc(usd(vast.credit))} · auto-recharge ${vast.autobill ? 'ON' : 'off'}`);

    // Training loss chart (tabs)
    const curves = Object.entries(tr).filter(([, v]) => v && Array.isArray(v.points) && v.points.length > 1);
    out += panel('c7 chart', 'Training loss', `<div class="tabs" role="group" aria-label="Choose run">${curves.map(([k], i) => `<button type="button" data-run="${esc(k)}" aria-pressed="${i === 0}">${esc(k)}</button>`).join('')}</div><div id="lossChart"></div>`, 'log scale · from training logs');

    // Eval scoreboard
    const evRows = Object.entries(evals).map(([k, e]) => `<tr><td>${esc(k)}</td><td class="r">${esc(num(e.params) ? (e.params / 1e6).toFixed(1) + 'M' : '—')}</td><td>${esc(e.tokenizer || '')}</td><td class="r ${e.artemis_val_bpb === best ? 'up' : ''}">${esc(f(e.artemis_val_bpb))}</td><td class="r">${esc(f(e.web_val_60KB_bpb))}</td></tr>`).join('');
    const sm = get(tr, 'gpu_run1.summary') || {};
    let ba = '';
    ['before', 'after_stage1', 'after_stage2'].forEach(k => { if (sm[k]) ba += `<tr><td>${esc(k.replace('_', ' '))}</td><td class="r">${esc(f(sm[k].web_val_bpb, 4))}</td><td class="r">${esc(f(sm[k].artemis_val_bpb, 4))}</td><td class="r">${esc(f(sm[k].sft_val_nll, 4))}</td></tr>`; });
    out += panel('c5', 'Eval scoreboard', `<div class="scroll"><table><thead><tr><th>Checkpoint</th><th class="r">Params</th><th>Tok</th><th class="r">Artemis bpb</th><th class="r">Web bpb</th></tr></thead><tbody>${evRows || '<tr><td colspan="5" class="mut">No evals</td></tr>'}</tbody></table></div>
      ${ba ? `<h2 class="mt">GPU run 1 · before → after<small>${esc(sm.gpu || '')}</small></h2><table><thead><tr><th>Stage</th><th class="r">Web bpb</th><th class="r">Artemis bpb</th><th class="r">SFT nll</th></tr></thead><tbody>${ba}</tbody></table>` : ''}`, 'lower is better');

    // Expand loop
    const caps = ex.caps || {}, sup = ex.supervisor_events || {};
    out += panel('c6 chart', 'Expand loop · artemis-567885', `<div id="expandChart"></div><dl class="kv">
      <dt>Branch / commit</dt><dd>${esc(ex.branch || '—')} @ ${esc(get(ex, 'commit.hash') || '—')}</dd>
      <dt>Layers</dt><dd>${esc(lastCyc.layers ?? '—')} / cap ${esc(caps.num_layers_max ?? '—')}</dd>
      <dt>Capacity factor</dt><dd>${esc(lastCyc.cf ?? '—')} / cap ${esc(caps.capacity_factor_max ?? '—')}</dd>
      <dt>Experts</dt><dd>${esc(lastCyc.experts ?? '—')}</dd>
      <dt>Last cycle</dt><dd>${esc(lastCyc.time || '—')}</dd>
      <dt>Supervisor</dt><dd>${Object.entries(sup).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ') || '—'}</dd></dl>`, esc(get(ex, 'commit.date') || ''));

    // Repo
    const commits = (repo.commits || []).slice(0, 8).map(c => `<li><b>${esc(c.hash)}</b> <span class="mut">${esc((c.date || '').slice(0, 16))}</span> ${esc(c.subject)}</li>`).join('');
    out += panel('c3', 'Repo · ' + (repo.branch || ''), `<dl class="kv"><dt>Uncommitted</dt><dd>${esc(repo.uncommitted_files ?? '—')}</dd><dt>Docs tracked</dt><dd>${esc(repo.md_docs_tracked ?? '—')}</dd>
      <dt>Tests</dt><dd class="${testsOk ? 'up' : 'down'}">${esc(t.summary || '—')}</dd><dt>Ran</dt><dd>${esc(t.when || '—')}</dd></dl><ul class="commits">${commits}</ul>`, 'local only');

    // Box health
    const g = (lbl, used, total, unit) => { const pct = num(used) && num(total) && total ? used / total * 100 : 0; return `<div class="gauge"><div class="lbl"><span>${esc(lbl)}</span><span>${esc(f(used, 1))} / ${esc(f(total, 1))} ${unit}</span></div><div class="bar"><i data-w="${pct.toFixed(1)}" class="${pct > 90 ? 'over' : pct > 75 ? 'hot' : ''}"></i></div></div>`; };
    out += panel('c3', 'Box health', `${g('Memory', memUsed, box.mem_total_gb, 'GB')}${g('Disk', num(box.disk_total_gb) && num(box.disk_free_gb) ? box.disk_total_gb - box.disk_free_gb : undefined, box.disk_total_gb, 'GB')}
      ${g('Load (1m)', Array.isArray(box.load) ? box.load[0] : undefined, box.cpus, 'CPUs')}<dl class="kv"><dt>Uptime</dt><dd>${esc(f(box.uptime_h, 1))} h</dd><dt>Disk free</dt><dd class="${box.disk_free_gb < 15 ? 'warn' : ''}">${esc(f(box.disk_free_gb, 1))} GB</dd></dl>`);

    // 30-day trend
    const days = (data.history || []).map(h => h.day);
    out += panel('c6 chart', '30-day trend', hist.length >= 2 ? `<div id="trendChart"></div>` : `<p class="mut">Trend fills in as daily snapshots arrive (${hist.length} day${hist.length === 1 ? '' : 's'} so far, keeps 30).</p>`, days.length ? esc(days[0] + ' → ' + days[days.length - 1]) : '');

    // Sample answers
    const samples = Object.entries(evals).map(([k, e]) => `<details><summary>${esc(k)}</summary>${Object.entries(e.samples || {}).map(([q, a]) => `<div class="sample"><span class="mut">Q:</span> ${esc(q)}<br><span class="mut">A:</span> <q>${esc(a)}</q></div>`).join('')}</details>`).join('');
    out += panel('c12', 'Sample answers', samples || '<p class="mut">None</p>', 'verbatim model output from eval prompts');

    $('#main').innerHTML = out;
    // apply widths/colours via CSSOM (CSP-safe)
    document.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });

    const drawLoss = key => {
      const pts = (tr[key].points || []);
      const stages = [...new Set(pts.map(p => p.stage))];
      $('#lossChart').innerHTML = lineChart(stages.map((st, i) => ({ name: `${key} · stage ${st}`, color: COLORS[i], pts: pts.filter(p => p.stage === st).map(p => [p.step, p.loss]) })), { logY: true });
      paintLegend();
    };
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      drawLoss(b.dataset.run);
    }));
    if (curves.length) drawLoss(curves[0][0]);
    $('#expandChart').innerHTML = lineChart([{ name: 'loss per cycle', color: '#2fe08a', pts: cyc.map(c => [c.cycle, c.loss]) }, ], { logY: true, xLabel: 'cycle' });
    if (hist.length >= 2 && $('#trendChart')) {
      $('#trendChart').innerHTML = lineChart([
        { name: 'Vast credit $', color: '#5ad1ff', pts: hist.map((x, i) => [i, get(x, 'vast.credit')]) },
        { name: 'Billed $', color: '#ffb547', pts: hist.map((x, i) => [i, get(x, 'vast.charges_total')]) }], { xLabel: 'day', yLabel: 'USD' });
    }
    paintLegend();
  }
  function paintLegend() { document.querySelectorAll('.legend span[data-c]').forEach(el => el.style.setProperty('--c', el.dataset.c)); }

  async function load() {
    try {
      const r = await fetch('/api/snapshot', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { location.href = '/login'; return; }
      render(await r.json());
    } catch (e) { $('#main').innerHTML = '<p class="down pad">Could not load the snapshot.</p>'; }
  }
  load();
  setInterval(load, 5 * 60 * 1000);
})();
