// ---------- helpers ----------

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

async function ensureSchema(env) {
  await env.DB.exec(
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
  );
  await env.DB.exec(
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
  );
}

function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_PASSWORD) {
    return new Response(
      "Admin password not configured yet. Add ADMIN_PASSWORD as a secret on this Worker.",
      { status: 500 }
    );
  }
  const expected = "Basic " + btoa(`admin:${env.ADMIN_PASSWORD}`);
  if (auth !== expected) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Compsilon Admin"' },
    });
  }
  return null;
}

// ---------- email template ----------
// NOTE: replace the [Add your business mailing address here] placeholder
// before sending live email — CAN-SPAM requires a real physical address
// in every commercial email.

function renderEmailHTML(issue, subscriber) {
  const unsubUrl = `https://compsilon.com/api/unsubscribe?token=${encodeURIComponent(
    subscriber.unsubscribe_token || ""
  )}`;
  const greetingName = subscriber.first_name
    ? escapeHtml(subscriber.first_name)
    : "there";
  const link = issue.link
    ? `https://compsilon.com/${escapeHtml(issue.link)}`
    : "https://compsilon.com/newsletter.html";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#06060e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#06060e;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#12122a;border:1px solid #2c2c5c;border-radius:16px;overflow:hidden;">
<tr><td style="padding:28px 32px 20px;">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:#eeeef6;letter-spacing:-0.5px;">COMP<span style="color:#06d6a0;">SILON</span></span>
</td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:0;"></td></tr>
<tr><td style="padding:28px 32px 8px;">
<span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#06060e;background-color:#06d6a0;padding:5px 14px;border-radius:100px;">${escapeHtml(
    issue.tags || "Newsletter"
  )}</span>
</td></tr>
<tr><td style="padding:12px 32px 0;">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#eeeef6;line-height:1.3;">${escapeHtml(
    issue.title
  )}</span>
</td></tr>
<tr><td style="padding:16px 32px 0;">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#b9bce0;">Hi ${greetingName},<br><br>${escapeHtml(
    issue.teaser
  )}</span>
</td></tr>
<tr><td style="padding:28px 32px 32px;">
<a href="${link}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#06060e;background-color:#06d6a0;padding:13px 26px;border-radius:100px;text-decoration:none;">Read full issue &rarr;</a>
</td></tr>
<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2c2c5c;margin:0;"></td></tr>
<tr><td style="padding:20px 32px 28px;">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#8c90c4;">
Compsilon &middot; [Add your business mailing address here]<br>
You're receiving this because you subscribed at compsilon.com.<br>
<a href="${unsubUrl}" style="color:#8c90c4;text-decoration:underline;">Unsubscribe</a>
</span>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function unsubscribePageHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed — Compsilon</title></head>
<body style="margin:0;background:#06060e;color:#dcdef2;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;">
<div><h1 style="color:#eeeef6;">You've been unsubscribed</h1><p style="color:#8c90c4;">You won't receive any more Compsilon newsletter emails.</p><a href="https://compsilon.com" style="color:#06d6a0;">Return to compsilon.com</a></div>
</body></html>`;
}

// ---------- welcome email ----------

async function sendWelcomeEmail(env, subscriber) {
  if (!env.RESEND_API_KEY) return;
  const issue = {
    title: "Welcome to Compsilon",
    tags: "Welcome",
    teaser:
      "Thanks for subscribing. You'll get one issue a week on AI governance, risk and compliance — practical, not theoretical.",
    link: "newsletter.html",
  };
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Compsilon <newsletter@compsilon.com>",
        to: [subscriber.email],
        subject: "Welcome to Compsilon",
        html: renderEmailHTML(issue, subscriber),
      }),
    });
  } catch (err) {
    // Non-fatal — subscription still succeeds even if the welcome email fails.
  }
}

// ---------- public routes ----------

async function handleSubscribe(request, env, ctx) {
  await ensureSchema(env);
  const contentType = request.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await request.json();
  } else {
    const form = await request.formData();
    data = Object.fromEntries(form.entries());
  }

  const email = String(data.EMAIL || data.email || "").trim().toLowerCase();
  const firstName = String(data.FNAME || data.firstName || "").trim();
  const lastName = String(data.LNAME || data.lastName || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response("Invalid email", { status: 400 });
  }

  const existing = await env.DB.prepare(
    "SELECT id, status FROM subscribers WHERE email = ?"
  )
    .bind(email)
    .first();

  if (existing) {
    if (existing.status !== "active") {
      await env.DB.prepare(
        "UPDATE subscribers SET status = 'active', unsubscribed_at = NULL WHERE id = ?"
      )
        .bind(existing.id)
        .run();
    }
  } else {
    const token = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO subscribers (email, first_name, last_name, status, unsubscribe_token)
       VALUES (?, ?, ?, 'active', ?)`
    )
      .bind(email, firstName, lastName, token)
      .run();

    ctx.waitUntil(
      sendWelcomeEmail(env, { email, first_name: firstName, unsubscribe_token: token })
    );
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

  const sub = await env.DB.prepare(
    "SELECT id FROM subscribers WHERE unsubscribe_token = ?"
  )
    .bind(token)
    .first();
  if (!sub) return new Response("Not found", { status: 404 });

  await env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?"
  )
    .bind(sub.id)
    .run();

  return new Response(unsubscribePageHTML(), {
    headers: { "Content-Type": "text/html" },
  });
}

