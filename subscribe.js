/* Compsilon subscribe form: Turnstile (if configured), fetch submit, clear messages. */
(function () {
  var f = document.getElementById('mcForm');
  if (!f) return;
  var msg = document.getElementById('mcMsg');
  var token = '', turnstileOn = false;
  function show(text, isErr) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.color = isErr ? '#f4a1a1' : '';
  }
  fetch('/api/subscribe-config').then(function (r) { return r.json(); }).then(function (c) {
    if (!c || !c.turnstileSiteKey) return;
    turnstileOn = true;
    var box = document.createElement('div');
    box.style.cssText = 'margin-top:10px;min-height:0';
    f.insertBefore(box, f.lastElementChild);
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function () {
      window.turnstile.render(box, {
        sitekey: c.turnstileSiteKey,
        appearance: 'interaction-only',
        callback: function (t) { token = t; },
        'expired-callback': function () { token = ''; },
        'error-callback': function () { token = ''; }
      });
    };
    document.head.appendChild(s);
  }).catch(function () {});

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    var btn = f.querySelector('button[type="submit"]');
    function go() {
      var fd = new FormData(f);
      if (token) fd.set('cf-turnstile-response', token);
      fetch('/api/subscribe', { method: 'POST', body: fd })
        .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Something went wrong. Please try again.' }; }).then(function (j) { j.status = r.status; return j; }); })
        .then(function (j) {
          if (j.ok) { f.style.display = 'none'; show(j.message, false); }
          else { show(j.message || 'Something went wrong. Please try again.', true); if (btn) btn.disabled = false; try { if (window.turnstile) { window.turnstile.reset(); token = ''; } } catch (x) {} }
        })
        .catch(function () { show('Network error. Please try again.', true); if (btn) btn.disabled = false; });
    }
    if (btn) btn.disabled = true;
    if (turnstileOn && !token) {
      var tries = 0, t = setInterval(function () {
        tries++;
        if (token || tries > 24) { clearInterval(t); if (!token) { show('Verification is taking longer than usual. Please try again.', true); if (btn) btn.disabled = false; } else go(); }
      }, 250);
    } else go();
  });
})();
