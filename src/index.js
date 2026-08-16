// ========== helpers ==========

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createSessionCookie(env, days = 7) {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  const sig = await sha256Hex(env.ADMIN_PASSWORD + ":" + exp);
  return `${exp}.${sig}`;
}

async function verifySessionCookie(env, cookieValue) {
  if (!cookieValue || !env.ADMIN_PASSWORD) return false;
  const [expStr, sig] = cookieValue.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = await sha256Hex(env.ADMIN_PASSWORD + ":" + exp);
  return sig === expected;
}

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookies = parseCookies(request);
  return await verifySessionCookie(env, cookies.compsilon_admin || "");
}

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      first_name TEXT,
      last_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      unsubscribe_token TEXT NOT NULL UNIQUE,
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
      unsubscribed_at TEXT
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      teaser TEXT NOT NULL,
      tags TEXT,
      issue_date TEXT,
      link TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      recipient_count INTEGER
    )`
  ).run();
}

// ========== email template ==========
// NOTE: [Add your business mailing address here] placeholder must be replaced
// with a real physical mailing address before first real send (CAN-SPAM).

function renderEmailHTML(issue, subscriber) {
  const unsubUrl = `https://compsilon.com/api/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribe_token || "")}`;
  const greetingName = subscriber.first_name ? escapeHtml(subscriber.first_name) : "there";
  const link = issue.link ? `https://compsilon.com/${escapeHtml(issue.link)}` : "https://compsilon.com/newsletter.html";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#06060e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#06060e;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#12122a;border:1px solid #2c2c5c;border-radius:16px;overflow:hidden;">
<tr><td style="padding:28px 32px 20px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:#eeeef6;letter-spacing:-0.5px;">COMP<span style="color:#06d6a0;">SILON</span></span></td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:0;"></td></tr>
<tr><td style="padding:28px 32px 8px;"><span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#06060e;background-color:#06d6a0;padding:5px 14px;border-radius:100px;">${escapeHtml(issue.tags || "Newsletter")}</span></td></tr>
<tr><td style="padding:12px 32px 0;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#eeeef6;line-height:1.3;">${escapeHtml(issue.title)}</span></td></tr>
<tr><td style="padding:16px 32px 0;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#b9bce0;">Hi ${greetingName},<br><br>${escapeHtml(issue.teaser).replace(/\n/g,'<br>')}</span></td></tr>
<tr><td style="padding:28px 32px 32px;"><a href="${link}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#06060e;background-color:#06d6a0;padding:13px 26px;border-radius:100px;text-decoration:none;">Read full issue &rarr;</a></td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:0;"></td></tr>
<tr><td style="padding:20px 32px 28px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#8c90c4;">Compsilon &middot; [Add your business mailing address here]<br>You're receiving this because you subscribed at compsilon.com.<br><a href="${unsubUrl}" style="color:#8c90c4;text-decoration:underline;">Unsubscribe</a></span></td></tr>
</table></td></tr></table></body></html>`;
}

function unsubscribePageHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed — Compsilon</title></head>
<body style="margin:0;background:#06060e;color:#dcdef2;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;">
<div><h1 style="color:#eeeef6;">You've been unsubscribed</h1><p style="color:#8c90c4;">You won't receive any more Compsilon newsletter emails.</p><a href="https://compsilon.com" style="color:#06d6a0;">Return to compsilon.com</a></div>
</body></html>`;
}

async function sendWelcomeEmail(env, subscriber) {
  if (!env.RESEND_API_KEY) return;
  const issue = { title: "Welcome to Compsilon", tags: "Welcome",
    teaser: "Thanks for subscribing. You'll get one issue a week on AI governance, risk and compliance — practical, not theoretical.",
    link: "newsletter.html" };
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Compsilon <newsletter@compsilon.com>",
        to: [subscriber.email],
        subject: "Welcome to Compsilon",
        html: renderEmailHTML(issue, subscriber),
      }),
    });
  } catch (err) { /* non-fatal */ }
}