async function dbCheck(env) {
  try {
    await ensureSchema(env);
    const result = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ status: "connected", result });
  } catch (err) {
    return json({ status: "error", message: String(err) }, 500);
  }
}

// ---------- admin routes ----------

async function adminPage(env) {
  await ensureSchema(env);
  const { results: issues } = await env.DB.prepare(
    "SELECT * FROM issues ORDER BY created_at DESC"
  ).all();
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM subscribers WHERE status = 'active'"
  ).first();
  const subscriberCount = countRow ? countRow.c : 0;

  const rows = issues
    .map((issue) => {
      const statusLabel = issue.sent_at
        ? `Sent to ${issue.recipient_count || 0} on ${issue.sent_at}`
        : "Draft";
      return `<tr>
        <td>${escapeHtml(issue.title)}</td>
        <td>${escapeHtml(issue.slug)}</td>
        <td>${escapeHtml(statusLabel)}</td>
        <td>
          <a href="/admin/newsletter/preview?slug=${encodeURIComponent(
            issue.slug
          )}" target="_blank">Preview</a>
          ${
            issue.sent_at
              ? ""
              : `&nbsp; <button onclick="sendTest('${issue.slug}')" style="background:#2c2c5c;color:#eeeef6;">Send Test</button>
                 &nbsp; <button onclick="sendIssue('${issue.slug}')">Send</button>`
          }
        </td>
      </tr>`;
    })
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Newsletter Admin — Compsilon</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#06060e;color:#dcdef2;padding:32px;max-width:900px;margin:0 auto;}
  h1{font-size:22px;color:#eeeef6;}
  h2{font-size:16px;color:#eeeef6;margin-top:32px;}
  .count{color:#06d6a0;font-weight:700;}
  input,textarea{width:100%;padding:10px;margin-bottom:10px;background:#12122a;border:1px solid #2c2c5c;color:#eeeef6;border-radius:6px;box-sizing:border-box;font-family:inherit;}
  table{width:100%;border-collapse:collapse;margin-top:16px;}
  th,td{text-align:left;padding:8px;border-bottom:1px solid #2c2c5c;font-size:13px;}
  a{color:#06d6a0;}
  button{background:#06d6a0;color:#06060e;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;}
  #msg{margin-top:10px;font-size:13px;color:#06d6a0;}
</style>
</head>
<body>
<h1>Newsletter Admin</h1>
<p>Active subscribers: <span class="count">${subscriberCount}</span></p>

<h2>New / Edit Draft</h2>
<form id="issueForm">
  <input name="slug" placeholder="Slug (e.g. issue-03)" required>
  <input name="title" placeholder="Title" required>
  <textarea name="teaser" placeholder="Teaser paragraph" rows="4" required></textarea>
  <input name="tags" placeholder="Tag (e.g. Agents)">
  <input name="issue_date" placeholder="Display date (e.g. 17 Aug 2026)">
  <input name="link" placeholder="Link path (e.g. issue-03.html)">
  <button type="submit">Save Draft</button>
</form>
<div id="msg"></div>

<h2>Issues</h2>
<table>
<tr><th>Title</th><th>Slug</th><th>Status</th><th>Actions</th></tr>
${rows}
</table>

<script>
document.getElementById('issueForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch('/admin/newsletter/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const j = await res.json();
  document.getElementById('msg').textContent = j.ok ? 'Saved.' : ('Error: ' + j.error);
  if (j.ok) setTimeout(function(){ location.reload(); }, 500);
});
async function sendTest(slug){
  const email = prompt('Send a test copy of "' + slug + '" to which email address?');
  if (!email) return;
  const res = await fetch('/admin/newsletter/test-send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({slug: slug, email: email}) });
  const j = await res.json();
  alert(j.ok ? ('Test sent to ' + email) : ('Error: ' + j.error));
}
async function sendIssue(slug){
  if (!confirm('Send "' + slug + '" to every active subscriber? This cannot be undone.')) return;
  const res = await fetch('/admin/newsletter/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({slug: slug}) });
  const j = await res.json();
  alert(j.ok ? ('Sent to ' + j.sent + ' subscribers.') : ('Error: ' + j.error));
  location.reload();
}
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

async function saveIssue(request, env) {
  await ensureSchema(env);
  const data = await request.json();
  const { slug, title, teaser, tags, issue_date, link } = data;
  if (!slug || !title || !teaser) {
    return json({ error: "slug, title and teaser are required" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO issues (slug, title, teaser, tags, issue_date, link)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title,
       teaser = excluded.teaser,
       tags = excluded.tags,
       issue_date = excluded.issue_date,
       link = excluded.link`
  )
    .bind(slug, title, teaser, tags || "", issue_date || "", link || "")
    .run();
  return json({ ok: true });
}

async function previewIssue(env, url) {
  await ensureSchema(env);
  const slug = url.searchParams.get("slug");
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?")
    .bind(slug)
    .first();
  if (!issue) return new Response("Issue not found", { status: 404 });
  const html = renderEmailHTML(issue, {
    first_name: "Reader",
    unsubscribe_token: "preview-token",
  });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function sendTestHandler(request, env) {
  await ensureSchema(env);
  const { slug, email } = await request.json();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Enter a valid email address" }, 400);
  }
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?")
    .bind(slug)
    .first();
  if (!issue) return json({ error: "Issue not found" }, 404);
  if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured yet" }, 400);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Compsilon <newsletter@compsilon.com>",
      to: [email],
      subject: "[TEST] " + issue.title,
      html: renderEmailHTML(issue, { first_name: "", unsubscribe_token: "test-token" }),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return json({ error: `Resend error: ${errText}` }, 502);
  }
  return json({ ok: true });
}

async function sendIssueHandler(request, env) {
  await ensureSchema(env);
  const { slug } = await request.json();
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE slug = ?")
    .bind(slug)
    .first();
  if (!issue) return json({ error: "Issue not found" }, 404);
  if (issue.sent_at) return json({ error: "This issue has already been sent" }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured yet" }, 400);

  const { results: subs } = await env.DB.prepare(
    "SELECT * FROM subscribers WHERE status = 'active'"
  ).all();
  if (!subs.length) return json({ error: "No active subscribers" }, 400);

  const chunks = [];
  for (let i = 0; i < subs.length; i += 100) chunks.push(subs.slice(i, i + 100));

  let sent = 0;
  for (const chunk of chunks) {
    const payload = chunk.map((sub) => ({
      from: "Compsilon <newsletter@compsilon.com>",
      to: [sub.email],
      subject: issue.title,
      html: renderEmailHTML(issue, sub),
    }));
    const resp = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      sent += chunk.length;
    } else {
      const errText = await resp.text();
      return json({ error: `Resend error: ${errText}`, sentSoFar: sent }, 502);
    }
  }

  await env.DB.prepare(
    "UPDATE issues SET sent_at = datetime('now'), recipient_count = ? WHERE id = ?"
  )
    .bind(sent, issue.id)
    .run();

  return json({ ok: true, sent });
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/db-check") return await dbCheck(env);
      if (path === "/api/subscribe" && request.method === "POST")
        return await handleSubscribe(request, env, ctx);
      if (path === "/api/unsubscribe" && request.method === "GET")
        return await handleUnsubscribe(request, env, url);

      if (path.startsWith("/admin/")) {
        const authError = requireAdmin(request, env);
        if (authError) return authError;

        if (path === "/admin/newsletter" && request.method === "GET")
          return await adminPage(env);
        if (path === "/admin/newsletter/save" && request.method === "POST")
          return await saveIssue(request, env);
        if (path === "/admin/newsletter/preview" && request.method === "GET")
          return await previewIssue(env, url);
        if (path === "/admin/newsletter/send" && request.method === "POST")
          return await sendIssueHandler(request, env);
        if (path === "/admin/newsletter/test-send" && request.method === "POST")
          return await sendTestHandler(request, env);
      }
    } catch (err) {
      return new Response("Server error: " + String(err), { status: 500 });
    }

    return env.ASSETS.fetch(request);
  },
};
