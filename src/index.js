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
  // Safe migration: add body_html column if it doesn't exist yet.
  try {
    await env.DB.prepare("ALTER TABLE issues ADD COLUMN body_html TEXT").run();
  } catch (e) { /* column already exists — ignore */ }
  // Map each Resend email ID back to which issue and which subscriber it belongs to.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS email_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      subscriber_id INTEGER,
      email TEXT NOT NULL,
      resend_email_id TEXT UNIQUE,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  // Every Resend webhook event lands here (delivered, opened, clicked, bounced, complained).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resend_email_id TEXT,
      event_type TEXT NOT NULL,
      url TEXT,
      recipient TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

// ========== email template ==========
// NOTE: [Add your business mailing address here] placeholder must be replaced
// with a real physical mailing address before first real send (CAN-SPAM).

function renderEmailHTML(issue, subscriber) {
  const unsubUrl = `https://compsilon.com/api/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribe_token || "")}`;
  const greetingName = subscriber.first_name ? escapeHtml(subscriber.first_name) : "there";
  const webUrl = `https://compsilon.com/newsletter/${escapeHtml(issue.slug)}`;
  const bodyHtml = issue.body_html || `<p>${escapeHtml(issue.teaser).replace(/\n/g, '<br>')}</p>`;
  const dateLine = issue.issue_date ? escapeHtml(issue.issue_date) : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body{margin:0;padding:0;background-color:#06060e;font-family:Arial,Helvetica,sans-serif;}
  .article h2{font:700 20px Arial,Helvetica,sans-serif;color:#eeeef6;margin:32px 0 12px;letter-spacing:-.3px;}
  .article h3{font:600 16px Arial,Helvetica,sans-serif;color:#eeeef6;margin:24px 0 8px;}
  .article p{font:400 15px/1.75 Arial,Helvetica,sans-serif;color:#b9bce0;margin:0 0 14px;}
  .article strong{color:#dcdef2;font-weight:600;}
  .article a{color:#06d6a0;text-decoration:underline;}
  .article ul{margin:0 0 18px;padding:0;list-style:none;}
  .article ul li{font:400 14.5px/1.7 Arial,Helvetica,sans-serif;color:#b9bce0;padding:6px 0 6px 22px;position:relative;}
  .article ul li:before{content:'▸';position:absolute;left:0;color:#EF9F27;}
  .article ol{margin:0 0 18px;padding-left:22px;color:#b9bce0;}
  .article ol li{font:400 14.5px/1.7 Arial,Helvetica,sans-serif;color:#b9bce0;padding:4px 0;}
  .callout{background:#0d0d1a;border-left:3px solid #EF9F27;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0;}
  .callout p{font:400 14px/1.7 Arial,Helvetica,sans-serif;color:#c4c6e8;margin:0;}
  .case{background:#0d0d1a;border:1px solid #2c2c5c;border-radius:10px;padding:18px;margin:20px 0;}
  .case-tag{font:700 10px Arial,Helvetica,sans-serif;text-transform:uppercase;letter-spacing:1.2px;color:#EF9F27;margin-bottom:6px;display:block;}
  .case h4{font:700 15px Arial,Helvetica,sans-serif;color:#eeeef6;margin:0 0 6px;}
  .case p{font:400 13px/1.65 Arial,Helvetica,sans-serif;color:#8c90c4;margin:0 0 10px;}
  .case .src{font:400 12px Arial,Helvetica,sans-serif;color:#8c90c4;border-top:1px solid #2c2c5c;padding-top:8px;}
  .case .src a{color:#06d6a0;text-decoration:none;margin-right:10px;}
  .checklist{background:#0d0d1a;border:1px solid #2c2c5c;border-radius:10px;padding:18px 20px;margin:22px 0;}
  .checklist h4{font:700 11px Arial,Helvetica,sans-serif;text-transform:uppercase;letter-spacing:1.2px;color:#06d6a0;margin:0 0 10px;}
  .checklist ul{margin:0;padding:0;list-style:none;}
  .checklist li{font:400 13.5px/1.65 Arial,Helvetica,sans-serif;color:#b9bce0;padding:7px 0 7px 24px;border-bottom:1px solid #2c2c5c;position:relative;}
  .checklist li:last-child{border-bottom:none;}
  .checklist li:before{content:'☐';color:#EF9F27;position:absolute;left:0;}
</style>
</head>
<body style="margin:0;padding:0;background-color:#06060e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#06060e;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background-color:#12122a;border:2px solid #EF9F27;border-radius:16px;overflow:hidden;">
<tr><td style="padding:26px 32px 18px;">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:#eeeef6;letter-spacing:-0.5px;">COMP<span style="color:#EF9F27;">SILON</span></span>
<span style="float:right;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8c90c4;line-height:32px;"><a href="${webUrl}" style="color:#8c90c4;text-decoration:none;">View in browser</a></span>
</td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:0;"></td></tr>
<tr><td style="padding:24px 32px 8px;">
<span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#06060e;background-color:#EF9F27;padding:5px 14px;border-radius:100px;">${escapeHtml(issue.tags || "Newsletter")}</span>
${dateLine ? `<span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8c90c4;margin-left:10px;">${dateLine}</span>` : ""}
</td></tr>
<tr><td style="padding:12px 32px 0;">
<h1 style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;color:#eeeef6;line-height:1.25;margin:0 0 6px;letter-spacing:-0.5px;">${escapeHtml(issue.title)}</h1>
</td></tr>
<tr><td style="padding:14px 32px 0;">
<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#b9bce0;margin:0;">Hi ${greetingName},</p>
</td></tr>
<tr><td style="padding:14px 32px 8px;" class="article">
${bodyHtml}
</td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:24px 0 0;"></td></tr>
<tr><td style="padding:18px 32px 26px;">
<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#8c90c4;margin:0;">
Compsilon &middot; [Add your business mailing address here]<br>
You're receiving this because you subscribed at compsilon.com.<br>
<a href="${unsubUrl}" style="color:#8c90c4;text-decoration:underline;">Unsubscribe</a> &middot; <a href="${webUrl}" style="color:#8c90c4;text-decoration:underline;">Read on the web</a>
</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
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
  .preview-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:50;align-items:center;justify-content:center;padding:12px}
  .preview-modal.on{display:flex}
  .preview-inner{background:#0d0d1e;border-radius:12px;max-width:1100px;width:96vw;height:92vh;overflow:hidden;display:flex;flex-direction:column}
  .preview-head{padding:14px 18px;border-bottom:1px solid #2c2c5c;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
  .preview-head h3{font-size:13px;color:#eeeef6;font-weight:500}
  .preview-body{flex:1;overflow:hidden}
  .preview-body iframe{width:100%;height:100%;border:0;background:#06060e;display:block}
  a.link{color:#06d6a0;text-decoration:none}
  a.link:hover{text-decoration:underline}
  .topics-picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 14px;background:#06060e;border:1px solid #2c2c5c;border-radius:8px;padding:14px}
  .tpk{display:flex;align-items:center;gap:8px;font-size:13px;color:#dcdef2;cursor:pointer;padding:4px 0}
  .tpk input{width:auto;margin:0;accent-color:#06d6a0}
  input[type="date"]{color-scheme:dark}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:800px){.two-col{grid-template-columns:1fr}}
  .filters{display:flex;gap:6px;margin-bottom:16px}
  .filter-btn{background:#12122a;border:1px solid #2c2c5c;color:#8c90c4;padding:7px 14px;border-radius:100px;font:600 12px inherit;cursor:pointer}
  .filter-btn.on{background:#06d6a020;border-color:#06d6a0;color:#06d6a0}
  .filter-btn .n{opacity:0.7;margin-left:6px}
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
  <div class="two-col">
    <div class="card"><h2>Latest subscribers</h2><div id="latest-subs"><div class="empty">Loading&hellip;</div></div></div>
    <div class="card"><h2>Recent unsubscribes</h2><div id="latest-unsubs"><div class="empty">Loading&hellip;</div></div></div>
  </div>
</section>

<section id="subscribers" class="panel">
  <h1>Subscribers</h1>
  <p class="sub">Everyone who has signed up via the compsilon.com forms.</p>
  <div class="filters" id="sub-filters">
    <button class="filter-btn on" data-f="all">All <span class="n" id="f-n-all">0</span></button>
    <button class="filter-btn" data-f="active">Active <span class="n" id="f-n-active">0</span></button>
    <button class="filter-btn" data-f="unsubscribed">Unsubscribed <span class="n" id="f-n-unsub">0</span></button>
  </div>
  <div class="search"><input id="sub-search" placeholder="Search by email or name…"></div>
  <div class="card"><div id="sub-table"><div class="empty">Loading…</div></div></div>
</section>

<section id="newsletters" class="panel">
  <h1>Newsletters</h1>
  <p class="sub">Generate with AI, or write by hand. Preview, test-send, and send weekly issues.</p>

  <div class="card">
    <h2>Generate with AI</h2>
    <p class="sub" style="margin-bottom:16px">Give Claude the topics, sources, and date. It returns a full draft &mdash; title, email teaser, and rich page body &mdash; that you can review, edit, and save.</p>
    <form id="ai-form">
      <div class="form-grid">
        <div class="full">
          <label>Topics of interest (required &mdash; tick one or more)</label>
          <div class="topics-picker" id="topics-picker">
            <label class="tpk"><input type="checkbox" value="EU AI Act enforcement and evolving obligations"> EU AI Act enforcement</label>
            <label class="tpk"><input type="checkbox" value="NIST AI RMF adoption and mapping"> NIST AI RMF</label>
            <label class="tpk"><input type="checkbox" value="ISO/IEC 42001 certification pathway"> ISO 42001</label>
            <label class="tpk"><input type="checkbox" value="ISO 27001 controls extended for AI"> ISO 27001 for AI</label>
            <label class="tpk"><input type="checkbox" value="SOC 2 Type II operating-effectiveness testing"> SOC 2</label>
            <label class="tpk"><input type="checkbox" value="DORA operational resilience testing"> DORA</label>
            <label class="tpk"><input type="checkbox" value="Third-party and vendor AI risk assessment"> Third-party / vendor risk</label>
            <label class="tpk"><input type="checkbox" value="AI agent governance and accountability"> AI agent governance</label>
            <label class="tpk"><input type="checkbox" value="MCP server integration security and oversight"> MCP server security</label>
            <label class="tpk"><input type="checkbox" value="Continuous compliance and control testing"> Continuous compliance</label>
            <label class="tpk"><input type="checkbox" value="GDPR / CCPA data protection for AI systems"> Data protection (GDPR/CCPA)</label>
            <label class="tpk"><input type="checkbox" value="Data retention and AI training-data contractual obligations"> Data retention</label>
            <label class="tpk"><input type="checkbox" value="Model risk management and validation"> Model risk management</label>
            <label class="tpk"><input type="checkbox" value="AI incident response and post-incident review"> AI incident response</label>
            <label class="tpk"><input type="checkbox" value="Audit readiness and evidence collection"> Audit readiness</label>
            <label class="tpk"><input type="checkbox" value="Board and executive oversight of AI risk"> Board / executive oversight</label>
            <label class="tpk"><input type="checkbox" value="Bias, fairness, and transparency requirements"> Bias &amp; fairness</label>
            <label class="tpk"><input type="checkbox" value="Regulatory sandboxes and enforcement trends"> Regulatory sandboxes</label>
          </div>
          <textarea name="topics_extra" placeholder="Optional: add a custom topic or angle not in the list above" style="margin-top:10px" rows="2"></textarea>
          <input type="hidden" name="topics" id="topics-hidden">
        </div>
        <div>
          <label>Publish date (optional)</label>
          <input type="date" name="publish_date">
        </div>
        <div>
          <label>Tag / category</label>
          <select name="tag">
            <option value="">— select —</option>
            <option>Governance</option>
            <option>Risk</option>
            <option>Compliance</option>
            <option>Agents</option>
            <option>EU AI Act</option>
            <option>NIST AI RMF</option>
            <option>ISO 42001</option>
            <option>ISO 27001</option>
            <option>SOC 2</option>
            <option>DORA</option>
            <option>Data Protection</option>
            <option>Threat Intel</option>
            <option>Frameworks</option>
          </select>
        </div>
        <div class="full"><label>Sources (URLs, one per line) &mdash; only these will be cited</label><textarea name="sources" placeholder="https://example.com/report&#10;https://gov.uk/guidance/..."></textarea></div>
        <div class="full"><label>Angle or notes (optional)</label><textarea name="notes" placeholder="What position or contrarian take should the piece land on?"></textarea></div>
        <div>
          <label>Length</label>
          <select name="length">
            <option>standard (~900 words)</option>
            <option>short (~600 words)</option>
            <option>long (~1200 words)</option>
          </select>
        </div>
        <div><label>&nbsp;</label><button type="submit" class="primary" id="gen-btn">Generate draft</button></div>
      </div>
    </form>
    <div id="gen-result" style="display:none;margin-top:24px;border-top:1px solid #2c2c5c;padding-top:20px">
      <h2 style="margin-bottom:12px">Generated draft</h2>
      <div class="form-grid">
        <div><label>Slug</label><input id="g-slug" placeholder="issue-03"></div>
        <div><label>Display date</label><input id="g-date"></div>
        <div class="full"><label>Title</label><input id="g-title"></div>
        <div class="full"><label>Email teaser</label><textarea id="g-teaser" rows="3"></textarea></div>
        <div><label>Tag</label><input id="g-tag"></div>
        <div><label>Full-issue link path (auto)</label><input id="g-link" placeholder="newsletter/issue-03"></div>
        <div class="full"><label>Full page HTML (edit if needed)</label><textarea id="g-body" rows="10" style="font-family:monospace;font-size:12px"></textarea></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="primary" onclick="saveGenerated()">Save as draft</button>
        <button class="secondary" onclick="previewGenerated()">Preview email</button>
        <button class="secondary" onclick="discardGenerated()">Discard</button>
      </div>
    </div>
  </div>

  <div class="card"><h2>All newsletter publications</h2><div id="issues-table"><div class="empty">Loading&hellip;</div></div></div>
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
function fmt(dt) {
  if (!dt) return '—';
  // D1 stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' in UTC without a timezone marker.
  // Append Z so the browser treats it as UTC, then format in the viewer's local time.
  const d = new Date(String(dt).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return dt;
  return d.toLocaleString(undefined, { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

// ---- dashboard ----
async function loadStats() {
  try {
    const [subs, issues] = await Promise.all([api('/admin/api/subscribers'), api('/admin/api/issues')]);
    const active = subs.filter(s => s.status === 'active');
    const unsub = subs.filter(s => s.status === 'unsubscribed');
    const drafts = issues.filter(i => !i.sent_at).length;
    const sent = issues.filter(i => i.sent_at).length;
    document.getElementById('s-active').textContent = active.length;
    document.getElementById('s-unsub').textContent = unsub.length;
    document.getElementById('s-drafts').textContent = drafts;
    document.getElementById('s-sent').textContent = sent;

    // Latest subscribers table
    const latestSubs = active.slice(0, 5);
    const ls = document.getElementById('latest-subs');
    ls.innerHTML = latestSubs.length
      ? '<table><tr><th>Email</th><th>Joined</th></tr>' +
        latestSubs.map(s => '<tr><td>' + escape(s.email) + '</td><td>' + fmt(s.subscribed_at) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">No active subscribers yet.</div>';

    // Recent unsubscribes table
    const latestUnsub = unsub
      .slice()
      .sort((a, b) => (b.unsubscribed_at || '').localeCompare(a.unsubscribed_at || ''))
      .slice(0, 5);
    const lu = document.getElementById('latest-unsubs');
    lu.innerHTML = latestUnsub.length
      ? '<table><tr><th>Email</th><th>Unsubscribed</th></tr>' +
        latestUnsub.map(s => '<tr><td>' + escape(s.email) + '</td><td>' + fmt(s.unsubscribed_at) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">No unsubscribes yet.</div>';
  } catch (e) { toast('Failed to load stats: ' + e.message, true); }
}

// ---- subscribers ----
let allSubs = [];
let subFilter = 'all';
let subQuery = '';
async function loadSubs() {
  try {
    allSubs = await api('/admin/api/subscribers');
    document.getElementById('f-n-all').textContent = allSubs.length;
    document.getElementById('f-n-active').textContent = allSubs.filter(s => s.status === 'active').length;
    document.getElementById('f-n-unsub').textContent = allSubs.filter(s => s.status === 'unsubscribed').length;
    applySubFilter();
  } catch (e) { toast('Failed to load subscribers: ' + e.message, true); }
}
function applySubFilter() {
  let list = allSubs;
  if (subFilter !== 'all') list = list.filter(s => s.status === subFilter);
  if (subQuery) {
    const q = subQuery.toLowerCase();
    list = list.filter(s =>
      (s.email && s.email.toLowerCase().includes(q)) ||
      (s.first_name && s.first_name.toLowerCase().includes(q)) ||
      (s.last_name && s.last_name.toLowerCase().includes(q))
    );
  }
  // Sort unsubscribed view by unsubscribe date desc so it reads like a log
  if (subFilter === 'unsubscribed') {
    list = list.slice().sort((a, b) => (b.unsubscribed_at || '').localeCompare(a.unsubscribed_at || ''));
  }
  renderSubs(list);
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
  subQuery = e.target.value;
  applySubFilter();
});
document.querySelectorAll('#sub-filters .filter-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#sub-filters .filter-btn').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  subFilter = b.dataset.f;
  applySubFilter();
}));

// ---- AI generate ----
let genCurrent = null;
document.getElementById('ai-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('gen-btn');
  const form = e.target;
  const checked = Array.from(form.querySelectorAll('.topics-picker input:checked')).map(i => i.value);
  const extra = (form.querySelector('[name="topics_extra"]').value || '').trim();
  const topicsCombined = [...checked, extra].filter(Boolean).join('\\n');
  if (!topicsCombined) { toast('Pick at least one topic or add a custom one', true); return; }
  const data = {
    topics: topicsCombined,
    publish_date: form.querySelector('[name="publish_date"]').value,
    tag: form.querySelector('[name="tag"]').value,
    sources: form.querySelector('[name="sources"]').value,
    notes: form.querySelector('[name="notes"]').value,
    length: form.querySelector('[name="length"]').value,
  };
  btn.disabled = true; btn.textContent = 'Generating (30-60s)…';
  try {
    const r = await api('/admin/api/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    const g = r.generated;
    genCurrent = g;
    document.getElementById('g-title').value = g.title || '';
    document.getElementById('g-teaser').value = g.teaser || '';
    document.getElementById('g-body').value = g.body_html || '';
    document.getElementById('g-tag').value = data.tag || '';
    document.getElementById('g-date').value = data.publish_date || '';
    let suggestedSlug = 'issue-01';
    try {
      const ns = await api('/admin/api/issues/next-slug');
      suggestedSlug = ns.slug || suggestedSlug;
    } catch (_) { /* fall back to issue-01 */ }
    document.getElementById('g-slug').value = suggestedSlug;
    document.getElementById('g-link').value = 'newsletter/' + suggestedSlug;
    document.getElementById('gen-result').style.display = 'block';
    toast('Draft generated. Review below.');
  } catch (err) { toast('Generate failed: ' + err.message, true); }
  btn.disabled = false; btn.textContent = 'Generate draft';
});
document.getElementById('g-slug').addEventListener('input', e => {
  document.getElementById('g-link').value = 'newsletter/' + e.target.value;
});
async function saveGenerated() {
  const payload = {
    slug: document.getElementById('g-slug').value.trim(),
    title: document.getElementById('g-title').value.trim(),
    teaser: document.getElementById('g-teaser').value.trim(),
    tags: document.getElementById('g-tag').value.trim(),
    issue_date: document.getElementById('g-date').value.trim(),
    link: document.getElementById('g-link').value.trim(),
    body_html: document.getElementById('g-body').value,
  };
  if (!payload.slug || !payload.title || !payload.teaser) { toast('Slug, title, and teaser are required', true); return; }
  try {
    await api('/admin/api/issues/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    toast('Draft saved.');
    discardGenerated();
    loadIssues(); loadStats();
  } catch (err) { toast('Save failed: ' + err.message, true); }
}
async function previewGenerated() {
  // Save first (upsert), then preview
  await saveGenerated();
  preview(document.getElementById('g-slug').value.trim());
}
function discardGenerated() {
  genCurrent = null;
  document.getElementById('gen-result').style.display = 'none';
  document.getElementById('ai-form').reset();
}

// ---- newsletters ----
let allIssues = [];
async function loadIssues() {
  try {
    allIssues = await api('/admin/api/issues');
    const el = document.getElementById('issues-table');
    if (!allIssues.length) { el.innerHTML = '<div class="empty">No drafts yet. Create one above.</div>'; return; }
    el.innerHTML = '<table><tr><th>Title</th><th>Slug</th><th>Status</th><th>Recipients</th><th>Actions</th></tr>' +
      allIssues.map(i => '<tr>' +
        '<td>' + escape(i.title) + '</td>' +
        '<td style="color:#8c90c4;font-size:12px;">' + escape(i.slug) + '</td>' +
        '<td>' + (i.sent_at ? '<span class="badge sent">Sent</span>' : '<span class="badge draft">Draft</span>') + '</td>' +
        '<td>' + (i.sent_at ? (i.recipient_count || 0) + ' &middot; ' + fmt(i.sent_at) : '—') + '</td>' +
        '<td class="actions">' +
          '<button class="secondary" onclick="preview(\\'' + i.slug + '\\')">Preview</button>' +
          (i.sent_at
            ? '<button class="secondary" onclick="showInsights(\\'' + i.slug + '\\')">Insights</button>'
            : '<button class="secondary" onclick="testSend(\\'' + i.slug + '\\')">Send test</button>' +
              '<button class="primary" style="padding:8px 14px;font-size:12px;" onclick="sendReal(\\'' + i.slug + '\\')">Send to all</button>') +
        '</td>' +
      '</tr>').join('') + '</table>';
  } catch (e) { toast('Failed to load issues: ' + e.message, true); }
}
async function showInsights(slug) {
  const issue = allIssues.find(i => i.slug === slug);
  document.getElementById('preview-title').textContent = 'Insights — ' + (issue ? issue.title : slug);
  const frame = document.getElementById('preview-frame');
  frame.src = 'about:blank';
  try {
    const r = await api('/admin/api/issues/insights?slug=' + encodeURIComponent(slug));
    const deliveredPct = r.sent ? Math.round((r.delivered / r.sent) * 100) : 0;
    const openPct = r.delivered ? Math.round((r.unique_openers / r.delivered) * 100) : 0;
    const clickPct = r.delivered ? Math.round((r.unique_clickers / r.delivered) * 100) : 0;
    const clicksHtml = r.clicks.length
      ? '<h3 style="margin-top:26px">Links clicked</h3><table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;color:#dcdef2;">' +
        r.clicks.map(c => '<tr><td style="padding:8px 6px;border-bottom:1px solid #2c2c5c;">' + escape(c.url) + '</td><td style="padding:8px 6px;border-bottom:1px solid #2c2c5c;text-align:right;color:#06d6a0;font-weight:700">' + c.c + '</td></tr>').join('') + '</table>'
      : '<p style="color:#8c90c4;margin-top:20px;font-size:13px;">No clicks recorded yet. If you just sent this, events can take a few minutes to arrive, and click tracking only works once the Resend webhook is configured.</p>';
    function stat(num, label, color) {
      return '<div style="background:#12122a;border:1px solid #2c2c5c;border-radius:10px;padding:16px;">' +
        '<div style="font-size:26px;font-weight:800;color:' + color + '">' + num + '</div>' +
        '<div style="font-size:11px;color:#8c90c4;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-top:4px">' + label + '</div>' +
        '</div>';
    }
    const html = '<!DOCTYPE html><html><body style="margin:0;padding:32px;background:#06060e;color:#dcdef2;font-family:Arial,sans-serif;">' +
      '<h2 style="color:#eeeef6;margin:0 0 6px">Delivery and engagement</h2>' +
      '<p style="color:#8c90c4;font-size:13px;margin:0 0 24px">Sent ' + r.sent + ' ' + (r.sent === 1 ? 'email' : 'emails') + ' &middot; live data from Resend webhooks.</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;">' +
        stat(r.delivered, 'Delivered (' + deliveredPct + '%)', '#eeeef6') +
        stat(r.unique_openers, 'Unique opens (' + openPct + '%)', '#06d6a0') +
        stat(r.unique_clickers, 'Unique clickers (' + clickPct + '%)', '#06d6a0') +
        stat(r.bounced, 'Bounced', '#f4a1a1') +
        stat(r.complained, 'Spam reports', '#f4a1a1') +
      '</div>' +
      clicksHtml +
      '</body></html>';
    frame.srcdoc = html;
    document.getElementById('preview-modal').classList.add('on');
  } catch (err) {
    toast('Insights failed: ' + err.message, true);
  }
}
async function preview(slug) {
  const issue = allIssues.find(i => i.slug === slug);
  document.getElementById('preview-title').textContent = issue ? issue.title : slug;
  document.getElementById('preview-frame').src = '/newsletter/' + encodeURIComponent(slug);
  document.getElementById('preview-modal').classList.add('on');
}
function closePreview() {
  const f = document.getElementById('preview-frame');
  f.src = 'about:blank';
  f.removeAttribute('srcdoc');
  document.getElementById('preview-modal').classList.remove('on');
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

// Resend uses Svix-signed webhooks. Verify signature if RESEND_WEBHOOK_SECRET is set.
async function verifySvixSignature(request, rawBody, secret) {
  if (!secret) return true; // no secret configured — accept but log a warning
  const svixId = request.headers.get("svix-id");
  const svixTs = request.headers.get("svix-timestamp");
  const svixSig = request.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return false;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes;
  try {
    const b64 = rawSecret.replace(/-/g, "+").replace(/_/g, "/");
    keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch (e) { return false; }
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signed = `${svixId}.${svixTs}.${rawBody}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return svixSig.split(" ").some(part => {
    const [, val] = part.split(",");
    return val === expectedB64;
  });
}

async function handleResendWebhook(request, env) {
  await ensureSchema(env);
  const rawBody = await request.text();
  const ok = await verifySvixSignature(request, rawBody, env.RESEND_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 401 });
  let evt;
  try { evt = JSON.parse(rawBody); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
  const type = evt.type || "";
  const data = evt.data || {};
  const emailId = data.email_id || data.id || null;
  const recipient = Array.isArray(data.to) ? data.to[0] : (data.to || null);
  const url = data.click && data.click.link ? data.click.link : (data.url || null);
  const eventType = type.replace("email.", "");
  try {
    await env.DB.prepare(
      "INSERT INTO email_events (resend_email_id, event_type, url, recipient) VALUES (?, ?, ?, ?)"
    ).bind(emailId, eventType, url, recipient).run();
    // If someone marks it spam or hard-bounces, flip their subscription off automatically.
    if (recipient && (eventType === "complained" || eventType === "bounced")) {
      await env.DB.prepare(
        "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')) WHERE email = ? AND status = 'active'"
      ).bind(String(recipient).toLowerCase()).run();
    }
  } catch (e) { /* ignore duplicates */ }
  return json({ ok: true });
}

async function apiIssueInsights(env, url) {
  await ensureSchema(env);
  const slug = url.searchParams.get("slug");
  if (!slug) return json({ error: "slug required" }, 400);
  const issue = await env.DB.prepare("SELECT id, recipient_count, sent_at FROM issues WHERE slug = ?").bind(slug).first();
  if (!issue) return json({ error: "Issue not found" }, 404);
  if (!issue.sent_at) return json({ ok: true, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unique_openers: 0, unique_clickers: 0, clicks: [] });

  const counts = await env.DB.prepare(
    `SELECT ev.event_type AS t, COUNT(*) AS c
     FROM email_events ev
     INNER JOIN email_sends es ON es.resend_email_id = ev.resend_email_id
     WHERE es.issue_id = ?
     GROUP BY ev.event_type`
  ).bind(issue.id).all();

  const byType = {};
  for (const row of counts.results || []) byType[row.t] = row.c;

  const openersRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT es.email) AS c
     FROM email_events ev
     INNER JOIN email_sends es ON es.resend_email_id = ev.resend_email_id
     WHERE es.issue_id = ? AND ev.event_type = 'opened'`
  ).bind(issue.id).first();
  const clickersRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT es.email) AS c
     FROM email_events ev
     INNER JOIN email_sends es ON es.resend_email_id = ev.resend_email_id
     WHERE es.issue_id = ? AND ev.event_type = 'clicked'`
  ).bind(issue.id).first();

  const clickRows = await env.DB.prepare(
    `SELECT ev.url AS url, COUNT(*) AS c
     FROM email_events ev
     INNER JOIN email_sends es ON es.resend_email_id = ev.resend_email_id
     WHERE es.issue_id = ? AND ev.event_type = 'clicked' AND ev.url IS NOT NULL
     GROUP BY ev.url
     ORDER BY c DESC`
  ).bind(issue.id).all();

  return json({
    ok: true,
    sent: issue.recipient_count || 0,
    delivered: byType.delivered || 0,
    opened: byType.opened || 0,
    clicked: byType.clicked || 0,
    bounced: byType.bounced || 0,
    complained: byType.complained || 0,
    unique_openers: openersRow ? openersRow.c : 0,
    unique_clickers: clickersRow ? clickersRow.c : 0,
    clicks: clickRows.results || [],
  });
}

async function apiListIssues(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT id, slug, title, teaser, tags, issue_date, link, created_at, sent_at, recipient_count FROM issues ORDER BY created_at DESC").all();
  return json(results);
}

async function apiNextIssueSlug(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT slug FROM issues WHERE slug LIKE 'issue-%'").all();
  let maxN = 0;
  for (const r of results) {
    const m = r.slug.match(/^issue-(\d+)$/);
    if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
  }
  const next = String(maxN + 1).padStart(2, "0");
  return json({ slug: `issue-${next}` });
}

async function apiSaveIssue(request, env) {
  await ensureSchema(env);
  const data = await request.json();
  const { slug, title, teaser, tags, issue_date, link, body_html } = data;
  if (!slug || !title || !teaser) return json({ error: "slug, title and teaser are required" }, 400);
  const linkFinal = link || `newsletter/${slug}`;
  await env.DB.prepare(
    `INSERT INTO issues (slug, title, teaser, tags, issue_date, link, body_html) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, teaser=excluded.teaser, tags=excluded.tags, issue_date=excluded.issue_date, link=excluded.link, body_html=COALESCE(excluded.body_html, issues.body_html)`
  ).bind(slug, title, teaser, tags || "", issue_date || "", linkFinal, body_html || null).run();
  return json({ ok: true });
}

// ---------- AI generation ----------

function generationSystemPrompt() {
  return `You write the Compsilon newsletter — weekly AI GRC intelligence for practitioners (governance, risk, and compliance leads working with AI regulation).

Editorial voice — match this exactly:
- Punchy, declarative, contrarian in a useful way. Short sentences.
- Practical over theoretical. Concrete over abstract.
- Direct: address the reader as "you". No corporate hedging.
- No filler openings ("In today's rapidly evolving landscape..."). Get to the point in the first line.
- Prefer patterns like "Not X, but Y" and "X before Y" (e.g. "Authority Before Paperwork", "Obligations First, Certificates Second").
- Skeptical of vendors, buzzwords, and one-size-fits-all frameworks.
- No em-dashes in generated text — use commas, colons, or periods.

Output requirements:
- Return ONE valid JSON object, no markdown fences, no commentary before or after.
- Schema: {"title": string, "teaser": string, "body_html": string}
- title: 6-14 words, no clickbait, no colon-subtitle formula
- teaser: 2-3 sentences (~40-70 words) — the hook that lands in the email inbox
- body_html: rich HTML for the full issue page. 700-1200 words. Use these classes exactly:
  * <h2> for major section headings
  * <h3> for sub-sections
  * <p> for paragraphs
  * <ul><li>...</li></ul> for bullet lists
  * <ol><li>...</li></ol> for numbered/step lists
  * <div class="callout"><p>...</p></div> — for a key insight or aside, use sparingly (1-2 max)
  * <div class="case"><div class="case-tag">SOURCE</div><h4>Title</h4><p>Summary...</p><div class="src"><a href="URL">Link name</a></div></div> — for source-backed case tiles; use ONLY when the user provided a real source URL
  * <div class="checklist"><h4>SECTION LABEL</h4><ul><li>Item</li></ul></div> — for a takeaway checklist
- Structure: hook paragraph → 2-4 sections with <h2> headings → each section mixes paragraphs and bullets → end with a checklist or clear takeaway
- Use ONLY the source URLs the user provided. Never invent or hallucinate URLs, statistics, quotes, dates, or organisations.
- If the user provided no sources, do not use the .case tile — write from principles instead.
- Do not fabricate specific numbers, percentages, or regulatory dates. If unsure, speak in ranges or omit.

Rules for body_html:
- No inline styles. Use only the classes above.
- No <html>, <head>, <body>, <style>, or <script> tags — body_html is inserted inside an existing page.
- No image tags.`;
}

function generationUserPrompt(input) {
  const parts = [];
  parts.push(`Topics to cover:\n${input.topics || "(none provided)"}`);
  if (input.publish_date) parts.push(`Publish date: ${input.publish_date}`);
  if (input.tag) parts.push(`Suggested tag / category: ${input.tag}`);
  if (input.sources) parts.push(`Sources (only these — do not invent others):\n${input.sources}`);
  if (input.notes) parts.push(`Additional angle or notes:\n${input.notes}`);
  parts.push(`Length: ${input.length || "standard (~900 words)"}`);
  parts.push(`\nReturn exactly one JSON object as specified.`);
  return parts.join("\n\n");
}

function stripJsonFences(s) {
  if (!s) return s;
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function apiGenerateIssue(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not configured. Add it as a secret on this Worker." }, 400);
  const input = await request.json();
  if (!input.topics || !String(input.topics).trim()) return json({ error: "Topics are required" }, 400);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: generationSystemPrompt(),
      messages: [{ role: "user", content: generationUserPrompt(input) }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return json({ error: `Anthropic API error: ${errText}` }, 502);
  }
  const data = await resp.json();
  const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const cleaned = stripJsonFences(rawText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "Model returned invalid JSON. Try again.", raw: rawText.slice(0, 500) }, 502);
  }
  if (!parsed.title || !parsed.teaser || !parsed.body_html) {
    return json({ error: "Model output missing required fields.", raw: cleaned.slice(0, 500) }, 502);
  }
  return json({ ok: true, generated: parsed });
}

// ---------- public: full-issue page ----------

function issuePageHTML(issue) {
  const displayDate = issue.issue_date ? escapeHtml(issue.issue_date) : "";
  const tag = escapeHtml(issue.tags || "Newsletter");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(issue.title)} | Compsilon</title>
<meta name="description" content="${escapeHtml(issue.teaser).slice(0, 200)}">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#06060e;--surface:#0d0d1a;--card:#12122a;--border:#1f1f42;
  --muted:#6366a0;--body:#9396c7;--light:#c4c6e8;--white:#eeeef6;
  --teal:#06d6a0;--teal-glow:#06d6a040;--amber:#EF9F27;--amber-glow:#EF9F2740;
  --sans:'Sora',sans-serif;--mono:'JetBrains Mono',monospace;
}
body{font-family:var(--sans);background:var(--bg);color:var(--body);line-height:1.7}
a{color:inherit;text-decoration:none}
.grid-bg{position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:80px 80px;opacity:.15;pointer-events:none;z-index:0}
nav{position:sticky;top:0;z-index:100;background:#06060edd;backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 32px}
.logo{font:800 22px var(--sans);color:var(--white);letter-spacing:-.5px}
.logo span{background:linear-gradient(135deg,var(--teal),var(--amber));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.issue-hero{position:relative;z-index:1;padding:56px 32px 40px;border-bottom:1px solid var(--border);max-width:820px;margin:0 auto}
.hero-glow{position:absolute;top:-60px;left:20%;width:380px;height:240px;background:radial-gradient(ellipse,var(--teal-glow),transparent 70%);pointer-events:none}
.breadcrumb{font:400 13px var(--sans);color:var(--muted);margin-bottom:20px;position:relative}
.breadcrumb a{color:var(--teal)}
.issue-meta{display:flex;align-items:center;gap:10px;margin-bottom:16px;position:relative;flex-wrap:wrap}
.badge{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:1.5px;background:linear-gradient(135deg,var(--teal),var(--amber));color:var(--bg);padding:5px 13px;border-radius:100px}
.issue-date{font:500 12px var(--mono);color:var(--muted)}
.issue-hero h1{font:800 38px/1.15 var(--sans);color:var(--white);letter-spacing:-1.6px;margin-bottom:14px;position:relative}
.standfirst{font:400 16px/1.75 var(--sans);color:var(--light);position:relative}
.article{position:relative;z-index:1;max-width:820px;margin:0 auto;padding:48px 32px}
.article h2{font:700 24px var(--sans);color:var(--white);letter-spacing:-.7px;margin:40px 0 14px}
.article h2:first-child{margin-top:0}
.article h3{font:600 17px var(--sans);color:var(--white);margin:28px 0 10px}
.article p{font:400 15.5px/1.85 var(--sans);color:var(--body);margin-bottom:18px}
.article p strong{color:var(--light);font-weight:600}
.article a{color:var(--teal);border-bottom:1px solid #06d6a050}
.article ul{list-style:none;margin:0 0 20px}
.article ul li{font:400 15px/1.75 var(--sans);color:var(--body);padding:7px 0 7px 26px;position:relative}
.article ul li::before{content:'▸';position:absolute;left:0;color:var(--amber)}
.article ol{list-style:none;counter-reset:n;margin:0 0 20px}
.article ol li{counter-increment:n;font:400 15px/1.75 var(--sans);color:var(--body);padding:9px 0 9px 40px;position:relative}
.article ol li::before{content:counter(n);position:absolute;left:0;top:11px;width:24px;height:24px;border-radius:50%;background:var(--teal);color:var(--bg);font:700 11px var(--mono);display:flex;align-items:center;justify-content:center}
.callout{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:0 12px 12px 0;padding:22px 26px;margin:26px 0}
.callout p{font:400 14.5px/1.75 var(--sans);color:var(--light);margin:0}
.case{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;margin:24px 0}
.case-tag{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:1.2px;color:var(--amber);margin-bottom:8px}
.case h4{font:700 17px var(--sans);color:var(--white);margin-bottom:8px}
.case p{font:400 14px/1.7 var(--sans);color:var(--muted);margin-bottom:12px}
.case .src{font:400 12px var(--sans);color:var(--muted);border-top:1px solid var(--border);padding-top:11px}
.case .src a{color:var(--teal);margin-right:12px}
.checklist{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:26px;margin:26px 0}
.checklist h4{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:1.2px;color:var(--teal);margin-bottom:14px}
.checklist ul{margin:0;list-style:none}
.checklist li{font:400 14px/1.65 var(--sans);color:var(--body);padding:8px 0 8px 28px;border-bottom:1px solid var(--border);position:relative}
.checklist li:last-child{border:none}
.checklist li::before{content:'☐';color:var(--amber);position:absolute;left:0}
.sub-box{background:linear-gradient(135deg,#0d2820,#1a1408);border:1px solid var(--border);border-radius:18px;padding:38px;text-align:center;margin-top:40px;position:relative;overflow:hidden}
.sub-box::before{content:'';position:absolute;top:-60px;right:-40px;width:240px;height:240px;background:radial-gradient(circle,var(--amber-glow),transparent 70%);pointer-events:none}
.sub-box h3{font:700 22px var(--sans);color:var(--white);letter-spacing:-.5px;margin-bottom:8px;position:relative}
.sub-box p{font:400 14px var(--sans);color:var(--muted);margin-bottom:20px;position:relative}
.sub-box a{font:700 13px var(--sans);background:linear-gradient(135deg,var(--teal),var(--amber));color:var(--bg);padding:12px 28px;border-radius:100px;display:inline-block;position:relative}
footer{border-top:1px solid var(--border);padding:24px 32px;text-align:center;font:400 12px var(--sans);color:var(--muted);position:relative;z-index:1}
footer a{color:var(--teal)}
</style></head>
<body>
<div class="grid-bg"></div>
<nav><div class="nav-inner"><a href="/" class="logo">COMP<span>SILON</span></a></div></nav>
<div class="issue-hero">
  <div class="hero-glow"></div>
  <div class="breadcrumb"><a href="/newsletter.html">Newsletter</a> &rsaquo; ${escapeHtml(issue.slug)}</div>
  <div class="issue-meta"><span class="badge">${tag}</span>${displayDate ? `<span class="issue-date">${displayDate}</span>` : ""}</div>
  <h1>${escapeHtml(issue.title)}</h1>
  <p class="standfirst">${escapeHtml(issue.teaser)}</p>
</div>
<div class="article">
${issue.body_html || "<p><em>No full content yet — this issue has only the email teaser.</em></p>"}
<div class="sub-box">
  <h3>Get the next issue</h3>
  <p>Weekly AI GRC intelligence, direct to your inbox.</p>
  <a href="/#subscribe">Subscribe &rarr;</a>
</div>
</div>
<footer>&copy; 2026 Compsilon &middot; <a href="/">compsilon.com</a> &middot; <a href="/privacy-policy.html">Privacy</a> &middot; <a href="/terms-of-use.html">Terms</a></footer>
</body></html>`;
}

async function servePublicIssue(env, slug) {
  await ensureSchema(env);
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?").bind(slug).first();
  if (!issue) return new Response("Issue not found", { status: 404 });
  return new Response(issuePageHTML(issue), { headers: { "Content-Type": "text/html" } });
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
  for (let i = 0; i < subs.length; i += 100) {
    const chunk = subs.slice(i, i + 100);
    const payload = chunk.map(sub => ({
      from: "Compsilon <newsletter@compsilon.com>",
      to: [sub.email],
      subject: issue.title,
      html: renderEmailHTML(issue, sub),
      tags: [
        { name: "issue_slug", value: String(issue.slug).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) },
        { name: "type", value: "newsletter" },
      ],
    }));
    const resp = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) { const t = await resp.text(); return json({ error: `Resend error: ${t}`, sentSoFar: sent }, 502); }
    const respData = await resp.json();
    const ids = (respData.data || []).map(d => d.id);
    // Persist the mapping so incoming webhook events can be correlated back to subscribers.
    for (let j = 0; j < chunk.length; j++) {
      const sub = chunk[j];
      const rid = ids[j] || null;
      try {
        await env.DB.prepare(
          "INSERT INTO email_sends (issue_id, subscriber_id, email, resend_email_id) VALUES (?, ?, ?, ?)"
        ).bind(issue.id, sub.id, sub.email, rid).run();
      } catch (e) { /* duplicate resend id — ignore */ }
    }
    sent += chunk.length;
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
          hasResendWebhookSecret: Boolean(env.RESEND_WEBHOOK_SECRET),
          hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
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
        if (path === "/admin/api/issues/next-slug" && method === "GET") return await apiNextIssueSlug(env);
        if (path === "/admin/api/issues/save" && method === "POST") return await apiSaveIssue(request, env);
        if (path === "/admin/api/issues/preview" && method === "GET") return await apiPreviewIssue(env, url);
        if (path === "/admin/api/issues/test-send" && method === "POST") return await apiTestSend(request, env);
        if (path === "/admin/api/issues/send" && method === "POST") return await apiSendIssue(request, env);
        if (path === "/admin/api/generate" && method === "POST") return await apiGenerateIssue(request, env);
        if (path === "/admin/api/issues/insights" && method === "GET") return await apiIssueInsights(env, url);
      }

      // Resend webhook (public route with signature verification)
      if (path === "/api/resend-webhook" && method === "POST") return await handleResendWebhook(request, env);

      // public full-issue pages served from DB (e.g. /newsletter/issue-03)
      if (path.startsWith("/newsletter/") && path.length > "/newsletter/".length) {
        const slug = path.slice("/newsletter/".length).replace(/\/+$/, "");
        if (slug && !slug.includes("/") && !slug.includes(".")) {
          return await servePublicIssue(env, slug);
        }
      }

      // legacy redirect for the old admin URL
      if (path === "/admin/newsletter") return Response.redirect(url.origin + "/admin", 302);
    } catch (err) {
      return new Response("Server error: " + String(err), { status: 500 });
    }

    return env.ASSETS.fetch(request);
  },
};
