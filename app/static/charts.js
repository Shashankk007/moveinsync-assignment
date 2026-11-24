/* Tiny SVG charts: thin marks, recessive grid, dashed target line, hover tooltip.
   Colours are CSS variables so light/dark switch without redrawing. */
(function () {
  const tip = () => document.getElementById("tooltip");

  function showTip(evt, html) {
    const t = tip();
    t.innerHTML = html;
    t.classList.add("on");
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY - h - pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y < 64) y = evt.clientY + pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }
  function hideTip() { tip().classList.remove("on"); }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  /* opts: labels[], series[{name, color, values[]}], fmt(v), target{value,label}, partialFrom, kind 'line'|'bar', height */
  function chart(el, opts) {
    const W = Math.max(300, Math.round(el.clientWidth || 640)), H = opts.height || 220, L = 40, R = 26, T = 12, B = 26;
    const n = opts.labels.length;
    const all = opts.series.flatMap(s => s.values).filter(v => v != null);
    if (opts.target) all.push(opts.target.value);
    const max = opts.yMax || niceMax(Math.max(...all) * 1.08);
    const fmt = opts.fmt || (v => v);
    const iw = W - L - R, ih = H - T - B;
    const band = iw / n;
    const x = i => opts.kind === "bar" ? L + band * i + band / 2 : L + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
    const y = v => T + ih - (v / max) * ih;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.aria || ""}">`;
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4, yy = y(v);
      s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
      s += `<text class="axis" x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
    }
    const every = Math.ceil(n / 7);
    opts.labels.forEach((lb, i) => {
      if ((n - 1 - i) % every === 0) s += `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${lb}</text>`;
    });
    if (opts.kind === "bar") {
      const bw = Math.min(28, band * 0.62);
      opts.series[0].values.forEach((v, i) => {
        if (v == null) return;
        const top = y(v), h = T + ih - top, r = Math.min(4, h);
        const part = opts.partialFrom != null && i >= opts.partialFrom ? " partial" : "";
        s += `<path class="${part}" style="fill:${opts.series[0].color}" d="M${x(i) - bw / 2},${T + ih} V${top + r} q0,-${r} ${r},-${r} h${bw - 2 * r} q${r},0 ${r},${r} V${T + ih} Z"/>`;
      });
    } else {
      opts.series.forEach(se => {
        let d = "", started = false;
        se.values.forEach((v, i) => {
          if (v == null) { started = false; return; }
          d += `${started ? "L" : "M"}${x(i)},${y(v)} `;
          started = true;
        });
        s += `<path d="${d}" style="fill:none;stroke:${se.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`;
        const last = se.values.length - 1;
        if (se.values[last] != null) s += `<circle cx="${x(last)}" cy="${y(se.values[last])}" r="3.5" style="fill:${se.color};stroke:var(--bg);stroke-width:2"/>`;
      });
    }
    if (opts.target) {
      const ty = y(opts.target.value);
      s += `<line class="target" x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}"/>`;
      s += `<text class="target-label" x="${L + 6}" y="${ty - 6}">${opts.target.label}</text>`;
    }
    s += `<line class="hover-line" x1="0" x2="0" y1="${T}" y2="${T + ih}" style="opacity:0"/>`;
    opts.labels.forEach((_, i) => {
      const x0 = opts.kind === "bar" ? L + band * i : x(i) - iw / (2 * Math.max(n - 1, 1));
      const w = opts.kind === "bar" ? band : iw / Math.max(n - 1, 1);
      s += `<rect class="hit" data-i="${i}" x="${x0}" y="${T}" width="${w}" height="${ih}"/>`;
    });
    s += "</svg>";
    el.innerHTML = s;

    const svg = el.querySelector("svg"), hl = svg.querySelector(".hover-line");
    svg.querySelectorAll(".hit").forEach(r => {
      r.addEventListener("mousemove", e => {
        const i = +r.dataset.i;
        hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i)); hl.style.opacity = 1;
        const rows = opts.series.map(se => `<div class="tt-r"><i style="background:${se.color}"></i>${se.name}<b>${se.values[i] == null ? "–" : fmt(se.values[i], true)}</b></div>`).join("");
        const note = opts.partialFrom != null && i >= opts.partialFrom ? `<div class="tt-r" style="margin-top:4px">Partial week (Mon–Wed)</div>` : "";
        showTip(e, `<div class="tt-h">${opts.tipLabels ? opts.tipLabels[i] : opts.labels[i]}</div>${rows}${note}`);
      });
      r.addEventListener("mouseleave", () => { hl.style.opacity = 0; hideTip(); });
    });
  }

  /* A 96×28 sparkline for table rows. */
  function spark(values, color, target) {
    const W = 96, H = 28, p = 3;
    const vs = values.filter(v => v != null).concat(target != null ? [target] : []);
    const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
    const x = i => p + ((W - 2 * p) * i) / (values.length - 1);
    const y = v => H - p - ((v - lo) / span) * (H - 2 * p);
    let d = "";
    values.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${x(i)},${y(v)} `; });
    const li = values.length - 1;
    let t = target != null ? `<line x1="${p}" x2="${W - p}" y1="${y(target)}" y2="${y(target)}" style="stroke:var(--target);stroke-width:1;stroke-dasharray:3 3;opacity:.5"/>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${t}<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linejoin:round"/><circle cx="${x(li)}" cy="${y(values[li])}" r="2.6" style="fill:${color}"/></svg>`;
  }

  window.Charts = { chart, spark, showTip, hideTip };
})();
