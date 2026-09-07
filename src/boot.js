const BOOT_MARKER = 'data-dsh-simple-auth-boot'
const SHARE_MARKER = 'data-dsh-simple-auth-share'

export function bootScript(minTimeoutMs) {
  const min = Math.max(0, Number(minTimeoutMs) || 0)
  return `<script ${BOOT_MARKER}>
(function () {
  var min = ${min};
  if (min > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    var orig = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = function (ms) {
      var n = Number(ms);
      if (!Number.isFinite(n) || n < 1) n = min;
      return orig(Math.max(n, min));
    };
  }
})();
</script>`
}

export function sharePanelScript() {
  return `<script ${SHARE_MARKER}>
(function () {
  if (window.__dshSimpleAuthUi) return;
  window.__dshSimpleAuthUi = true;

  var state = { me: null, users: [], sessions: [], sessionId: '', panelOpen: false, shared: {} };

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) || ('rpc-' + Math.random().toString(16).slice(2));
  }

  function rememberSession(id) {
    if (!id) return;
    var sid = String(id);
    if (!sid.startsWith('session-')) sid = 'session-' + sid;
    state.sessionId = sid;
    try { sessionStorage.setItem('dsh_simple_auth_session', sid); } catch (e) {}
  }

  function rpcCall(method, payload) {
    return fetch('/api/' + method, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: method, rpcId: uuid(), payload: payload || {} })
    }).then(function (r) { return r.json(); });
  }

  async function loadShareState(sessionId) {
    state.shared = {};
    if (!sessionId) return;
    try {
      var r = await fetch('/simple-auth/session-acl?sessionId=' + encodeURIComponent(sessionId), { credentials: 'same-origin' });
      if (!r.ok) return;
      var data = await r.json();
      if (!data.canShare) return;
      (data.sharedWith || []).forEach(function (id) { state.shared[id] = true; });
    } catch (e) {}
  }

  async function loadSessions() {
    try {
      var data = await rpcCall('session.list', {});
      var items = (data && data.result && data.result.ok && data.result.value && data.result.value.items) || [];
      state.sessions = items;
      return items;
    } catch (e) {
      state.sessions = [];
      return [];
    }
  }

  function guessTitle() {
    var sel = document.querySelector('[aria-selected="true"], [data-selected="true"], [data-state="active"], [data-active="true"]');
    if (sel) {
      var t = (sel.textContent || '').trim().split('\\n')[0];
      if (t && t.length < 120) return t;
    }
    var heads = document.querySelectorAll('header [class*="title"], header h1, header h2, main h1, main h2');
    for (var i = 0; i < heads.length; i++) {
      var txt = (heads[i].textContent || '').trim();
      if (txt && txt.length < 120 && txt.indexOf('deepseek') < 0) return txt;
    }
    return '';
  }

  function pickSessionId(items) {
    if (!items.length) return '';
    var title = guessTitle();
    if (title) {
      var hit = items.find(function (s) {
        var st = (s.title || s.sessionId || '').trim();
        return st === title || st.indexOf(title) >= 0 || title.indexOf(st) >= 0;
      });
      if (hit && hit.sessionId) return hit.sessionId;
    }
    try {
      var stored = sessionStorage.getItem('dsh_simple_auth_session') || '';
      if (stored && items.some(function (s) { return s.sessionId === stored; })) return stored;
    } catch (e) {}
    if (state.sessionId && items.some(function (s) { return s.sessionId === state.sessionId; })) return state.sessionId;
    return items[0].sessionId || '';
  }

  function hookTransports() {
    if (!window.__dshSimpleAuthFetchHook) {
      window.__dshSimpleAuthFetchHook = true;
      var origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var body = init && init.body;
          if (typeof body === 'string' && url.indexOf('/api/') >= 0) {
            var msg = JSON.parse(body);
            if (msg && msg.payload && msg.payload.sessionId) rememberSession(msg.payload.sessionId);
          }
        } catch (e) {}
        return origFetch(input, init);
      };
    }
    if (!window.__dshSimpleAuthWsHook) {
      window.__dshSimpleAuthWsHook = true;
      var OrigWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
        var origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            if (typeof data === 'string') {
              var msg = JSON.parse(data);
              if (msg && msg.payload && msg.payload.sessionId) rememberSession(msg.payload.sessionId);
            }
          } catch (e) {}
          return origSend(data);
        };
        return ws;
      };
      window.WebSocket.prototype = OrigWS.prototype;
      window.WebSocket.CONNECTING = OrigWS.CONNECTING;
      window.WebSocket.OPEN = OrigWS.OPEN;
      window.WebSocket.CLOSING = OrigWS.CLOSING;
      window.WebSocket.CLOSED = OrigWS.CLOSED;
    }
  }

  var bar, panel, body, meEl, selectEl;

  var BAR_BOTTOM = '132px';
  var PANEL_BOTTOM = '184px';

  function mount() {
    if (!document.body || document.getElementById('dsh-simple-auth-bar')) return;

    bar = document.createElement('div');
    bar.id = 'dsh-simple-auth-bar';
    bar.setAttribute('data-dsh-simple-auth-ui', 'bar');
    bar.style.cssText =
      'position:fixed;right:14px;bottom:' + BAR_BOTTOM + ';z-index:2147483646;display:flex;gap:8px;align-items:center;' +
      'font:13px/1.2 ui-sans-serif,system-ui,sans-serif;pointer-events:auto;flex-wrap:wrap;justify-content:flex-end;max-width:min(420px,calc(100vw - 28px))';
    bar.innerHTML =
      '<span id="dsh-sa-user" style="padding:7px 12px;background:#fff;color:#111;border:1px solid #c9c9c9;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.18);font-weight:600">…</span>' +
      '<button type="button" id="dsh-sa-switch" style="padding:7px 12px;background:#f3f4f6;color:#111;border:1px solid #c9c9c9;border-radius:8px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12)">切换用户</button>' +
      '<button type="button" id="dsh-sa-share-btn" style="padding:7px 12px;background:#1f6b52;color:#fff;border:0;border-radius:8px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18);font-weight:600">分享会话</button>';
    (document.documentElement || document.body).appendChild(bar);

    panel = document.createElement('div');
    panel.id = 'dsh-simple-auth-share';
    panel.setAttribute('data-dsh-simple-auth-ui', 'panel');
    panel.style.cssText =
      'display:none;position:fixed;right:14px;bottom:' + PANEL_BOTTOM + ';z-index:2147483646;width:min(340px,calc(100vw - 28px));' +
      'max-height:min(46vh,340px);overflow:auto;background:#fff;color:#111;border:1px solid #d0d0d0;border-radius:10px;padding:12px;' +
      'font:13px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.22)';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<div style="font-weight:600;color:#111">会话分享</div>' +
      '<button type="button" id="dsh-sa-close" style="background:transparent;border:0;color:#666;cursor:pointer;font-size:18px;line-height:1">×</button></div>' +
      '<div id="dsh-sa-me" style="color:#555;margin-bottom:8px"></div>' +
      '<div id="dsh-sa-body" style="color:#444">加载中…</div>';
    (document.documentElement || document.body).appendChild(panel);

    body = panel.querySelector('#dsh-sa-body');
    meEl = panel.querySelector('#dsh-sa-me');
    document.getElementById('dsh-sa-switch').onclick = function () {
      location.href = '/logout?next=' + encodeURIComponent('/login');
    };
    document.getElementById('dsh-sa-close').onclick = function () {
      state.panelOpen = false;
      panel.style.display = 'none';
    };
    document.getElementById('dsh-sa-share-btn').onclick = async function () {
      state.panelOpen = !state.panelOpen;
      panel.style.display = state.panelOpen ? 'block' : 'none';
      if (state.panelOpen) await render(true);
    };

    hookTransports();
    boot();
  }

  async function render(refreshList) {
    var userEl = document.getElementById('dsh-sa-user');
    if (!state.me) {
      if (userEl) userEl.textContent = '未识别用户';
      if (body) body.textContent = '请重新登录';
      return;
    }
    if (userEl) userEl.textContent = state.me.name || state.me.id;
    if (meEl) meEl.textContent = '当前用户：' + (state.me.name || state.me.id);

    if (refreshList) await loadSessions();
    var items = state.sessions || [];
    var owned = [];
    for (var i = 0; i < items.length; i++) {
      try {
        var aclR = await fetch('/simple-auth/session-acl?sessionId=' + encodeURIComponent(items[i].sessionId), { credentials: 'same-origin' });
        if (!aclR.ok) continue;
        var aclData = await aclR.json();
        if (aclData.canShare) owned.push(items[i]);
      } catch (e) {}
    }
    items = owned;
    var picked = pickSessionId(items);
    if (picked) rememberSession(picked);
    await loadShareState(state.sessionId);

    if (!body) return;
    if (!items.length) {
      body.innerHTML = '没有可分享的会话。请确认已用 master 登录且会话列表不为空。';
      return;
    }

    var options = items.map(function (s) {
      var label = (s.title || s.sessionId || '').trim() || s.sessionId;
      var shortId = (s.sessionId || '').slice(0, 18) + '…';
      return '<option value="' + esc(s.sessionId) + '"' + (s.sessionId === state.sessionId ? ' selected' : '') + '>' + esc(label) + ' (' + esc(shortId) + ')</option>';
    }).join('');

    var others = state.users.filter(function (u) { return u.id !== state.me.id; });
    var checks = others.length
      ? '<div style="color:#ccc;margin-bottom:4px">分享给以下用户（可多选）</div>' + others.map(function (u) {
          var checked = state.shared[u.id] ? ' checked' : '';
          return '<label style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" data-user="' + esc(u.id) + '"' + checked + '/> ' + esc(u.name || u.id) + ' <span style="color:#666">(' + esc(u.id) + ')</span></label>';
        }).join('')
      : '<div style="color:#888">在 users.json 里添加更多用户即可支持多个访客。</div>';

    body.innerHTML =
      '<label style="display:block;margin-bottom:8px;color:#333;font-weight:600">选择要分享的会话</label>' +
      '<select id="dsh-sa-session" style="width:100%;margin-bottom:10px;padding:8px;background:#fff;color:#111;border:1px solid #ccc;border-radius:6px">' +
      options + '</select>' + checks +
      '<button type="button" id="dsh-sa-apply" style="margin-top:10px;background:#1f4e3d;color:#fff;border:0;border-radius:4px;padding:6px 10px;cursor:pointer">应用分享</button>';

    selectEl = document.getElementById('dsh-sa-session');
    if (selectEl) {
      selectEl.onchange = async function () {
        rememberSession(selectEl.value);
        await loadShareState(state.sessionId);
        await render(false);
      };
      if (state.sessionId) selectEl.value = state.sessionId;
    }
    var applyBtn = document.getElementById('dsh-sa-apply');
    if (applyBtn) applyBtn.onclick = applyShare;
  }

  async function applyShare() {
    if (selectEl && selectEl.value) rememberSession(selectEl.value);
    if (!state.sessionId) return;
    var boxes = body.querySelectorAll('input[data-user]');
    for (var i = 0; i < boxes.length; i++) {
      var uid = boxes[i].getAttribute('data-user');
      var on = boxes[i].checked;
      await fetch(on ? '/simple-auth/share' : '/simple-auth/unshare', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, userId: uid })
      });
    }
    var note = document.createElement('div');
    note.style.cssText = 'color:#8f8;margin-top:8px';
    note.textContent = '已更新分享设置';
    body.appendChild(note);
  }

  async function boot() {
    try {
      var meR = await fetch('/simple-auth/me', { credentials: 'same-origin' });
      if (!meR.ok) {
        if (document.getElementById('dsh-sa-user')) document.getElementById('dsh-sa-user').textContent = '单用户';
        if (document.getElementById('dsh-sa-share-btn')) document.getElementById('dsh-sa-share-btn').style.display = 'none';
        return;
      }
      state.me = await meR.json();
      var usersR = await fetch('/simple-auth/users', { credentials: 'same-origin' });
      if (usersR.ok) state.users = await usersR.json();
      await loadSessions();
    } catch (e) {}
    render(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
</script>`
}

export function injectBoot(html, minTimeoutMs, multiUser) {
  if (typeof html !== 'string') return html
  const parts = []
  if (!html.includes(BOOT_MARKER) && minTimeoutMs > 0) parts.push(bootScript(minTimeoutMs))
  if (multiUser && !html.includes(SHARE_MARKER)) parts.push(sharePanelScript())
  if (!parts.length) return html
  const tag = parts.join('')
  const lower = html.toLowerCase()
  const i = lower.indexOf('<head>')
  if (i >= 0) return html.slice(0, i + 6) + tag + html.slice(i + 6)
  const b = lower.indexOf('<body>')
  if (b >= 0) return html.slice(0, b + 6) + tag + html.slice(b + 6)
  return tag + html
}
