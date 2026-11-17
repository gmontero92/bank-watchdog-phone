// Bank Watchdog – phone web app.
// This page holds no data and no budget logic. When it opens it downloads the Python code and your data
// from YOUR private repo (with the token saved on this phone only) and runs the desktop's own
// calculations inside the browser (Pyodide = Python for the web).

const PYODIDE_VERSION = "314.0.8";
const DEFAULT_PYODIDE = `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;
const API = localStorage.getItem("bw_api") || "https://api.github.com";      // bw_api: only for testing
const PYODIDE_BASE = localStorage.getItem("bw_pyodide") || DEFAULT_PYODIDE;
const WORKFLOW = "daily-report.yml";
const CODE = ["core.py", "budget.py", "dayplan.py", "mobile_api.py"];

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const S = { tab: "today", month: null, editTab: "once", filter: "all", data: {}, busy: false };
let py = null, M = null;

// ------------------------------------------------------------------ small helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, signed = false) => {
  const n = Math.round(Number(v) || 0), a = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `−$${a}` : (signed && n > 0 ? `+$${a}` : `$${a}`);
};
const cents = (v) => (Number(v) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pd = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const md = (s) => pd(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const wday = (s) => pd(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const short = (n) => String(n || "").replace(/[®™]/g, "")
  .replace(/\s+(Rewards Visa Signature|Cash Rewards Visa Signature|Visa Signature)\b/g, "").replace(/\s{2,}/g, " ").trim();
const ago = (t) => {
  if (!t) return "never";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), ms);
}
function splash(text, spin = true) {
  view.innerHTML = `<div class="splash"><img src="icon-512.png" alt=""><p>${esc(text)}</p>${spin ? '<div class="spin"></div>' : ""}</div>`;
}
function fail(e) {
  console.error(e);
  view.innerHTML = `<div class="err"><b>Something went wrong.</b><br>${esc(e.message || e)}</div>
    <button class="add" id="retry">Try again</button>
    <button class="add" style="background:#64748b" id="resetup">Check the repo / token</button>`;
  $("#retry").onclick = () => start();
  $("#resetup").onclick = () => setupScreen();
}

// ------------------------------------------------------------------ settings on this phone
const cfg = {
  get repo() { return localStorage.getItem("bw_repo") || ""; },
  get token() { return localStorage.getItem("bw_token") || ""; },
  save(repo, token) { localStorage.setItem("bw_repo", repo); localStorage.setItem("bw_token", token); },
  forget() { ["bw_repo", "bw_token"].forEach((k) => localStorage.removeItem(k)); },
};

// ------------------------------------------------------------------ GitHub
class GitHubError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function gh(path, opt = {}) {
  const r = await fetch(`${API}/repos/${cfg.repo}/${path}`, {
    ...opt, cache: "no-store",
    headers: { Authorization: `Bearer ${cfg.token}`, "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json", ...(opt.headers || {}) },
  });
  if (!r.ok && r.status !== 404) {
    let m = ""; try { m = (await r.json()).message; } catch { }
    const hint = r.status === 401 ? " – the token is wrong or expired."
      : r.status === 403 ? " – the token isn't allowed to do this (check its permissions)." : "";
    throw new GitHubError(`GitHub said ${r.status}${m ? ` (${m})` : ""}${hint}`, r.status);
  }
  return r;
}
async function getRaw(path, ref = "main", optional = false) {
  const r = await gh(`contents/${path}?ref=${ref}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (r.status === 404) {
    if (optional) return null;
    throw new Error(`${path} isn't in the repo (${ref} branch). Did the desktop app finish "Update the cloud app"?`);
  }
  return new Uint8Array(await r.arrayBuffer());
}
async function getWithSha(path) {
  const r = await gh(`contents/${path}?ref=main`);
  if (r.status === 404) throw new Error(`${path} isn't in the repo yet.`);
  const j = await r.json();
  const bin = atob(j.content.replace(/\n/g, ""));
  return { bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)), sha: j.sha };
}
async function putFile(path, bytes, sha, message) {
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await gh(`contents/${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: btoa(bin), sha, branch: "main" }),
  });
  return r.json();
}

// ------------------------------------------------------------------ Python
async function bootPython() {
  if (py) return;
  splash("Loading the calculator (first time takes ~15 s)…");
  const { loadPyodide } = await import(PYODIDE_BASE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE_BASE });
  py.FS.mkdirTree("/app"); py.FS.mkdirTree("/data");
}
const call = (expr) => JSON.parse(py.runPython(expr));
const pyStr = (s) => JSON.stringify(s);   // a JSON string is also a valid Python string literal

async function download() {
  splash("Downloading your latest data…");
  const code = await Promise.all(CODE.map((f) => getRaw(`app/${f}`)));
  const [budget, config, db, sync] = await Promise.all([
    getRaw("data/budget.json"), getRaw("data/config.json"),
    getRaw("watchdog.db", "data"), getRaw("sync_state.json", "data", true),
  ]);
  CODE.forEach((f, i) => py.FS.writeFile(`/app/${f}`, code[i]));
  py.FS.writeFile("/data/budget.json", budget);
  py.FS.writeFile("/data/config.json", config);
  py.FS.writeFile("/data/watchdog.db", db);
  if (sync) py.FS.writeFile("/data/sync_state.json", sync);
  py.runPython(`
import os, sys, importlib
os.environ["BANKWATCHDOG_DATA"] = "/data"
if "/app" not in sys.path: sys.path.insert(0, "/app")
for _m in ("core", "budget", "dayplan", "mobile_api"):
    if _m in sys.modules: importlib.reload(sys.modules[_m])
import mobile_api as M
`);
  S.info = call("M.prepare()");
  S.loadedAt = Date.now();
  S.data = {};
  freshness();
}

function freshness() {
  const t = S.info?.synced_at;
  $("#fresh").textContent = t ? `Banks synced ${ago(t)}` : "Not synced in the cloud yet";
}

// ------------------------------------------------------------------ start / setup
async function start() {
  if (!cfg.repo || !cfg.token) return setupScreen();
  try {
    await bootPython();
    await download();
    show(S.tab);
  } catch (e) { fail(e); }
}

function setupScreen() {
  document.body.classList.add("setup");
  view.innerHTML = `
  <div class="card">
    <h2 style="margin:0 0 6px">Connect this phone</h2>
    <p class="muted small" style="margin:0">Both are saved only on this phone. Your data never goes anywhere
      except between this phone and your private GitHub repo.</p>
    <label class="f">Your private repo (owner/name)</label>
    <input id="s-repo" placeholder="guillermo/bank-watchdog-data" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(cfg.repo)}">
    <label class="f">Phone token (starts with github_pat_)</label>
    <input id="s-token" type="password" placeholder="github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(cfg.token)}">
    <div id="s-msg"></div>
    <div class="btns"><button class="go" id="s-go">Connect</button></div>
  </div>
  <p class="muted small" style="padding:0 6px">Step-by-step help: PHONE_SETUP.md (came with the app).</p>`;
  $("#s-go").onclick = async () => {
    const repo = $("#s-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    const token = $("#s-token").value.trim();
    const msg = $("#s-msg");
    const say = (t, good) => (msg.innerHTML = `<div class="warnbox ${good ? "good" : "bad"}">${esc(t)}</div>`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return say("Type it as owner/name, e.g. guillermo/bank-watchdog-data.");
    if (token.startsWith("ghp_")) return say("That's a classic token. Please make a fine-grained one (github_pat_…) that can only reach this one repo.");
    if (!token) return say("Paste the token.");
    const old = [cfg.repo, cfg.token];
    cfg.save(repo, token);
    say("Checking…", true);
    try {
      const r = await fetch(`${API}/repos/${repo}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (r.status === 401) throw new Error("GitHub doesn't accept this token (typo, or it expired).");
      if (r.status === 404) throw new Error("Can't see that repo: check the name, and that the token was made for it.");
      const j = await r.json();
      if (!j.private) throw new Error("That repo is PUBLIC. Your bank data must stay in a private repo.");
      if (j.permissions && !j.permissions.push) throw new Error("The token can only read. Give it Contents: Read and write.");
      document.body.classList.remove("setup");
      start();
    } catch (e) {
      if (old[0]) cfg.save(...old); else cfg.forget();
      say(e.message);
    }
  };
}

