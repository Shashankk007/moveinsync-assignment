/* RideOps v0 frontend. Plain JS; every number comes from the Python API (app/server.py). */
(function () {
  const $ = s => document.querySelector(s);
  const app = $("#app");
  const api = (path, body) => fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
    .then(async r => { if (!r.ok) throw new Error((await r.json()).detail || r.statusText); return r.json(); });
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = v => v == null ? "–" : Math.round(v * 100) + "%";
  const fmtH = h => h == null ? "–" : h < 48 ? Math.round(h) + " hours" : (h / 24).toFixed(1) + " days";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtD = iso => { const d = new Date(iso); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const fmtDT = iso => { const d = new Date(iso); return `${fmtD(iso)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const ago = iso => { const h = (new Date(META.as_of) - new Date(iso)) / 36e5; return h < 1 ? "just now" : h < 24 ? Math.round(h) + "h ago" : Math.round(h / 24) + "d ago"; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const I = {
    alert: '<svg viewBox="0 0 20 20"><path d="M10 2.5 18.5 17h-17L10 2.5Z"/><path d="M10 8v4M10 14.6v.1"/></svg>',
    check: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><path d="m6.6 10.2 2.3 2.3 4.6-4.8"/></svg>',
    clock: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><path d="M10 5.6V10l3 2"/></svg>',
    route: '<svg viewBox="0 0 20 20"><circle cx="4.5" cy="15.5" r="2"/><circle cx="15.5" cy="4.5" r="2"/><path d="M6.5 15.5h5.3a3 3 0 0 0 0-6H8.2a3 3 0 0 1 0-6h5.3"/></svg>',
    up: '<svg viewBox="0 0 20 20"><path d="m2.5 14 5-5 3.5 3.5 6-6.5"/><path d="M12.5 6h4.5v4.5"/></svg>',
    left: '<svg viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>',
    right: '<svg viewBox="0 0 20 20"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>',
    copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M13 7V5.5A2.5 2.5 0 0 0 10.5 3h-5A2.5 2.5 0 0 0 3 5.5v5A2.5 2.5 0 0 0 5.5 13H7"/></svg>',
  };
  const DECISIONS = [
    ["Escalate to engineering", "Send it with the engineering note"],
    ["Resolved at L1 (config / how-to fixed)", "A setting or a how-to answer fixed it"],
    ["Linked to known engineering issue", "Attach it to the existing engineering ticket"],
    ["Asked client for missing information", "Wait for the details engineering needs"],
    ["Routed to another team (ops / product / compliance)", "This category belongs to another team"],
  ];
  const ESCALATE = DECISIONS[0][0];
  const STEPS = ["History", "Known issue", "Checklist", "Decide"];

  let META = null;
  const S = {
    view: "check", pickMode: "queue", lists: {}, search: "", shown: 30,
    c: null, step: 1, checks: [], fields: {}, decision: ESCALATE, override: "", logged: false, revealed: false,
    scTab: "overview", sc: null, log: null,
  };

  /* ---------------------------------------------------------------- shell: theme, nav, toast */
  function syncModeLabel() { $("#mode-label").textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark"; }
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    syncModeLabel();
  });
  syncModeLabel();
  document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.view)));
  function go(view, tab) {
    S.view = view;
    if (tab) S.scTab = tab;
    document.querySelectorAll(".nav button").forEach(b => b.dataset.view === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
    history.replaceState(null, "", view === "scorecard" ? `#scorecard/${S.scTab}` : "#check");
    render();
    scrollTo(0, 0);
  }
  function toast(msg) { const t = $("#toast"); t.innerHTML = I.check.replace("<svg", '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"') + esc(msg); t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2400); }
  function render() { if (S.view === "scorecard") return renderScorecard(); S.c ? renderFlow() : renderPicker(); }

  /* ================================================================ 1 · ticket picker */
  const HINT = {
    queue: "Tickets open with L1 right now.",
    replay: "Past escalations. The check runs as if it were the moment each ticket was raised; at the end you can see what really happened.",
    new: "Describe a ticket that has just come in.",
  };
  function renderPicker() {
    const m = S.pickMode;
    app.innerHTML = `<div class="wrap">
      <div class="pick-head">
        <p class="eyebrow">Escalation check</p>
        <h1 class="title">Which ticket are you checking?</h1>
        <p class="lede">Run this before a ticket goes to engineering. It takes a minute, and it stops tickets coming back as config issues or missing information.</p>
      </div>
      <div class="pick-controls">
        <div class="seg" role="group" aria-label="Ticket source">
          <button data-m="queue" aria-pressed="${m === "queue"}">My queue<span class="n">${S.lists.queue.length}</span></button>
          <button data-m="replay" aria-pressed="${m === "replay"}">Replay<span class="n">${S.lists.replay.length}</span></button>
          <button data-m="new" aria-pressed="${m === "new"}">New ticket</button>
        </div>
        ${m === "new" ? "" : `<input class="input" id="search" type="search" placeholder="Search ID, client or issue" value="${esc(S.search)}" aria-label="Search tickets">`}
      </div>
      <p class="hint">${HINT[m]}</p>
      ${m === "new" ? newForm() : `<ul class="tickets" id="ticket-list"></ul><div id="more"></div>`}
    </div>`;
    app.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { S.pickMode = b.dataset.m; S.search = ""; S.shown = 30; renderPicker(); }));
    if (m === "new") {
      $("#new-form").addEventListener("submit", e => {
        e.preventDefault();
        start({ category: $("#nf-cat").value, priority: $("#nf-prio").value, client_name: $("#nf-client").value, description: $("#nf-desc").value });
      });
    } else {
      $("#search").addEventListener("input", e => { S.search = e.target.value.toLowerCase(); S.shown = 30; renderList(); });
      renderList();
    }
  }
  function newForm() {
    return `<form class="new-card" id="new-form">
      <label class="label">What the client reported<textarea class="input" id="nf-desc" rows="3" required>Cancelled bookings still appearing in tomorrow's roster</textarea></label>
      <label class="label">Category<select class="input" id="nf-cat">${META.categories.map(c => `<option ${c.startsWith("Roster") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <div class="row">
        <label class="label">Priority<select class="input" id="nf-prio"><option>P1</option><option>P2</option><option selected>P3</option><option>P4</option></select></label>
        <label class="label">Client<select class="input" id="nf-client">${META.clients.map(c => `<option>${esc(c)}</option>`).join("")}</select></label>
      </div>
      <div><button class="btn btn-primary" type="submit">Start the check ${I.right}</button></div>
    </form>`;
  }
  function renderList() {
    const all = S.lists[S.pickMode].filter(t => !S.search || `${t.ticket_id} ${t.client_name} ${t.description} ${t.category}`.toLowerCase().includes(S.search));
    const list = all.slice(0, S.shown);
    $("#ticket-list").innerHTML = list.length ? list.map(t => `<li><button data-id="${t.ticket_id}">
        <span class="t-desc">${esc(t.description)}</span>
        <span class="t-meta"><span class="mono">${t.ticket_id}</span> · ${esc(t.client_name)} · ${S.pickMode === "queue" ? ago(t.created_at) : fmtD(t.created_at)}</span>
        <span class="t-side"><span class="prio ${t.priority.toLowerCase()}">${t.priority}</span><svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg></span>
      </button></li>`).join("") : `<li class="empty"><h3>No tickets match</h3>Try another ID, client or issue.</li>`;
    $("#ticket-list").querySelectorAll("button[data-id]").forEach(b => b.addEventListener("click", () => start({ ticket_id: b.dataset.id, replay: S.pickMode === "replay" })));
    $("#more").innerHTML = all.length > S.shown ? `<button class="btn more">Show ${Math.min(30, all.length - S.shown)} more of ${all.length - S.shown}</button>` : "";
    if (all.length > S.shown) $("#more button").addEventListener("click", () => { S.shown += 30; renderList(); });
  }

  /* ================================================================ 2 · the check, one step at a time */
  async function start(body) {
    try {
      const c = await api("/api/check", body);
      Object.assign(S, { c, step: 1, checks: c.checks.map(() => false), fields: Object.fromEntries(c.fields.map(f => [f, ""])), override: "", logged: false, revealed: false });
      S.decision = !c.is_engineering ? DECISIONS[4][0] : c.known_issue.length ? DECISIONS[2][0] : ESCALATE;
      renderFlow();
      scrollTo(0, 0);
    } catch (err) { toast(err.message); }
  }
  const ready = () => {
    const c = S.c, cd = S.checks.filter(Boolean).length, fd = Object.values(S.fields).filter(v => v.trim()).length;
    return { cd, ct: c.checks.length, fd, ft: c.fields.length, ok: cd === c.checks.length && fd === c.fields.length };
  };

  function renderFlow() {
    const c = S.c, t = c.ticket;
    app.innerHTML = `<div class="wrap"><div class="flow">
      <div class="flow-top">
        <button class="back-link" id="back-list">${I.left}All tickets</button>
        <div class="ctx"><span>${t.ticket_id ? `<span class="mono">${t.ticket_id}</span>` : "New ticket"} · ${esc(t.client_name || "")} · ${esc(t.category)} · ${t.priority}</span><span class="step-of">Step ${S.step} of 4</span></div>
        <div class="progress">${STEPS.map((s, i) => `<button data-s="${i + 1}" class="${i + 1 < S.step ? "done" : i + 1 === S.step ? "current" : ""}" aria-label="Step ${i + 1}: ${s}"><div class="bar"><i></i></div><span>${s}</span></button>`).join("")}</div>
        ${c.replay ? `<div class="replay-note">${I.clock.replace("<svg", '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"')}Replay: only what was known on ${fmtDT(c.as_of)}</div>` : ""}
      </div>
      <section class="step" id="step">${[step1, step2, step3, step4][S.step - 1]()}</section>
      <div class="flow-nav">
        <button class="btn" id="prev">${S.step === 1 ? "Cancel" : `${I.left}Back`}</button>
        <div id="next-wrap"></div>
      </div>
    </div></div>`;
    $("#back-list").onclick = () => { S.c = null; renderPicker(); };
    app.querySelectorAll(".progress button").forEach(b => b.addEventListener("click", () => goStep(+b.dataset.s)));
    $("#prev").onclick = () => S.step === 1 ? (S.c = null, renderPicker()) : goStep(S.step - 1);
    wireStep();
    renderNext();
  }
  function goStep(n) { S.step = n; renderFlow(); scrollTo(0, 0); }

  function renderNext() {
    const w = $("#next-wrap");
    if (S.step < 4) {
      const lbl = S.step === 3 ? (ready().ok ? "Continue" : `Continue · ${ready().cd + ready().fd} of ${ready().ct + ready().ft} done`) : "Continue";
      w.innerHTML = `<button class="btn btn-primary" id="next">${lbl}${I.right}</button>`;
      $("#next").onclick = () => goStep(S.step + 1);
    } else {
      const r = ready(), blocked = S.decision === ESCALATE && !r.ok && !S.override.trim();
      w.innerHTML = `<button class="btn btn-primary" id="log" ${blocked || S.logged ? "disabled" : ""}>${S.logged ? "Decision logged" : "Log decision"}</button>`;
      $("#log").onclick = logDecision;
    }
  }

  /* ---- step 1: history */
  function step1() {
    const c = S.c, n = c.escalated_known;
    if (!n) return `<div class="step-head"><p class="eyebrow">What happened to similar escalations</p><h1 class="title">No similar escalations yet.</h1><p class="lede">There is no history for this issue to learn from. Use the checklist in step 3 carefully.</p></div>`;
    const g = k => c.outcomes.filter(o => o.group === k).reduce((a, o) => a + o.n, 0);
    const fixed = g("fixed"), l1 = g("l1"), other = g("other"), notFixed = n - fixed;
    const parts = [["fixed", fixed, "Fixed by engineering"], ["l1", l1, "L1 could have handled"], ["other", other, "Duplicate or not reproducible"]];
    return `<div class="step-head">
        <p class="eyebrow">What happened to similar escalations</p>
        <h1 class="title">${notFixed === 0 ? "Every similar escalation was fixed." : `<span class="hl">${pct(notFixed / n)}</span> came back<br>without a fix.`}</h1>
        <p class="lede">Engineering fixed ${fixed} of the ${plural(n, "similar escalation")}.${l1 ? ` ${l1} ${l1 === 1 ? "was a config issue, missing detail or how-to question" : "were config issues, missing details or how-to questions"} that L1 could have handled.` : ""}</p>
      </div>
      <div>
        <div class="obar" role="img" aria-label="Outcomes of similar escalations">${parts.filter(p => p[1]).map(p => `<span style="flex:${p[1]};background:var(--${p[0] === "l1" ? "l1" : p[0]})" data-tip="${p[2]}" data-n="${p[1]}"></span>`).join("")}</div>
        <div class="olegend">${parts.map(p => `<span><i style="background:var(--${p[0]})"></i>${p[2]} <b>${p[1]}</b></span>`).join("")}</div>
      </div>
      <div class="pair">
        <div class="stat"><span class="k">Stays open when escalated</span><span class="v">${fmtH(c.median_h_escalated)}</span></div>
        <div class="stat"><span class="k">Stays open when L1 resolves it</span><span class="v">${fmtH(c.median_h_l1)}</span></div>
      </div>
      <p class="hint">Based on ${plural(c.similar_total, "past ticket")}, matched on ${c.match}.</p>`;
  }

  /* ---- step 2: known issue / owner */
  function step2() {
    const c = S.c;
    let eyebrow = "Is it known, and is it engineering's?", title, lede, box = "";
    if (!c.is_engineering) {
      const owner = c.owner.split(": ").pop();
      title = "This usually isn't engineering's.";
      lede = `${owner}. Escalate only if you have evidence of a system fault.`;
      box = `<div class="callout bad">${I.route}<div><b>Route it instead.</b> In step 4, choose “Routed to another team”. The client update is written for you.</div></div>`;
    } else if (c.known_issue.length) {
      title = "This looks like a known issue.";
      lede = `In the last 30 days engineering marked ${plural(c.known_issue.length, "ticket")} with this same issue as a duplicate of something they already know about.`;
      box = `<div class="callout warn">${I.alert}<div><b>Link it instead of opening a new investigation.</b> Ask engineering which ticket it belongs to, then choose “Linked to known engineering issue” in step 4.<div class="eng-ids">${c.known_issue.map(k => `<span class="mono">${k.eng_ticket_id}</span>`).join("")}</div></div></div>`;
    } else {
      title = "No known issue. Engineering owns this.";
      lede = "Nothing in the last 30 days was marked as a duplicate of this issue, and this category belongs to engineering.";
      box = `<div class="callout good">${I.check}<div><b>Fine to continue.</b> Next, rule out the usual config causes so it doesn't come back.</div></div>`;
    }
    const live = c.open_with_eng_total ? `<div class="callout plain">${I.clock}<div><b>${plural(c.open_with_eng_total, "ticket")} with this issue ${c.open_with_eng_total === 1 ? "is" : "are"} with engineering right now.</b> If it's the same root cause, mention them in the note.<div class="eng-ids">${c.open_with_eng.map(o => `<span class="mono">${o.eng_ticket_id}</span>`).join("")}</div></div></div>` : "";
    return `<div class="step-head"><p class="eyebrow">${eyebrow}</p><h1 class="title">${title}</h1><p class="lede">${lede}</p></div>${box}${live}`;
  }

  /* ---- step 3: checklist */
  function step3() {
    const c = S.c, r = ready();
    return `<div class="step-head">
        <p class="eyebrow">Before it goes to engineering</p>
        <h1 class="title">Rule out config,<br>then collect the details.</h1>
        <p class="counter" id="counter"><b>${r.cd + r.fd}</b> of ${r.ct + r.ft} done</p>
      </div>
      <div><h2 class="group-title">Check these yourself</h2>
        <ul class="checks">${c.checks.map((x, i) => `<li><label><input class="box" type="checkbox" data-i="${i}" ${S.checks[i] ? "checked" : ""}><span>${esc(x)}</span></label></li>`).join("")}</ul>
      </div>
      <div><h2 class="group-title">What engineering needs</h2>
        <div class="fields">${c.fields.map(f => `<label class="label">${esc(f)}<input class="input" data-f="${esc(f)}" value="${esc(S.fields[f])}"></label>`).join("")}</div>
      </div>`;
  }

  /* ---- step 4: decide */
  function step4() {
    const c = S.c, r = ready(), escalating = S.decision === ESCALATE;
    let title, lede;
    if (escalating && r.ok) { title = "Ready to escalate."; lede = "Config is ruled out and engineering has everything it needs. Copy the note into the engineering ticket."; }
    else if (escalating) { title = "Not ready to escalate yet."; lede = `${plural(r.ct - r.cd, "check")} and ${plural(r.ft - r.fd, "detail")} are still open. Skipping them is how tickets come back as config issues or missing information.`; }
    else { title = "Nothing goes to engineering."; lede = "Log the decision and send the client the update below."; }
    const a = c.actual;
    return `<div class="step-head"><p class="eyebrow">Decide</p><h1 class="title">${title}</h1><p class="lede">${lede}</p></div>
      <div class="options">${DECISIONS.map(([v, d]) => `<label class="option"><input class="radio" type="radio" name="decision" value="${esc(v)}" ${S.decision === v ? "checked" : ""}><span><span class="t">${esc(v)}</span><span class="d">${d}</span></span></label>`).join("")}</div>
      ${escalating && !r.ok ? `<label class="label">Escalating anyway? Say why. The support lead will see this.<input class="input" id="override" value="${esc(S.override)}" placeholder="e.g. P1, client's CEO is waiting"></label>` : ""}
      <div class="note-box"><span class="k">Update for the client</span>${esc(clientNote())}</div>
      <div class="actions-row">
        ${escalating ? `<button class="btn" id="copy-eng">${I.copy}Copy engineering note</button>` : ""}
        <button class="btn" id="copy-client">${I.copy}Copy client update</button>
      </div>
      ${a ? `<div class="outcome"><h3>What actually happened</h3>${S.revealed || S.logged ? `<dl>
          <div><dt>Escalated by</dt><dd>${esc(a.assigned_agent)}</dd></div>
          <div><dt>Engineering said</dt><dd>${esc((a.eng_outcome || "Pending").replace(" - returned to L1", ""))}</dd></div>
          <div><dt>Handoffs</dt><dd>${a.eng_handoffs}</dd></div>
          <div><dt>${a.final_closed_at ? "Closed after" : "Still open after"}</dt><dd>${fmtH(a.hours_open)}</dd></div>
          <div><dt>Reopened</dt><dd>${plural(a.reopen_count, "time")}</dd></div>
          <div><dt>CSAT</dt><dd>${a.csat_score ?? "Not given"}</dd></div></dl>`
          : `<div><button class="btn" id="reveal">Reveal the real outcome</button></div>`}</div>` : ""}`;
  }

  function wireStep() {
    const st = $("#step");
    st.querySelectorAll(".obar span").forEach(sp => {
      sp.addEventListener("mousemove", e => Charts.showTip(e, `<div class="tt-h">${sp.dataset.tip}</div><div class="tt-r">Escalations<b>${sp.dataset.n}</b></div>`));
      sp.addEventListener("mouseleave", Charts.hideTip);
    });
    st.querySelectorAll(".box").forEach(cb => cb.addEventListener("change", () => { S.checks[+cb.dataset.i] = cb.checked; onProgress(); }));
    st.querySelectorAll("input[data-f]").forEach(inp => inp.addEventListener("input", () => { S.fields[inp.dataset.f] = inp.value; onProgress(); }));
    st.querySelectorAll("input[name=decision]").forEach(rb => rb.addEventListener("change", () => { S.decision = rb.value; renderFlow(); }));
    if ($("#override")) $("#override").addEventListener("input", e => { S.override = e.target.value; renderNext(); });
    if ($("#copy-eng")) $("#copy-eng").onclick = () => copy(engNote(), "Engineering note copied");
    if ($("#copy-client")) $("#copy-client").onclick = () => copy(clientNote(), "Client update copied");
    if ($("#reveal")) $("#reveal").onclick = () => { S.revealed = true; renderFlow(); };
  }
  function onProgress() {
    const r = ready();
    $("#counter").innerHTML = `<b>${r.cd + r.fd}</b> of ${r.ct + r.ft} done`;
    renderNext();
  }
  function copy(text, msg) { navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("Couldn't copy")); }

  function engNote() {
    const c = S.c, t = c.ticket;
    return [
      `[${t.priority}] ${t.category} | ${t.client_name || ""}${t.ticket_id ? " | " + t.ticket_id : ""}`,
      `Issue: ${t.description}`, "",
      "Checked by L1:", ...c.checks.map((x, i) => `  [${S.checks[i] ? "x" : " "}] ${x}`), "",
      "Details:", ...c.fields.map(f => `  - ${f}: ${S.fields[f].trim() || "NOT PROVIDED"}`), "",
      c.known_issue.length ? `Possible duplicate of: ${c.known_issue.map(k => k.eng_ticket_id).join(", ")}` : "No known-issue match.",
      `History: ${c.escalated_known} similar escalations, ${pct(c.fixed_share)} fixed, ${pct(c.preventable_share)} returned as L1-fixable.`,
      S.override ? `Escalated before the check was complete: ${S.override}` : "",
    ].join("\n").trim();
  }
  function clientNote() {
    const missing = Object.entries(S.fields).filter(([, v]) => !v.trim()).map(([k]) => k.toLowerCase());
    const team = S.c.owner.split(": ").pop().replace(/^Not engineering: /, "").replace(/;.*$/, "");
    return {
      [DECISIONS[0][0]]: "We've passed this to our engineering team with everything they need to investigate. We'll update you within one working day.",
      [DECISIONS[1][0]]: "We found the cause: it was a settings issue, and we've corrected it. Please check on your side and tell us if you still see it.",
      [DECISIONS[2][0]]: "This matches an issue our engineering team is already fixing. We've linked your ticket to it and will update you as soon as the fix is live.",
      [DECISIONS[3][0]]: `To fix this quickly we need a few details: ${missing.slice(0, 4).join(", ") || "a few details"}. Once we have them we'll take it forward the same day.`,
      [DECISIONS[4][0]]: `We've passed this to the team that owns it (${team}). They'll contact you directly.`,
    }[S.decision];
  }
  async function logDecision() {
    const c = S.c, r = ready();
    try {
      await api("/api/log", {
        ticket_id: c.ticket.ticket_id, agent: c.ticket.assigned_agent || "", category: c.ticket.category, description: c.ticket.description,
        decision: S.decision, ready: r.ok, checks_done: r.cd, checks_total: r.ct, fields_done: r.fd, fields_total: r.ft,
        override_reason: S.override, known_issue_flag: c.known_issue.length > 0,
      });
      S.logged = true; S.log = null;
      renderFlow();
      toast("Decision logged. It shows on the scorecard.");
    } catch (err) { toast(err.message); }
  }

  /* ================================================================ 3 · scorecard (separate pages) */
  const TABS = [["overview", "Overview"], ["trends", "Trends"], ["agents", "By agent"], ["log", "Logged checks"]];
  async function renderScorecard() {
    if (!S.sc) S.sc = await api("/api/scorecard");
    if (!S.log) S.log = await api("/api/log");
    const weeks = S.sc.weeks, full = weeks.filter(w => !w.partial), cur = full[full.length - 1], base = full[full.length - 5];
    app.innerHTML = `<div class="wrap wide">
      <div class="sc-head"><h1 class="title">Scorecard</h1><span class="week">Week of ${fmtD(cur.week)} 2026 · compared with ${fmtD(base.week)}</span></div>
      <nav class="sc-tabs" aria-label="Scorecard pages">${TABS.map(([k, l]) => `<button data-t="${k}" ${S.scTab === k ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
      <div id="sc-body"></div>
    </div>`;
    app.querySelectorAll(".sc-tabs button").forEach(b => b.addEventListener("click", () => go("scorecard", b.dataset.t)));
    ({ overview: scOverview, trends: scTrends, agents: scAgents, log: scLog })[S.scTab](cur, base);
  }

  function statusOf(v, b, target, lowerBetter) {
    const ok = lowerBetter ? v <= target : v >= target, worse = lowerBetter ? v > b : v < b;
    return ok ? `<span class="status good">${I.check}On target</span>` : worse ? `<span class="status bad">${I.up}Off target, worsening</span>` : `<span class="status warn">${I.alert}Off target</span>`;
  }
  function scOverview(cur, base) {
    const T = S.sc.targets;
    const tiles = [
      ["Headline", "Open tickets at end of week", "open_end_of_week", v => Math.round(v), `≤ ${T.open_end_of_week}`, T.open_end_of_week, true],
      ["Driver", "Escalations returned as L1-fixable", "preventable_bounce_rate", pct, `≤ ${pct(T.preventable_bounce_rate)}`, T.preventable_bounce_rate, true],
      ["Driver", "Handoffs per escalation", "handoffs_per_escalation", v => v.toFixed(2), `≤ ${T.handoffs_per_escalation}`, T.handoffs_per_escalation, true],
      ["Guardrail", "Reopen rate", "reopen_rate", pct, `≤ ${pct(T.reopen_rate)}`, T.reopen_rate, true],
    ];
    const minis = [
      ["Median first response", "Guardrail", "median_first_response_h", v => v.toFixed(1) + " h", `≤ ${T.median_first_response_h} h`, T.median_first_response_h, true],
      ["CSAT", "Guardrail · rated tickets only", "csat", v => v.toFixed(2), `≥ ${T.csat}`, T.csat, false],
    ];
    $("#sc-body").innerHTML = `<div class="tiles">${tiles.map(([role, k, key, f, tl, tv, lb], i) => `
        <div class="tile ${i === 0 ? "hero" : ""}"><span class="role">${role}</span><span class="k">${k}</span><span class="v">${f(cur[key])}</span>
          <div class="foot"><span>Target <b>${tl}</b> · was ${f(base[key])}</span>${statusOf(cur[key], base[key], tv, lb)}</div></div>`).join("")}
      </div>
      <div class="minis">${minis.map(([k, sub, key, f, tl, tv, lb]) => `
        <div class="mini"><div><div class="k">${k}</div><div class="sub">${sub} · target ${tl}</div><div style="margin-top:8px">${statusOf(cur[key], base[key], tv, lb)}</div></div><span class="v">${f(cur[key])}</span></div>`).join("")}
      </div>
      <p class="sc-note">The headline moves when the drivers move. Guardrails make sure it isn't hit by closing tickets early or by refusing to escalate real bugs. The week of 28 Sep is partial (Mon–Wed) and isn't scored.</p>`;
  }
  function scTrends() {
    const weeks = S.sc.weeks, T = S.sc.targets, partialFrom = weeks.findIndex(w => w.partial);
    const labels = weeks.map(w => fmtD(w.week)), tipLabels = weeks.map(w => `Week of ${fmtD(w.week)}`);
    $("#sc-body").innerHTML = `<div class="charts">
      <div class="chart-block"><h2>Open tickets at end of week</h2><p>The number leadership reviews. Target ${T.open_end_of_week}.</p><div id="ch-open"></div></div>
      <div class="chart-block"><h2>Escalations returned without a fix</h2><p>Share of each week's escalations, by engineering's final verdict.</p><div id="ch-bounce"></div>
        <div class="legend"><span><i style="background:var(--other)"></i>All returned</span><span><i style="background:var(--l1)"></i>L1 could have handled</span><span><i class="dash"></i>Target</span></div></div>
      <div class="chart-block"><h2>Tickets created and closed</h2><p>Closed means finally closed, after any reopens.</p><div id="ch-flow"></div>
        <div class="legend"><span><i style="background:var(--fixed)"></i>Created</span><span><i style="background:var(--other)"></i>Closed</span></div></div>
    </div>`;
    Charts.chart($("#ch-open"), { kind: "bar", labels, tipLabels, partialFrom, height: 260, aria: "Open tickets at end of each week",
      series: [{ name: "Open at week end", color: "var(--text-2)", values: weeks.map(w => w.open_end_of_week) }],
      target: { value: T.open_end_of_week, label: `Target ${T.open_end_of_week}` } });
    Charts.chart($("#ch-bounce"), { labels, tipLabels, height: 260, fmt: v => Math.round(v * 100) + "%", yMax: 0.8, aria: "Share of escalations returned without a fix",
      series: [{ name: "All returned", color: "var(--other)", values: weeks.map(w => w.bounce_rate) }, { name: "L1 could have handled", color: "var(--l1)", values: weeks.map(w => w.preventable_bounce_rate) }],
      target: { value: T.preventable_bounce_rate, label: "Target 20%" } });
    Charts.chart($("#ch-flow"), { labels, tipLabels, height: 260, aria: "Tickets created and closed per week",
      series: [{ name: "Created", color: "var(--fixed)", values: weeks.map(w => w.created) }, { name: "Closed", color: "var(--other)", values: weeks.map(w => w.closed) }] });
  }
  function scAgents() {
    const bar = (v, max, hi) => `<span class="cell-bar"><span class="num">${pct(v)}</span><span class="track"><span class="fill ${hi ? "hi" : ""}" style="width:${Math.min(100, (100 * v) / max)}%"></span></span></span>`;
    $("#sc-body").innerHTML = `<div class="chart-block"><h2>By agent</h2><p>For coaching conversations, not a ranking. Orange marks the numbers worth a conversation.</p></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Agent</th><th class="r">Tickets</th><th class="r">Escalates</th><th class="r">Escalations returned unfixed</th><th class="r">Reopen rate</th><th class="r">Median first close</th></tr></thead>
        <tbody>${S.sc.agents.map(a => `<tr><td class="name">${esc(a.assigned_agent)}</td><td class="r num">${a.tickets}</td>
          <td class="r">${bar(a.escalation_rate, 0.7, a.escalation_rate > 0.5)}</td>
          <td class="r">${bar(a.bounce_rate, 1, a.bounce_rate > 0.65)}</td>
          <td class="r">${bar(a.reopen_rate, 0.35, a.reopen_rate > 0.15)}</td>
          <td class="r num">${a.median_hours_to_first_close.toFixed(1)} h</td></tr>`).join("")}</tbody>
      </table></div>`;
  }
  function scLog() {
    const log = S.log;
    $("#sc-body").innerHTML = log.length ? `<div class="chart-block"><h2>Logged checks</h2><p>${plural(log.length, "decision")} recorded with the escalation check, newest first.</p></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Ticket</th><th>Decision</th><th class="r">Checklist</th><th>Reason for escalating early</th></tr></thead><tbody>
        ${log.map(l => `<tr><td class="mono" style="color:var(--muted)">${esc(String(l.logged_at).replace("T", " ").slice(0, 16))}</td><td class="mono">${esc(l.ticket_id)}</td><td>${esc(l.decision)}</td><td class="r num">${+l.checks_done + +l.fields_done}/${+l.checks_total + +l.fields_total}</td><td>${esc(l.override_reason) || '<span style="color:var(--muted)">–</span>'}</td></tr>`).join("")}
      </tbody></table></div>`
      : `<div class="empty"><h3>No checks logged yet</h3>Run an escalation check and log the decision. It will show up here.</div>`;
  }

  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === "scorecard" && S.scTab === "trends") scTrends(); }, 200); });

  /* ================================================================ boot */
  (async function boot() {
    META = await api("/api/meta");
    $("#asof").textContent = `Data to ${fmtD(META.as_of)} 2026`;
    const [q, r] = await Promise.all([api("/api/tickets?mode=queue"), api("/api/tickets?mode=replay")]);
    S.lists = { queue: q, replay: r };
    const [view, tab] = location.hash.replace("#", "").split("/");
    if (view === "scorecard") go("scorecard", TABS.some(t => t[0] === tab) ? tab : "overview"); else go("check");
  })();
})();
