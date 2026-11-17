/* Compsilon first-party analytics: no cookies, no IP stored, respects Do Not Track / GPC. */
(function () {
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    var p = location.pathname;
    if (p.indexOf('/admin') === 0 || window.top !== window.self) return;
    var vid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    var q = new URLSearchParams(location.search);
    function send(o) {
      o.vid = vid;
      var d = JSON.stringify(o);
      try { if (navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([d], { type: 'text/plain' }))) return; } catch (e) {}
      try { fetch('/api/track', { method: 'POST', body: d, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
    }
    send({ k: 'v', p: p, r: document.referrer || '', us: q.get('utm_source') || '', uc: q.get('utm_campaign') || '' });
    var active = 0, sent = 0, start = document.visibilityState === 'visible' ? Date.now() : 0;
    function flush() {
      if (start) { active += Date.now() - start; start = 0; }
      var s = Math.round(active / 1000);
      if (s > sent) { sent = s; send({ k: 'd', sec: s }); }
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(); else start = Date.now();
    });
    window.addEventListener('pagehide', flush);
  } catch (e) {}
})();