// ------------------------------------------------------------------ tabs
function show(tab) {
  S.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  try {
    ({ today: drawToday, month: drawMonth, plan: drawPlan, activity: drawActivity, edit: drawEdit })[tab]();
  } catch (e) { fail(e); }
  window.scrollTo(0, 0);
}
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => py && M_ready() && show(b.dataset.tab)));
const M_ready = () => { try { return !!S.info; } catch { return false; } };

// ------------------------------------------------------------------ a spending bar
function bar(used, pending, cap, pace) {
  const total = used + pending, scale = Math.max(cap, total, 1);
  const p = (v) => `${Math.max(0, Math.min(100, (v / scale) * 100)).toFixed(2)}%`;
  const a = Math.min(used, cap), b = Math.min(total, cap);
  let h = `<div class="bar">`;
  if (a > 0) h += `<div class="seg spent first ${b <= a && total <= cap && a >= cap ? "last" : ""}" style="left:0;width:${p(a)}"></div>`;
  if (b > a) h += `<div class="seg bills ${a <= 0 ? "first" : ""}" style="left:${p(a)};width:${p(b - a)}"></div>`;
  if (total > cap) h += `<div class="seg overb last" style="left:${p(cap)};width:${p(total - cap)}"></div><div class="cap" style="left:${p(cap)}"></div>`;
  if (pace && pace > 0) h += `<div class="pace" style="left:${p(Math.min(pace, cap))}"></div>`;
  return h + `</div>`;
}
const LEGEND = `<div class="legend"><span><i style="background:var(--spent)"></i>spent</span>
  <span><i style="background:var(--bills)"></i>pending</span><span><i style="background:var(--left)"></i>left</span>
  <span><i style="background:var(--over)"></i>over</span><span>▾┆ where you should be today</span></div>`;

// ------------------------------------------------------------------ Today
function drawToday() {
  const d = S.data.today || (S.data.today = call("M.today_json()"));
  const a = d.all, ic = { alert: "🔴", warn: "🟠", info: "🔵" };
  let h = `<div class="card hero">
    <h3>Room left on your cards this cycle</h3>
    <div class="row"><big class="${a.room < 0 ? "neg" : ""}">${money(a.room)}</big>
      <span class="muted small right">of ${money(a.capacity)}<br>${money(a.used)} spent${a.pending ? ` · ${money(a.pending)} pending` : ""}</span></div>
    ${bar(a.used, a.pending, a.capacity, a.pace)}${LEGEND}
  </div>`;
  h += `<div class="list">`;
  h += d.heads.length
    ? d.heads.map((x) => `<div class="alert"><span class="ic">${ic[x.level] || "•"}</span><span>${esc(short(x.text))}</span></div>`).join("")
    : `<div class="alert"><span class="ic">✅</span><span>No actions needed right now.</span></div>`;
  h += `</div>`;
  h += `<div class="card"><h3>Cash</h3><div class="row"><span>In your spending accounts</span><b class="right">${money(d.cash)}</b></div>`;
  if (d.cashflow?.low != null)
    h += `<div class="row small"><span class="muted">Lowest point ahead${d.cashflow.low_label ? ` (${esc(d.cashflow.low_label)})` : ""}</span>
      <b class="right ${d.cashflow.low < 0 ? "neg" : ""}">${money(d.cashflow.low)}</b></div>`;
  if (d.owed_loans) h += `<div class="row small"><span class="muted">Still owed on loans</span><span class="right">${money(d.owed_loans)}</span></div>`;
  h += `</div>`;
  for (const c of d.cards) {
    const word = { ok: "on track", slow: "spending fast", full: "budget used up", over: "over budget" }[c.state];
    h += `<div class="card">
      <div class="row"><span class="dot ${c.state}"></span><b>${esc(c.name)}</b>
        <span class="right ${c.room < 0 ? "neg" : ""}"><b>${money(c.room)}</b> <span class="muted small">left</span></span></div>
      ${bar(c.used, c.pending, c.capacity, c.pace)}
      <div class="row small muted"><span>${money(c.used + c.pending)} of ${money(c.capacity)} · ${word}</span>
        <span class="right">closes ${md(c.closes)} (${c.days_left} d)</span></div>
    </div>`;
  }
  if (d.nobudget.length) h += `<p class="muted small" style="padding:0 6px">No budget set: ${esc(d.nobudget.join(", "))}</p>`;
  if (d.others.length) {
    h += `<div class="list">` + d.others.map((x) => `<div class="alert"><span class="ic">${ic[x.level] || "•"}</span><span class="small">${esc(short(x.text))}</span></div>`).join("") + `</div>`;
  }
  h += `<div class="card"><h3>Banks</h3>` + d.banks.map((b) => `<div class="row small">
      <span>${b.status === "ok" ? "🟢" : "🔴"} ${esc(b.name)}</span>
      <span class="right muted">${b.bank_updated ? `bank data ${esc(md(b.bank_updated))}` : `synced ${esc(ago(b.last_sync))}`}</span></div>
      ${b.error ? `<div class="small neg">${esc(b.error)}</div>` : ""}`).join("") + `</div>`;
  view.innerHTML = h;
}