// ========== public routes ==========

async function handleSubscribe(request, env, ctx) {
  await ensureSchema(env);
  const ct = request.headers.get("content-type") || "";
  let data;
  if (ct.includes("application/json")) data = await request.json();
  else { const form = await request.formData(); data = Object.fromEntries(form.entries()); }

  const email = String(data.EMAIL || data.email || "").trim().toLowerCase();
  const firstName = String(data.FNAME || data.firstName || "").trim();
  const lastName = String(data.LNAME || data.lastName || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response("Invalid email", { status: 400 });
  }

  const existing = await env.DB.prepare("SELECT id, status FROM subscribers WHERE email = ?").bind(email).first();
  if (existing) {
    if (existing.status !== "active") {
      await env.DB.prepare("UPDATE subscribers SET status = 'active', unsubscribed_at = NULL WHERE id = ?").bind(existing.id).run();
    }
  } else {
    const token = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO subscribers (email, first_name, last_name, status, unsubscribe_token) VALUES (?, ?, ?, 'active', ?)`
    ).bind(email, firstName, lastName, token).run();
    ctx.waitUntil(sendWelcomeEmail(env, { email, first_name: firstName, unsubscribe_token: token }));
  }

  return new Response(
    "<!DOCTYPE html><html><body style='font-family:sans-serif;background:#06060e;color:#dcdef2;padding:24px;'>Thanks for subscribing.</body></html>",
    { headers: { "Content-Type": "text/html" } }
  );
}

async function handleUnsubscribe(request, env, url) {
  await ensureSchema(env);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });
  const sub = await env.DB.prepare("SELECT id FROM subscribers WHERE unsubscribe_token = ?").bind(token).first();
  if (!sub) return new Response("Not found", { status: 404 });
  await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?").bind(sub.id).run();
  return new Response(unsubscribePageHTML(), { headers: { "Content-Type": "text/html" } });
}

async function dbCheck(env) {
  try { await ensureSchema(env); const r = await env.DB.prepare("SELECT 1 AS ok").first(); return json({ status: "connected", result: r }); }
  catch (err) { return json({ status: "error", message: String(err) }, 500); }
}

// ========== auth pages ==========

function loginPageHTML(errorMsg) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin Login — Compsilon</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#06060e;color:#dcdef2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#12122a;border:1px solid #2c2c5c;border-radius:16px;padding:40px;max-width:400px;width:100%}
  .brand{font-size:22px;font-weight:800;color:#eeeef6;letter-spacing:-0.5px;text-align:center;margin-bottom:8px}
  .brand span{color:#06d6a0}
  .sub{text-align:center;color:#8c90c4;font-size:13px;margin-bottom:32px}
  label{display:block;font-size:12px;color:#8c90c4;margin-bottom:6px;font-weight:600;letter-spacing:0.3px}
  input{width:100%;padding:12px 14px;background:#06060e;border:1px solid #2c2c5c;color:#eeeef6;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:16px}
  input:focus{outline:none;border-color:#06d6a0}
  button{width:100%;padding:13px;background:#06d6a0;color:#06060e;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}
  button:hover{background:#05c091}
  .err{background:#3a1a1a;border:1px solid #7c2828;color:#f4a1a1;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px}
  .back{text-align:center;margin-top:24px;font-size:12px}
  .back a{color:#8c90c4;text-decoration:none}
  .back a:hover{color:#06d6a0}
</style></head>
<body><div class="card">
<div class="brand">COMP<span>SILON</span></div>
<div class="sub">Admin sign in</div>
${errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ""}
<form method="POST" action="/admin/login">
<label for="u">Username</label>
<input id="u" name="username" type="text" autocomplete="username" required autofocus>
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
<div class="back"><a href="/">&larr; Back to compsilon.com</a></div>
</div></body></html>`;
}

async function handleLoginGet(request, env) {
  if (await isAuthed(request, env)) return Response.redirect(new URL(request.url).origin + "/admin", 302);
  return new Response(loginPageHTML(null), { headers: { "Content-Type": "text/html" } });
}

async function handleLoginPost(request, env) {
  const form = await request.formData();
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (!env.ADMIN_PASSWORD) return new Response(loginPageHTML("Admin password not configured on the server."), { status: 500, headers: { "Content-Type": "text/html" } });
  if (username !== "admin" || password !== env.ADMIN_PASSWORD) {
    return new Response(loginPageHTML("Incorrect username or password."), { status: 401, headers: { "Content-Type": "text/html" } });
  }
  const cookie = await createSessionCookie(env);
  const origin = new URL(request.url).origin;
  return new Response(null, {
    status: 302,
    headers: {
      "Location": origin + "/admin",
      "Set-Cookie": `compsilon_admin=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
    },
  });
}

function handleLogout(request) {
  const origin = new URL(request.url).origin;
  return new Response(null, {
    status: 302,
    headers: {
      "Location": origin + "/admin/login",
      "Set-Cookie": `compsilon_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

// ========== admin dashboard (single-page tabbed UI) ==========

function adminAppHTML() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin — Compsilon</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#06060e;color:#dcdef2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;min-height:100vh}
  header{background:#0d0d1e;border-bottom:1px solid #2c2c5c;padding:16px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
  .brand{font-size:18px;font-weight:800;color:#eeeef6;letter-spacing:-0.4px}
  .brand span{color:#06d6a0}
  nav{display:flex;gap:4px}
  .tab{background:none;border:none;color:#8c90c4;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .tab.on{background:#12122a;color:#eeeef6}
  .tab:hover:not(.on){color:#eeeef6}
  .logout{background:none;border:1px solid #2c2c5c;color:#8c90c4;padding:8px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;text-decoration:none}
  .logout:hover{border-color:#7c2828;color:#f4a1a1}
  main{max-width:1100px;margin:0 auto;padding:32px}
  .panel{display:none}
  .panel.on{display:block}
  h1{font-size:22px;color:#eeeef6;margin-bottom:6px;font-weight:700}
  .sub{color:#8c90c4;font-size:13px;margin-bottom:28px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
  .stat{background:#12122a;border:1px solid #2c2c5c;border-radius:12px;padding:20px}
  .stat-num{font-size:28px;font-weight:800;color:#eeeef6;line-height:1;margin-bottom:6px}
  .stat-num.green{color:#06d6a0}
  .stat-num.muted{color:#8c90c4}
  .stat-label{font-size:11px;color:#8c90c4;text-transform:uppercase;letter-spacing:1px;font-weight:600}
  .card{background:#12122a;border:1px solid #2c2c5c;border-radius:12px;padding:24px;margin-bottom:24px}
  .card h2{font-size:15px;color:#eeeef6;margin-bottom:16px;font-weight:700}
  label{display:block;font-size:11px;color:#8c90c4;margin-bottom:6px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase}
  input,textarea,select{width:100%;padding:11px 13px;background:#06060e;border:1px solid #2c2c5c;color:#eeeef6;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:14px}
  input:focus,textarea:focus{outline:none;border-color:#06d6a0}
  textarea{resize:vertical;min-height:100px;font-family:inherit}
  button.primary{background:#06d6a0;color:#06060e;border:none;padding:11px 20px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit}
  button.primary:hover{background:#05c091}
  button.secondary{background:#2c2c5c;color:#eeeef6;border:none;padding:8px 14px;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;font-family:inherit;margin-right:6px}
  button.secondary:hover{background:#3d3d7a}
  button.danger{background:#7c2828;color:#f4a1a1;border:none;padding:8px 14px;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;font-family:inherit}
  button.danger:hover{background:#9c3030}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:12px 10px;font-size:11px;color:#8c90c4;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #2c2c5c}
  td{padding:14px 10px;font-size:13px;border-bottom:1px solid #1e1e3a;color:#dcdef2;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:3px 10px;border-radius:100px;font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase}
  .badge.active{background:#0d3b2c;color:#06d6a0}
  .badge.unsub{background:#3a1a1a;color:#f4a1a1}
  .badge.draft{background:#2c2c5c;color:#b9bce0}
  .badge.sent{background:#0d3b2c;color:#06d6a0}
  .toast{position:fixed;bottom:24px;right:24px;background:#12122a;border:1px solid #06d6a0;color:#eeeef6;padding:14px 20px;border-radius:8px;font-size:13px;z-index:100;display:none}
  .toast.err{border-color:#7c2828;color:#f4a1a1}
  .empty{text-align:center;padding:40px;color:#8c90c4;font-size:13px}
  .search{margin-bottom:16px}
  .search input{max-width:320px;margin-bottom:0}
  .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .form-grid .full{grid-column:1/-1}
  .actions{display:flex;gap:8px;align-items:center}
  .preview-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:50;align-items:center;justify-content:center;padding:20px}
  .preview-modal.on{display:flex}
  .preview-inner{background:#0d0d1e;border-radius:12px;max-width:700px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column}
  .preview-head{padding:16px 20px;border-bottom:1px solid #2c2c5c;display:flex;justify-content:space-between;align-items:center}
  .preview-head h3{font-size:14px;color:#eeeef6}
  .preview-body{flex:1;overflow:auto}
  .preview-body iframe{width:100%;height:70vh;border:0;background:#06060e}
  a.link{color:#06d6a0;text-decoration:none}
  a.link:hover{text-decoration:underline}
</style></head>
<body>
<header>
  <div class="brand">COMP<span>SILON</span> &middot; <span style="color:#8c90c4;font-weight:400;font-size:14px;">admin</span></div>
  <nav>
    <button class="tab on" data-tab="dashboard">Dashboard</button>
    <button class="tab" data-tab="subscribers">Subscribers</button>
    <button class="tab" data-tab="newsletters">Newsletters</button>
  </nav>
  <a class="logout" href="/admin/logout">Logout</a>
</header>
<main>

<section id="dashboard" class="panel on">
  <h1>Dashboard</h1>
  <p class="sub">Overview of your subscriber list and newsletter activity.</p>
  <div class="stats">
    <div class="stat"><div class="stat-num green" id="s-active">–</div><div class="stat-label">Active subscribers</div></div>
    <div class="stat"><div class="stat-num muted" id="s-unsub">–</div><div class="stat-label">Unsubscribed</div></div>
    <div class="stat"><div class="stat-num" id="s-drafts">–</div><div class="stat-label">Drafts</div></div>
    <div class="stat"><div class="stat-num" id="s-sent">–</div><div class="stat-label">Sent issues</div></div>
  </div>
  <div class="card"><h2>Recent activity</h2><div id="activity"><div class="empty">Loading…</div></div></div>
</section>

<section id="subscribers" class="panel">
  <h1>Subscribers</h1>
  <p class="sub">Everyone who has signed up via the compsilon.com forms.</p>
  <div class="search"><input id="sub-search" placeholder="Search by email or name…"></div>
  <div class="card"><div id="sub-table"><div class="empty">Loading…</div></div></div>
</section>

<section id="newsletters" class="panel">
  <h1>Newsletters</h1>
  <p class="sub">Write, save, preview, test-send, and send weekly issues.</p>
  <div class="card">
    <h2>New draft</h2>
    <form id="draft-form">
      <div class="form-grid">
        <div><label>Slug (unique)</label><input name="slug" placeholder="issue-03" required></div>
        <div><label>Display date</label><input name="issue_date" placeholder="17 Aug 2026"></div>
        <div class="full"><label>Title</label><input name="title" placeholder="What building AI governance does to the rest of your compliance function" required></div>
        <div class="full"><label>Teaser paragraph</label><textarea name="teaser" placeholder="Short intro paragraph subscribers will read in the email — a hook before they click through." required></textarea></div>
        <div><label>Tag</label><input name="tags" placeholder="Governance"></div>
        <div><label>Full-issue link path</label><input name="link" placeholder="issue-03.html"></div>
      </div>
      <button type="submit" class="primary">Save draft</button>
    </form>
  </div>
  <div class="card"><h2>All issues</h2><div id="issues-table"><div class="empty">Loading…</div></div></div>
</section>

</main>

<div class="preview-modal" id="preview-modal">
  <div class="preview-inner">
    <div class="preview-head"><h3 id="preview-title">Email preview</h3><button class="secondary" onclick="closePreview()">Close</button></div>
    <div class="preview-body"><iframe id="preview-frame"></iframe></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ---- tabs ----
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  document.getElementById(t.dataset.tab).classList.add('on');
}));

// ---- helpers ----
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
  t.style.display = 'block';
  clearTimeout(window._toastT);
  window._toastT = setTimeout(() => t.style.display = 'none', 3500);
}
async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function escape(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(dt) { if (!dt) return '—'; return dt.replace('T',' ').replace(/\\..*/,''); }

// ---- dashboard ----
async function loadStats() {
  try {
    const [subs, issues] = await Promise.all([api('/admin/api/subscribers'), api('/admin/api/issues')]);
    const active = subs.filter(s => s.status === 'active').length;
    const unsub = subs.filter(s => s.status === 'unsubscribed').length;
    const drafts = issues.filter(i => !i.sent_at).length;
    const sent = issues.filter(i => i.sent_at).length;
    document.getElementById('s-active').textContent = active;
    document.getElementById('s-unsub').textContent = unsub;
    document.getElementById('s-drafts').textContent = drafts;
    document.getElementById('s-sent').textContent = sent;

    const recent = subs.slice(0, 5);
    const act = document.getElementById('activity');
    if (!recent.length) { act.innerHTML = '<div class="empty">No subscribers yet.</div>'; return; }
    act.innerHTML = '<table><tr><th>Latest subscribers</th><th>Joined</th></tr>' +
      recent.map(s => '<tr><td>' + escape(s.email) + '</td><td>' + fmt(s.subscribed_at) + '</td></tr>').join('') + '</table>';
  } catch (e) { toast('Failed to load stats: ' + e.message, true); }
}

// ---- subscribers ----
let allSubs = [];
async function loadSubs() {
  try {
    allSubs = await api('/admin/api/subscribers');
    renderSubs(allSubs);
  } catch (e) { toast('Failed to load subscribers: ' + e.message, true); }
}
function renderSubs(list) {
  const el = document.getElementById('sub-table');
  if (!list.length) { el.innerHTML = '<div class="empty">No subscribers match.</div>'; return; }
  el.innerHTML = '<table><tr><th>Email</th><th>First name</th><th>Last name</th><th>Status</th><th>Subscribed</th><th>Unsubscribed</th></tr>' +
    list.map(s => '<tr>' +
      '<td>' + escape(s.email) + '</td>' +
      '<td>' + escape(s.first_name || '—') + '</td>' +
      '<td>' + escape(s.last_name || '—') + '</td>' +
      '<td><span class="badge ' + (s.status === 'active' ? 'active' : 'unsub') + '">' + s.status + '</span></td>' +
      '<td>' + fmt(s.subscribed_at) + '</td>' +
      '<td>' + fmt(s.unsubscribed_at) + '</td>' +
    '</tr>').join('') + '</table>';
}
document.getElementById('sub-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderSubs(allSubs.filter(s =>
    (s.email && s.email.toLowerCase().includes(q)) ||
    (s.first_name && s.first_name.toLowerCase().includes(q)) ||
    (s.last_name && s.last_name.toLowerCase().includes(q))
  ));
});

// ---- newsletters ----
async function loadIssues() {
  try {
    const issues = await api('/admin/api/issues');
    const el = document.getElementById('issues-table');
    if (!issues.length) { el.innerHTML = '<div class="empty">No drafts yet. Create one above.</div>'; return; }
    el.innerHTML = '<table><tr><th>Title</th><th>Slug</th><th>Status</th><th>Recipients</th><th>Actions</th></tr>' +
      issues.map(i => '<tr>' +
        '<td>' + escape(i.title) + '</td>' +
        '<td style="color:#8c90c4;font-size:12px;">' + escape(i.slug) + '</td>' +
        '<td>' + (i.sent_at ? '<span class="badge sent">Sent</span>' : '<span class="badge draft">Draft</span>') + '</td>' +
        '<td>' + (i.sent_at ? (i.recipient_count || 0) + ' &middot; ' + fmt(i.sent_at) : '—') + '</td>' +
        '<td class="actions">' +
          '<button class="secondary" onclick="preview(\\'' + i.slug + '\\')">Preview</button>' +
          (i.sent_at ? '' :
            '<button class="secondary" onclick="testSend(\\'' + i.slug + '\\')">Send test</button>' +
            '<button class="primary" style="padding:8px 14px;font-size:12px;" onclick="sendReal(\\'' + i.slug + '\\')">Send to all</button>') +
        '</td>' +
      '</tr>').join('') + '</table>';
  } catch (e) { toast('Failed to load issues: ' + e.message, true); }
}
document.getElementById('draft-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api('/admin/api/issues/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    toast('Draft saved.');
    e.target.reset();
    loadIssues(); loadStats();
  } catch (err) { toast('Save failed: ' + err.message, true); }
});
async function preview(slug) {
  document.getElementById('preview-title').textContent = 'Preview — ' + slug;
  document.getElementById('preview-frame').src = '/admin/api/issues/preview?slug=' + encodeURIComponent(slug);
  document.getElementById('preview-modal').classList.add('on');
}
function closePreview() {
  document.getElementById('preview-modal').classList.remove('on');
  document.getElementById('preview-frame').src = 'about:blank';
}
async function testSend(slug) {
  const email = prompt('Send a test copy to which email address?');
  if (!email) return;
  try {
    await api('/admin/api/issues/test-send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({slug, email}) });
    toast('Test sent to ' + email);
  } catch (err) { toast('Test failed: ' + err.message, true); }
}
async function sendReal(slug) {
  if (!confirm('Send "' + slug + '" to every ACTIVE subscriber? This cannot be undone.')) return;
  try {
    const r = await api('/admin/api/issues/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({slug}) });
    toast('Sent to ' + r.sent + ' subscribers.');
    loadIssues(); loadStats();
  } catch (err) { toast('Send failed: ' + err.message, true); }
}

// initial load
loadStats(); loadSubs(); loadIssues();
</script>
</body></html>`;
}

// ========== admin API ==========

async function apiListSubscribers(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT id, email, first_name, last_name, status, subscribed_at, unsubscribed_at FROM subscribers ORDER BY subscribed_at DESC").all();
  return json(results);
}

async function apiListIssues(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT id, slug, title, teaser, tags, issue_date, link, created_at, sent_at, recipient_count FROM issues ORDER BY created_at DESC").all();
  return json(results);
}

async function apiSaveIssue(request, env) {
  await ensureSchema(env);
  const data = await request.json();
  const { slug, title, teaser, tags, issue_date, link } = data;
  if (!slug || !title || !teaser) return json({ error: "slug, title and teaser are required" }, 400);
  await env.DB.prepare(
    `INSERT INTO issues (slug, title, teaser, tags, issue_date, link) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, teaser=excluded.teaser, tags=excluded.tags, issue_date=excluded.issue_date, link=excluded.link`
  ).bind(slug, title, teaser, tags || "", issue_date || "", link || "").run();
  return json({ ok: true });
}

async function apiPreviewIssue(env, url) {
  await ensureSchema(env);
  const slug = url.searchParams.get("slug");
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?").bind(slug).first();
  if (!issue) return new Response("Issue not found", { status: 404 });
  const html = renderEmailHTML(issue, { first_name: "Reader", unsubscribe_token: "preview-token" });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function apiTestSend(request, env) {
  await ensureSchema(env);
  const { slug, email } = await request.json();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?").bind(slug).first();
  if (!issue) return json({ error: "Issue not found" }, 404);
  if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 400);
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Compsilon <newsletter@compsilon.com>",
      to: [email],
      subject: "[TEST] " + issue.title,
      html: renderEmailHTML(issue, { first_name: "", unsubscribe_token: "test-token" }),
    }),
  });
  if (!resp.ok) { const t = await resp.text(); return json({ error: `Resend error: ${t}` }, 502); }
  return json({ ok: true });
}

async function apiSendIssue(request, env) {
  await ensureSchema(env);
  const { slug } = await request.json();
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?").bind(slug).first();
  if (!issue) return json({ error: "Issue not found" }, 404);
  if (issue.sent_at) return json({ error: "This issue has already been sent" }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 400);

  const { results: subs } = await env.DB.prepare("SELECT * FROM subscribers WHERE status = 'active'").all();
  if (!subs.length) return json({ error: "No active subscribers" }, 400);

  let sent = 0;
  // Resend batch endpoint accepts up to 100 emails per call
  for (let i = 0; i < subs.length; i += 100) {
    const chunk = subs.slice(i, i + 100);
    const payload = chunk.map(sub => ({
      from: "Compsilon <newsletter@compsilon.com>",
      to: [sub.email],
      subject: issue.title,
      html: renderEmailHTML(issue, sub),
    }));
    const resp = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) { sent += chunk.length; }
    else { const t = await resp.text(); return json({ error: `Resend error: ${t}`, sentSoFar: sent }, 502); }
  }

  await env.DB.prepare("UPDATE issues SET sent_at = datetime('now'), recipient_count = ? WHERE id = ?").bind(sent, issue.id).run();
  return json({ ok: true, sent });
}

// ========== router ==========

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // public API
      if (path === "/api/db-check") return await dbCheck(env);
      if (path === "/api/env-check") {
        return json({
          bindings: Object.keys(env).sort(),
          hasAdminPassword: Boolean(env.ADMIN_PASSWORD),
          hasResendKey: Boolean(env.RESEND_API_KEY),
          hasDB: Boolean(env.DB),
        });
      }
      if (path === "/api/subscribe" && method === "POST") return await handleSubscribe(request, env, ctx);
      if (path === "/api/unsubscribe" && method === "GET") return await handleUnsubscribe(request, env, url);

      // auth
      if (path === "/admin/login" && method === "GET") return await handleLoginGet(request, env);
      if (path === "/admin/login" && method === "POST") return await handleLoginPost(request, env);
      if (path === "/admin/logout") return handleLogout(request);

      // gated admin
      if (path === "/admin" || path === "/admin/") {
        if (!(await isAuthed(request, env))) return Response.redirect(url.origin + "/admin/login", 302);
        return new Response(adminAppHTML(), { headers: { "Content-Type": "text/html" } });
      }
      if (path.startsWith("/admin/api/")) {
        if (!(await isAuthed(request, env))) return json({ error: "Not authenticated" }, 401);
        if (path === "/admin/api/subscribers" && method === "GET") return await apiListSubscribers(env);
        if (path === "/admin/api/issues" && method === "GET") return await apiListIssues(env);
        if (path === "/admin/api/issues/save" && method === "POST") return await apiSaveIssue(request, env);
        if (path === "/admin/api/issues/preview" && method === "GET") return await apiPreviewIssue(env, url);
        if (path === "/admin/api/issues/test-send" && method === "POST") return await apiTestSend(request, env);
        if (path === "/admin/api/issues/send" && method === "POST") return await apiSendIssue(request, env);
      }

      // legacy redirect for the old admin URL
      if (path === "/admin/newsletter") return Response.redirect(url.origin + "/admin", 302);
    } catch (err) {
      return new Response("Server error: " + String(err), { status: 500 });
    }

    return env.ASSETS.fetch(request);
  },
};