// ------------------------------------------------------------------ Month
function chart(series, today) {
  if (!series.length) return "";
  const W = 340, H = 150, P = 6, vals = series.map((s) => s.balance);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, series.length - 1);
  const y = (v) => P + ((hi - v) / span) * (H - 2 * P);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.balance).toFixed(1)}`);
  const lastReal = series.reduce((k, s, i) => (s.actual ? i : k), -1);
  const real = pts.slice(0, lastReal + 1).join(" "), plan = pts.slice(Math.max(0, lastReal)).join(" ");
  const ti = series.findIndex((s) => s.date === today);
  const low = vals.indexOf(Math.min(...vals));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"/>
    ${ti >= 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="0" y2="${H}" stroke="#1d4ed8" stroke-width="1" opacity=".35"/>` : ""}
    ${real ? `<polyline points="${real}" fill="none" stroke="#1d4ed8" stroke-width="2.5" vector-effect="non-scaling-stroke"/>` : ""}
    ${lastReal < series.length - 1 ? `<polyline points="${plan}" fill="none" stroke="#1d4ed8" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` : ""}
    <circle cx="${x(low)}" cy="${y(vals[low])}" r="4" fill="${vals[low] < 0 ? "#b91c1c" : "#15803d"}"/>
  </svg>`;
}

function drawMonth() {
  if (!S.month) { const t = new Date(); S.month = [t.getFullYear(), t.getMonth() + 1]; }
  const [y, m] = S.month, key = `month-${y}-${m}`;
  const d = S.data[key] || (S.data[key] = call(`M.month_json(${y}, ${m})`));
  const title = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const bal = Object.fromEntries(d.series.map((s) => [s.date, s.balance]));
  const keep = (e) => S.filter === "all" ? true : S.filter === "plan" ? !e.actual : e.kind === "cardpay";
  let h = `<div class="mnav"><button id="m-prev" aria-label="Previous month">‹</button><div class="m">${esc(title)}</div>
      <button id="m-next" aria-label="Next month">›</button></div>
    <div class="card">
      <div class="stats">
        <div><small>Start</small><b>${money(d.start)}</b></div>
        <div><small>End of month</small><b class="${d.end < 0 ? "neg" : ""}">${money(d.end)}</b></div>
        <div><small>Lowest (${esc(md(d.low_date))})</small><b class="${d.low < 0 ? "neg" : ""}">${money(d.low)}</b></div>
      </div>
      ${chart(d.series, d.today)}
      <div class="legend"><span>━ real</span><span>┅ plan</span><span>● lowest day</span></div>
    </div>
    <div class="chips">
      <button class="chip ${S.filter === "all" ? "on" : ""}" data-f="all">Everything</button>
      <button class="chip ${S.filter === "plan" ? "on" : ""}" data-f="plan">Still to come</button>
      <button class="chip ${S.filter === "pay" ? "on" : ""}" data-f="pay">Card payments</button>
    </div><div class="list">`;
  const days = {};
  d.events.filter(keep).forEach((e, i) => (days[e.date] ||= []).push([e, d.events.indexOf(e)]));
  const dates = Object.keys(days).sort().reverse();                 // newest day on top
  if (!dates.length) h += `<div class="item muted">Nothing here.</div>`;
  const future = dates.filter((x) => x > d.today).length;
  if (future && dates.some((x) => x <= d.today))
    h = h.replace('<div class="list">', `<button class="chip" id="m-today" style="margin:0 0 8px">↓ Jump to today</button><div class="list">`);
  for (const day of dates) {
    h += `<div class="dayhead ${day === d.today ? "today" : ""}" data-date="${esc(day)}"><span>${esc(wday(day))}${day === d.today ? " · today" : ""}</span>
      <span>${bal[day] != null ? `end of day ${money(bal[day])}` : ""}</span></div>`;
    for (const [e, i] of [...days[day]].reverse()) {
      const onCard = e.kind === "card";
      const amt = onCard ? `<span class="muted">${money(-e.card)}</span><div class="small muted">on card</div>`
        : `<b class="${e.amount > 0 ? "pos" : ""}">${money(e.amount, true)}</b>`;
      const sub = e.kind === "cardpay" ? e.account : short(e.account);
      h += `<div class="item ${e.actual ? "" : "plan"} ${onCard ? "dim" : ""} ${e.kind === "cardpay" ? "tap" : ""} ${e.late ? "late" : ""}" data-i="${i}">
        <div class="main"><div class="t">${esc(short(e.desc))}${e.kind === "pending" ? ' <span class="badge">pending</span>' : ""}</div>
          <div class="small muted why">${esc(sub)}${e.kind === "cardpay" ? " · tap to move" : ""}</div></div>
        <div class="amt">${amt}</div></div>`;
    }
  }
  h += `</div><p class="muted small" style="padding:0 6px">Newest on top. Blue rows are the plan; white rows already happened.
    Card purchases don't change your cash until you pay the card.</p>`;
  view.innerHTML = h;
  if ($("#m-today")) $("#m-today").onclick = () => [...document.querySelectorAll(".dayhead[data-date]")].find((x) => x.dataset.date <= d.today)?.scrollIntoView({ behavior: "smooth", block: "center" });
  $("#m-prev").onclick = () => { S.month = m === 1 ? [y - 1, 12] : [y, m - 1]; drawMonth(); };
  $("#m-next").onclick = () => { S.month = m === 12 ? [y + 1, 1] : [y, m + 1]; drawMonth(); };
  view.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { S.filter = c.dataset.f; drawMonth(); }));
  view.querySelectorAll(".item.tap").forEach((el) => (el.onclick = () => payDateSheet(d.events[+el.dataset.i])));
}

function payDateSheet(e) {
  const due = e.due;
  sheet(`<h2>${esc(short(e.desc))}</h2>
    <p class="muted small" style="margin:0">${esc(e.account)}</p>
    <div class="row" style="margin-top:10px"><span>Amount</span><b class="right">${cents(-e.amount)}</b></div>
    ${due ? `<div class="row"><span>Due date</span><b class="right">${esc(wday(due))}</b></div>` : ""}
    <label class="f">Pay it on</label>
    <input type="date" id="p-date" value="${esc(e.date)}">
    <div id="p-warn"></div>
    <div class="btns"><button id="p-reset">Plan's date</button><button class="go" id="p-save">Save</button></div>`);
  const warn = () => {
    const v = $("#p-date").value;
    $("#p-warn").innerHTML = due && v > due
      ? `<div class="warnbox bad">⚠ That's after the due date (${esc(md(due))}): expect a late fee and interest.</div>` : "";
  };
  $("#p-date").oninput = warn; warn();
  $("#p-save").onclick = () => edit({ op: "pay_date", card_id: e.card_id, due, date: $("#p-date").value || null });
  $("#p-reset").onclick = () => edit({ op: "pay_date", card_id: e.card_id, due, date: null });
}

// ------------------------------------------------------------------ Plan (Timeline)
function drawPlan() {
  const d = S.data.plan || (S.data.plan = call("M.plan_json()"));
  const badge = (u) => {
    const k = String(u).toLowerCase();
    const cls = k.includes("card") ? "cards" : k.includes("rent") ? "rent" : k.includes("extra") ? "extra" : "";
    return `<span class="badge ${cls}">${esc(u === "Start" ? "today" : u)}</span>`;
  };
  let h = `<p class="muted small" style="padding:0 6px;margin-top:0">Paycheck by paycheck: what comes in, what goes out, and where you land.</p>`;
  d.cols.forEach((c, i) => {
    h += `<div class="card pcol">
      <div class="head"><b>${esc(c.label === "Now" ? "Today" : md(c.date))}</b>${badge(c.use)}
        <span class="right run ${c.running < 0 ? "neg" : ""}">${money(c.running)}</span></div>
      <div class="nums">
        <div><small>In</small>${money(c.net + c.extra_in)}</div>
        <div><small>Out</small>${money(c.out)}</div>
        <div><small>Your own money</small><span class="${(c.own ?? 0) < 0 ? "neg" : ""}">${c.own != null ? money(c.own) : "–"}</span></div>
      </div>
      <details ${i < 2 ? "open" : ""}><summary class="small muted" style="margin-top:6px">What's in it</summary>
        <div class="items">${c.items.map((x) => `<div><span>${esc(short(x.name))}</span><span>${money(x.amount)}</span></div>`).join("") || '<div class="muted">Nothing</div>'}
        ${c.paid.length ? `<div class="small pos">✔ already paid: ${esc(c.paid.join(", "))}</div>` : ""}
        ${c.late.length ? `<div class="small neg">still to pay: ${esc(c.late.join(", "))}</div>` : ""}</div>
      </details></div>`;
  });
  h += `<p class="muted small" style="padding:0 6px">"Your own money" = the balance minus what you still owe on loans.</p>`;
  view.innerHTML = h;
}

// ------------------------------------------------------------------ Activity (recent transactions)
// Same search as the desktop: every term must match. Words: text in the description, merchant, category,
// bank or account. Amounts: 45.20 exact · 45 = any $45.xx · >500 · <20 · >=100 · 100-200 · $ and commas ok.
function txMatcher(query) {
  const tests = [];
  for (const tok of query.toLowerCase().replace(/,/g, "").split(/\s+/).filter(Boolean)) {
    const t = tok.replace(/\$/g, "");
    let m;
    if ((m = t.match(/^(>=|<=|>|<)(\d+(?:\.\d+)?)$/))) {
      const op = m[1], x = parseFloat(m[2]);
      tests.push((a) => ({ ">": a > x, "<": a < x, ">=": a >= x, "<=": a <= x })[op]);
    } else if ((m = t.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/))) {
      const [lo, hi] = [parseFloat(m[1]), parseFloat(m[2])].sort((p, q) => p - q);
      tests.push((a) => lo <= a && a <= hi);
    } else if (/^\d+\.\d{1,2}$/.test(t)) {
      const x = parseFloat(t); tests.push((a) => Math.abs(a - x) < 0.005);
    } else if (/^\d+$/.test(t)) {
      const x = parseInt(t, 10); tests.push((a, txt) => Math.trunc(a) === x || (tok.length >= 4 && txt.includes(tok)));
    } else tests.push((a, txt) => txt.includes(tok));
  }
  return (amount, text) => tests.every((f) => f(Math.abs(amount), text));
}

function drawActivity() {
  S.tx ||= { days: 30, account: "", q: "" };
  const key = `tx-${S.tx.days}-${S.tx.account}`;
  const d = S.data[key] || (S.data[key] = call(`M.transactions_json(${S.tx.days}, ${S.tx.account ? pyStr(S.tx.account) : "None"})`));
  view.innerHTML = `
    <div class="card" style="padding:10px 12px">
      <div class="search"><input id="t-q" type="text" enterkeyhint="search" placeholder="Search: costco · 45.20 · >500 · 100-200" value="${esc(S.tx.q)}"
        autocapitalize="off" autocorrect="off" spellcheck="false"><button id="t-x" aria-label="Clear">✕</button></div>
      <div class="two" style="margin-top:8px">
        <select id="t-acc"><option value="">All accounts</option>${d.accounts.map((a) =>
          `<option value="${esc(a.id)}" ${a.id === S.tx.account ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
        <select id="t-days">${[7, 30, 60, 90, 365].map((n) => `<option value="${n}" ${n === S.tx.days ? "selected" : ""}>Last ${n} days</option>`).join("")}</select>
      </div>
      <div class="small muted" id="t-n" style="margin-top:6px"></div>
    </div>
    <div class="list" id="t-list"></div>
    <p class="muted small" style="padding:0 6px">Search: words (costco netflix) and/or amounts: 45.20 exact · 45 = any $45.xx ·
      >500 · <20 · 100-200. Every term must match. Tap a row for details.</p>`;
  const list = () => {
    const q = S.tx.q.trim(), match = q ? txMatcher(q) : null;
    const rows = d.txs.map((t, i) => [t, i]).filter(([t]) => !match ||
      match(t.amount, [t.raw, t.desc, t.category, t.bank, t.account].join(" ").toLowerCase()));
    $("#t-n").textContent = q ? `${rows.length} found` : `${rows.length} transactions`;
    let h = "", last = null;
    for (const [t, i] of rows.slice(0, 400)) {
      if (t.date !== last) { h += `<div class="dayhead"><span>${esc(wday(t.date))}</span></div>`; last = t.date; }
      const into = t.amount < 0;
      const after = t.after == null ? "" : t.credit
        ? (t.after >= 0.005 ? `owes ${cents(t.after)}` : t.after > -0.005 ? "$0.00" : `credit ${cents(-t.after)}`) : cents(t.after);
      h += `<div class="item tap ${t.thru ? "dim" : ""}" data-i="${i}">
        <div class="main"><div class="t">${esc(t.desc)}${t.status === "pending" ? ' <span class="badge">pending</span>' : ""}${t.thru ? ' <span class="badge">paid back</span>' : ""}</div>
          <div class="small muted t">${esc(t.account)}${t.category ? ` · ${esc(t.category)}` : ""}</div></div>
        <div class="amt"><b class="${into ? "pos" : ""}">${into ? "+" : ""}${cents(Math.abs(t.amount))}</b>
          <div class="small ${t.left != null && t.left < 0 ? "neg" : "muted"}">${t.left != null ? `budget ${money(t.left)}` : esc(after)}</div></div></div>`;
    }
    if (rows.length > 400) h += `<div class="item muted small">Showing the newest 400 – search to narrow it down.</div>`;
    $("#t-list").innerHTML = h || `<div class="item muted">Nothing found.</div>`;
    view.querySelectorAll("#t-list .item.tap").forEach((el) => (el.onclick = () => txSheet(d.txs[+el.dataset.i])));
  };
  list();
  $("#t-q").oninput = () => { S.tx.q = $("#t-q").value; clearTimeout(drawActivity.h); drawActivity.h = setTimeout(list, 200); };
  $("#t-x").onclick = () => { S.tx.q = ""; $("#t-q").value = ""; list(); };
  $("#t-acc").onchange = () => { S.tx.account = $("#t-acc").value; drawActivity(); };
  $("#t-days").onchange = () => { S.tx.days = +$("#t-days").value; drawActivity(); };
}

function txSheet(t) {
  const into = t.amount < 0;
  const after = t.after == null ? "–" : t.credit
    ? (t.after >= 0.005 ? `owes ${cents(t.after)}` : t.after > -0.005 ? "$0.00" : `credit ${cents(-t.after)}`) : cents(t.after);
  const row = (k, v, cls = "") => `<div class="row" style="padding:5px 0;border-top:1px solid var(--line)"><span class="muted">${k}</span><span class="right ${cls}">${v}</span></div>`;
  sheet(`<h2>${esc(t.desc)}</h2><p class="muted small" style="margin:2px 0 10px">${esc(t.raw)}</p>
    ${row("Amount", `<b class="${into ? "pos" : ""}">${into ? "money in +" : ""}${esc(cents(Math.abs(t.amount)))}</b>`)}
    ${row("Date", esc(wday(t.date)))}${row("Account", esc(t.account))}${row("Bank", esc(t.bank))}
    ${row("Category", esc(t.category || "–"))}${row("Status", esc(t.thru ? "paid back (not spending)" : t.status))}
    ${row(t.credit ? "Owed on the card after" : "Balance after", esc(after))}
    ${t.left != null ? row("Card budget left after", esc(cents(t.left)), t.left < 0 ? "neg" : "") : ""}
    <div class="btns"><button id="tx-close">Close</button></div>`);
  $("#tx-close").onclick = closeSheet;
}

// ------------------------------------------------------------------ Edit
function drawEdit() {
  const d = S.data.edit || (S.data.edit = call("M.edit_json()"));
  const t = S.editTab;
  let h = `<div class="seg3">
    <button data-t="once" class="${t === "once" ? "on" : ""}">One-time</button>
    <button data-t="bills" class="${t === "bills" ? "on" : ""}">Bills</button>
    <button data-t="goals" class="${t === "goals" ? "on" : ""}">Goals</button></div>`;
  if (t === "once") {
    h += `<button class="add" id="e-add">+ Add an expense or income</button><div class="list">`;
    const items = [...d.once].sort((a, b) => String(b.date || "9999").localeCompare(String(a.date || "9999")));
    h += items.map((x) => `<div class="item tap ${x.include ? "" : "dim"}" data-id="${esc(x.id)}">
      <div class="main"><div class="t">${esc(x.concept)}</div>
        <div class="small muted">${x.date ? esc(md(x.date)) : "no date"}${x.category ? ` · ${esc(x.category)}` : ""}${x.include ? "" : " · off"}</div></div>
      <div class="amt">${x.income ? `<b class="pos">+${cents(x.income)}</b>` : ""}${x.charge ? `<b>${cents(x.charge)}</b>` : ""}</div></div>`).join("")
      || `<div class="item muted">No one-time items yet.</div>`;
    h += `</div>`;
  } else if (t === "bills") {
    h += `<button class="add" id="e-add">+ Add a monthly bill</button><div class="list">` + d.bills.map((x) => `<div class="item tap ${x.include ? "" : "dim"}" data-id="${esc(x.id)}">
      <div class="main"><div class="t">${esc(x.concept)}</div>
        <div class="small muted">${x.day ? `day ${esc(x.day)}` : ""}${x.category ? ` · ${esc(x.category)}` : ""}${x.include ? "" : " · off"}</div></div>
      <div class="amt"><b>${cents(x.amount)}</b></div></div>`).join("") + `</div>`;
  } else {
    h += `<button class="add" id="e-add">+ Add a spending goal</button><div class="list">` + d.goals.map((x, i) => `<div class="item tap ${x.include ? "" : "dim"}" data-i="${i}">
      <div class="main"><div class="t">${esc(x.category)}</div><div class="small muted">a month${x.include ? "" : " · off"}</div></div>
      <div class="amt"><b>${cents(x.amount)}</b></div></div>`).join("") + `</div>`;
  }
  view.innerHTML = h;
  view.querySelectorAll(".seg3 button").forEach((b) => (b.onclick = () => { S.editTab = b.dataset.t; drawEdit(); }));
  if (t === "once") {
    $("#e-add").onclick = () => onceSheet(null, d);
    view.querySelectorAll(".item.tap").forEach((el) => (el.onclick = () => onceSheet(d.once.find((x) => x.id === el.dataset.id), d)));
  } else if (t === "bills") {
    $("#e-add").onclick = () => billSheet(null, d);
    view.querySelectorAll(".item.tap").forEach((el) => (el.onclick = () => billSheet(d.bills.find((b) => b.id === el.dataset.id), d)));
  } else {
    $("#e-add").onclick = () => goalSheet(null, d);
    view.querySelectorAll(".item.tap").forEach((el) => (el.onclick = () => goalSheet(d.goals[+el.dataset.i], d)));
  }
}

function onceSheet(x, d) {
  const isNew = !x;
  x = x || { concept: "", charge: 0, income: 0, date: iso(new Date()), card: null, account: null, category: "", include: true, note: "" };
  const income = x.income > 0 && !x.charge;
  const opts = (list, sel) => list.map((o) => `<option value="${esc(o.id)}" ${o.id === sel ? "selected" : ""}>${esc(o.name)}</option>`).join("");
  const paid = x.card ? `c:${x.card}` : x.account ? `a:${x.account}` : "";
  sheet(`<h2>${isNew ? "New item" : "Edit item"}</h2>
    <div class="radio" style="margin-top:10px"><button data-k="charge" class="${income ? "" : "on"}">Expense</button>
      <button data-k="income" class="${income ? "on" : ""}">Income</button></div>
    <label class="f">What</label><input id="o-concept" value="${esc(x.concept)}" placeholder="e.g. Movers deposit">
    <div class="two">
      <div><label class="f">Amount</label><input id="o-amt" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(income ? x.income : x.charge || "")}"></div>
      <div><label class="f">Date</label><input id="o-date" type="date" value="${esc(x.date || "")}"></div>
    </div>
    <label class="f">Paid with / goes to</label>
    <select id="o-paid"><option value="">Main checking (default)</option>
      <optgroup label="Cards">${opts(d.cards.map((c) => ({ id: "c:" + c.id, name: c.name })), paid)}</optgroup>
      <optgroup label="Accounts">${opts(d.banks.map((c) => ({ id: "a:" + c.id, name: c.name })), paid)}</optgroup></select>
    <label class="f">Category</label>
    <select id="o-cat"><option value="">–</option>${d.categories.map((c) => `<option ${c === x.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <label class="f">Note</label><input id="o-note" value="${esc(x.note)}">
    <div class="toggle"><span>Count it in the plan</span><input type="checkbox" id="o-inc" ${x.include ? "checked" : ""}></div>
    <div class="btns">${isNew ? "" : '<button class="del" id="o-del">Delete</button>'}<button class="go" id="o-save">Save</button></div>`);
  let kind = income ? "income" : "charge";
  document.querySelectorAll("#sheet .radio button").forEach((b) => (b.onclick = () => {
    kind = b.dataset.k; document.querySelectorAll("#sheet .radio button").forEach((o) => o.classList.toggle("on", o === b));
  }));
  $("#o-save").onclick = () => {
    const amt = parseFloat($("#o-amt").value || "0");
    if (!$("#o-concept").value.trim()) return toast("Give it a name.");
    if (!(amt > 0)) return toast("Type the amount.");
    const p = $("#o-paid").value;
    edit({ op: "once_save", item: { ...x, concept: $("#o-concept").value.trim(), charge: kind === "charge" ? amt : 0,
      income: kind === "income" ? amt : 0, date: $("#o-date").value || null,
      card: p.startsWith("c:") ? p.slice(2) : null, account: p.startsWith("a:") ? p.slice(2) : null,
      category: $("#o-cat").value, note: $("#o-note").value, include: $("#o-inc").checked } });
  };
  if (!isNew) $("#o-del").onclick = () => { if (confirmTwice($("#o-del"))) edit({ op: "once_delete", id: x.id }); };
}

function billSheet(x, d) {
  const isNew = !x;
  x = x || { concept: "", amount: "", include: true, day: "", category: "", start: "", until: "", paid_with: "p1",
    card: null, account: null, budget_mode: "extra", essential: null, match_kw: "", match_amount: "", match_days: 5, note: "" };
  const where = x.card ? `c:${x.card}` : x.account ? `a:${x.account}` : "";
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(label)}</option>`;
  const ess = x.essential === true ? "yes" : x.essential === false ? "no" : "";
  sheet(`<h2>${isNew ? "New monthly bill" : "Edit bill"}</h2>
    <label class="f">What</label><input id="b-concept" value="${esc(x.concept)}" placeholder="e.g. Internet">
    <div class="two">
      <div><label class="f">Monthly amount</label><input id="b-amt" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(x.amount)}"></div>
      <div><label class="f">Day of month</label><input id="b-day" type="number" inputmode="numeric" min="1" max="31" value="${esc(x.day ?? "")}" placeholder="1-31"></div>
    </div>
    <label class="f">Category</label><input id="b-cat" list="b-cats" value="${esc(x.category)}" placeholder="pick or type">
    <datalist id="b-cats">${d.categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <label class="f">Paid with</label>
    <select id="b-pw">${d.paid_opts.map(([k, v]) => opt(k, v, x.paid_with)).join("")}</select>
    <label class="f">Charged to</label>
    <select id="b-where"><option value="">Main checking (default)</option>
      <optgroup label="Cards">${d.cards.map((c) => opt("c:" + c.id, c.name, where)).join("")}</optgroup>
      <optgroup label="Bank accounts">${d.banks.map((c) => opt("a:" + c.id, c.name, where)).join("")}</optgroup></select>
    <div id="b-modebox"><label class="f">…and the card budget</label>
      <select id="b-mode">${d.budget_modes.map(([k, v]) => opt(k, v, x.budget_mode)).join("")}</select></div>
    <div class="two">
      <div><label class="f">From month</label><input id="b-start" type="month" value="${esc(x.start)}"></div>
      <div><label class="f">Until month</label><input id="b-until" type="month" value="${esc(x.until)}"></div>
    </div>
    <label class="f">Essential?</label>
    <select id="b-ess">${opt("", "Automatic (card budgets = no, bills = yes)", ess)}${opt("yes", "Yes – must be paid", ess)}${opt("no", "No – could be cut", ess)}</select>
    <details style="margin-top:12px"><summary class="small muted">Link to the real payments (optional)</summary>
      <label class="f">Keywords (comma separated, any of them)</label><input id="b-kw" value="${esc(x.match_kw)}" placeholder="verizon wireless">
      <div class="two">
        <div><label class="f">…and amount</label><input id="b-ma" value="${esc(x.match_amount)}" placeholder="129±5 · <150"></div>
        <div><label class="f">…within ± days</label><input id="b-md" type="number" inputmode="numeric" min="0" value="${esc(x.match_days ?? 5)}"></div>
      </div></details>
    <label class="f">Note</label><input id="b-note" value="${esc(x.note)}">
    <div class="toggle"><span>Count it in the plan</span><input type="checkbox" id="b-inc" ${x.include ? "checked" : ""}></div>
    <div class="btns">${isNew ? "" : '<button class="del" id="b-del">Delete</button>'}<button class="go" id="b-save">Save</button></div>`);
  const mode = () => $("#b-modebox").classList.toggle("hidden", !$("#b-where").value.startsWith("c:"));
  $("#b-where").onchange = mode; mode();
  $("#b-save").onclick = () => {
    if (!$("#b-concept").value.trim()) return toast("Give it a name.");
    const amt = parseFloat($("#b-amt").value || "0");
    if (!(amt > 0)) return toast("Type the monthly amount.");
    const w = $("#b-where").value, e = $("#b-ess").value;
    edit({ op: "bill_save", item: { id: x.id || null, concept: $("#b-concept").value.trim(), amount: amt,
      day: $("#b-day").value, category: $("#b-cat").value.trim(), paid_with: $("#b-pw").value,
      card: w.startsWith("c:") ? w.slice(2) : null, account: w.startsWith("a:") ? w.slice(2) : null,
      budget_mode: $("#b-mode").value, start: $("#b-start").value, until: $("#b-until").value,
      essential: e === "yes" ? true : e === "no" ? false : null, match_kw: $("#b-kw").value,
      match_amount: $("#b-ma").value, match_days: $("#b-md").value || 5, note: $("#b-note").value,
      include: $("#b-inc").checked } });
  };
  if (!isNew) $("#b-del").onclick = () => { if (confirmTwice($("#b-del"))) edit({ op: "bill_delete", id: x.id }); };
}

function goalSheet(x, d) {
  const isNew = !x;
  x = x || { category: "", amount: "", include: true };
  const taken = new Set(d.goals.map((g) => g.category));
  sheet(`<h2>${isNew ? "New spending goal" : esc(x.category)}</h2>
    <p class="muted small" style="margin:2px 0 0">A monthly limit for a category, across all your cards. It doesn't change the
      plan; it tracks that category each month.</p>
    ${isNew ? `<label class="f">Category</label><input id="g-cat" list="g-cats" placeholder="pick or type">
      <datalist id="g-cats">${d.categories.filter((c) => !taken.has(c)).map((c) => `<option value="${esc(c)}">`).join("")}</datalist>` : ""}
    <label class="f">Per month</label><input id="g-amt" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(x.amount)}">
    <div class="toggle"><span>Turned on</span><input type="checkbox" id="g-inc" ${x.include ? "checked" : ""}></div>
    <div class="btns">${isNew ? "" : '<button class="del" id="g-del">Delete</button>'}<button class="go" id="g-save">Save</button></div>`);
  $("#g-save").onclick = () => {
    const amt = parseFloat($("#g-amt").value || "0");
    const cat = isNew ? $("#g-cat").value.trim() : x.category;
    if (!cat) return toast("Pick a category.");
    if (!(amt > 0)) return toast("Type the monthly amount.");
    edit({ op: "goal_set", category: cat, amount: amt, include: $("#g-inc").checked, new: isNew });
  };
  if (!isNew) $("#g-del").onclick = () => { if (confirmTwice($("#g-del"))) edit({ op: "goal_delete", category: x.category }); };
}

function confirmTwice(btn, text = "Tap again to delete") {
  if (btn.dataset.sure) return true;
  btn.dataset.sure = 1; btn.textContent = text;
  return false;
}

// ------------------------------------------------------------------ the bottom sheet
function sheet(html) {
  $("#sheet").innerHTML = html;
  $("#sheet").classList.remove("hidden"); $("#veil").classList.remove("hidden");
}
function closeSheet() { $("#sheet").classList.add("hidden"); $("#veil").classList.add("hidden"); }
$("#veil").onclick = closeSheet;

// ------------------------------------------------------------------ saving a change
// Always: download the newest budget.json, apply the change to it, upload it. If GitHub says someone
// else (the computer) saved in between, start over with the newer copy - nothing is overwritten.
async function edit(op) {
  if (S.busy) return toast("One moment – still working.");
  S.busy = true;
  const btn = document.querySelector("#sheet .go"); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    let res;
    for (let attempt = 1; ; attempt++) {
      const cur = await getWithSha("data/budget.json");
      py.FS.writeFile("/data/budget.json", cur.bytes);
      res = call(`M.apply_json(${pyStr(JSON.stringify(op))})`);
      if (!res.ok) break;
      const out = py.FS.readFile("/data/budget.json");
      try {
        await putFile("data/budget.json", out, cur.sha, "budget.json from the phone");
        break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 4) { await sleep(600 * attempt); continue; }
        throw e;
      }
    }
    if (!res.ok) { toast(res.msg); return; }
    closeSheet();
    S.data = {};
    toast(`${res.msg} Saved to GitHub.`);
    show(S.tab);
  } catch (e) {
    toast(`Not saved: ${e.message}`, 6000);
  } finally {
    S.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

// ------------------------------------------------------------------ cloud actions
async function runCloud(send) {
  if (S.busy) return toast("One moment – still working.");
  S.busy = true;
  const b = $("#btn-sync"); b.disabled = true;
  const since = Date.now() - 60_000;
  try {
    const r = await gh(`actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { send: send ? "yes" : "no", kind: "manual" } }),
    });
    if (r.status === 404) throw new Error("The workflow isn't in the repo (did the desktop set up cloud mode?).");
    $("#fresh").textContent = send ? "Sending the report…" : "Syncing your banks…";
    toast(send ? "Started: syncing and sending the report to WhatsApp (1–3 min)." : "Started: syncing your banks (1–3 min).", 5000);
    let run = null;
    for (let i = 0; i < 60; i++) {                  // up to ~8 minutes
      await sleep(i < 3 ? 5000 : 8000);
      const j = await (await gh(`actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`)).json();
      run = (j.workflow_runs || []).find((x) => new Date(x.created_at).getTime() >= since) || run;
      if (run) $("#fresh").textContent = `Cloud: ${run.status.replace("_", " ")}…`;
      if (run && run.status === "completed") break;
    }
    if (!run || run.status !== "completed") throw new Error("It's taking long. Check again in a few minutes (⟳).");
    if (run.conclusion !== "success") throw new Error(`The cloud run ended with "${run.conclusion}". Open GitHub → Actions to see why.`);
    S.busy = false;
    await download();
    show(S.tab);
    toast(send ? "Done – report sent and data updated." : "Done – your data is up to date.");
  } catch (e) {
    toast(e.message, 7000);
    freshness();
  } finally {
    S.busy = false; b.disabled = false;
  }
}

$("#btn-sync").onclick = () => py && S.info && runCloud(false);
$("#btn-reload").onclick = async () => {
  if (!py || S.busy) return;
  try { await download(); show(S.tab); toast("Up to date."); } catch (e) { fail(e); }
};
$("#btn-menu").onclick = () => {
  sheet(`<h2>Menu</h2>
    <div class="list" style="margin-top:10px">
      <div class="item tap" id="mn-send"><div class="main"><div class="t">📲 Send today's report to WhatsApp</div>
        <div class="small muted">Syncs the banks first</div></div></div>
      <div class="item tap" id="mn-sync"><div class="main"><div class="t">🔄 Sync the banks now</div></div></div>
      <div class="item tap" id="mn-reload"><div class="main"><div class="t">⟳ Download the latest data</div>
        <div class="small muted">${S.loadedAt ? `last downloaded ${esc(ago(S.loadedAt))}` : ""}</div></div></div>
      <div class="item tap" id="mn-setup"><div class="main"><div class="t">🔑 Repo and token</div>
        <div class="small muted">${esc(cfg.repo || "not set")}</div></div></div>
      <div class="item tap" id="mn-forget"><div class="main"><div class="t neg">Forget this phone</div>
        <div class="small muted">Removes the token from this phone</div></div></div>
    </div>
    <div class="btns"><button id="mn-close">Close</button></div>`);
  $("#mn-close").onclick = closeSheet;
  $("#mn-send").onclick = () => { closeSheet(); runCloud(true); };
  $("#mn-sync").onclick = () => { closeSheet(); runCloud(false); };
  $("#mn-reload").onclick = () => { closeSheet(); $("#btn-reload").onclick(); };
  $("#mn-setup").onclick = () => { closeSheet(); setupScreen(); };
  $("#mn-forget").onclick = (ev) => {
    if (!confirmTwice(ev.currentTarget.querySelector(".t"), "Tap again to forget this phone")) return;
    cfg.forget(); closeSheet(); S.info = null; setupScreen();
  };
};

// Coming back to the app after a while: get fresh data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.loadedAt && Date.now() - S.loadedAt > 15 * 60_000 && !S.busy)
    $("#btn-reload").onclick();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
start();
