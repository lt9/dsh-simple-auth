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

  var state = { me: null, users: [], sessionId: '', panelOpen: false, acl: null, sidebarLabel: '' };

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) || ('rpc-' + Math.random().toString(16).slice(2));
  }

  function normalizeSessionId(id) {
    if (!id) return '';
    var sid = String(id);
    if (!sid.startsWith('session-')) sid = 'session-' + sid;
    return sid;
  }

  function rememberSession(id) {
    var sid = normalizeSessionId(id);
    if (!sid) return;
    state.sessionId = sid;
    try { sessionStorage.setItem('dsh_simple_auth_session', sid); } catch (e) {}
  }

  function readSidebarLabel() {
    var tree = document.querySelector('[role="tree"][aria-label="会话"]');
    if (!tree) return '';
    var picked = tree.querySelector('[role="treeitem"][aria-selected="true"]');
    if (!picked) return '';
    var t = (picked.textContent || '').trim().split('\\n')[0].trim();
    if (!t || t === '新会话') return t;
    return t;
  }

  function activeSessionId() {
    if (state.sessionId) return state.sessionId;
    try {
      var stored = sessionStorage.getItem('dsh_simple_auth_session') || '';
      if (stored) return normalizeSessionId(stored);
    } catch (e) {}
    return '';
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

  async function loadSessionAcl(sessionId) {
    state.acl = null;
    if (!sessionId) return null;
    try {
      var r = await fetch('/simple-auth/session-acl?sessionId=' + encodeURIComponent(sessionId), { credentials: 'same-origin' });
      if (!r.ok) return null;
      state.acl = await r.json();
      return state.acl;
    } catch (e) {
      return null;
    }
  }

  function userName(id) {
    var u = state.users.find(function (x) { return x.id === id; });
    return (u && (u.name || u.id)) || id;
  }

  function showNote(text, color) {
    var old = body.querySelector('.dsh-sa-note');
    if (old) old.remove();
    var note = document.createElement('div');
    note.className = 'dsh-sa-note';
    note.style.cssText = 'margin-top:10px;color:' + (color || '#1f6b52');
    note.textContent = text;
    body.appendChild(note);
  }

  async function shareToUser(userId) {
    if (!state.sessionId || !state.acl || !state.acl.canShare) return;
    if (state.acl.sharedWith && state.acl.sharedWith.indexOf(userId) >= 0) {
      showNote('已与 ' + userName(userId) + ' 共享此会话，无需重复分享', '#b45309');
      return;
    }
    var r = await fetch('/simple-auth/share', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, userId: userId })
    });
    if (r.status === 409) {
      showNote('已与 ' + userName(userId) + ' 共享此会话', '#b45309');
      await render();
      return;
    }
    if (!r.ok) {
      showNote('分享失败', '#b91c1c');
      return;
    }
    showNote('已与 ' + userName(userId) + ' 共享；双方均可访问此会话', '#1f6b52');
    await render();
  }

  async function unshareFromUser(userId) {
    if (!state.sessionId || !state.acl || !state.acl.canShare) return;
    var r = await fetch('/simple-auth/unshare', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, userId: userId })
    });
    if (!r.ok) {
      showNote('取消分享失败', '#b91c1c');
      return;
    }
    showNote('已取消与 ' + userName(userId) + ' 的分享', '#1f6b52');
    await render();
  }

  var bar, panel, body, meEl;

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
      if (state.panelOpen) await render();
    };

    hookTransports();
    boot();
  }

  async function render() {
    var userEl = document.getElementById('dsh-sa-user');
    if (!state.me) {
      if (userEl) userEl.textContent = '未识别用户';
      if (body) body.textContent = '请重新登录';
      return;
    }
    if (userEl) userEl.textContent = state.me.name || state.me.id;
    if (meEl) meEl.textContent = '当前用户：' + (state.me.name || state.me.id);
    if (!body) return;

    state.sidebarLabel = readSidebarLabel();
    var sid = activeSessionId();
    rememberSession(sid);
    if (!sid) {
      body.innerHTML = '<div style="color:#666">请先在左侧选中一个会话，再打开分享面板。</div>';
      return;
    }

    var acl = await loadSessionAcl(sid);
    if (!acl) {
      body.innerHTML = '<div style="color:#b91c1c">无法读取当前会话权限，请刷新后重试。</div>';
      return;
    }

    var label = acl.displayLabel || state.sidebarLabel || '当前会话';
    if (state.sidebarLabel && state.sidebarLabel !== '新会话' && label === '新会话') label = state.sidebarLabel;

    if (acl.mutualAccess && !acl.canShare) {
      body.innerHTML =
        '<div style="padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:10px">' +
        '<div style="font-weight:600;color:#166534;margin-bottom:4px">当前会话：' + esc(label) + '</div>' +
        '<div style="color:#166534;font-size:12px">此会话由 ' + esc(acl.owner || '其他用户') + ' 分享给你，双方均可访问。</div>' +
        '<div style="color:#666;font-size:12px;margin-top:6px">仅会话拥有者可管理分享；你无法取消或再次分享。</div></div>';
      return;
    }

    if (!acl.canShare) {
      body.innerHTML = '<div style="color:#666">你不是此会话的拥有者，无法管理分享。请先在左侧选中自己拥有的会话。</div>';
      return;
    }

    if (acl.blank) {
      body.innerHTML =
        '<div style="color:#666">当前选中的是空白会话「' + esc(label) + '」。</div>' +
        '<div style="color:#888;font-size:12px;margin-top:6px">请先发送一条消息后再分享。</div>';
      return;
    }

    var others = state.users.filter(function (u) { return u.id !== state.me.id; });
    var shared = Array.isArray(acl.sharedWith) ? acl.sharedWith : [];

    var userRows = others.length
      ? others.map(function (u) {
          var isShared = shared.indexOf(u.id) >= 0;
          if (isShared) {
            return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0;padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">' +
              '<div><div style="font-weight:600">' + esc(u.name || u.id) + '</div>' +
              '<div style="font-size:12px;color:#166534">已共享 · 双方均可访问</div></div>' +
              '<button type="button" data-unshare="' + esc(u.id) + '" style="padding:5px 10px;background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;cursor:pointer">取消分享</button></div>';
          }
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0;padding:8px;border:1px solid #e5e7eb;border-radius:8px">' +
            '<div><div style="font-weight:600">' + esc(u.name || u.id) + '</div>' +
            '<div style="font-size:12px;color:#666">尚未共享</div></div>' +
            '<button type="button" data-share="' + esc(u.id) + '" style="padding:5px 10px;background:#1f6b52;color:#fff;border:0;border-radius:6px;cursor:pointer">分享</button></div>';
        }).join('')
      : '<div style="color:#888">在 users.json 里添加更多用户即可支持多个访客。</div>';

    body.innerHTML =
      '<div style="padding:10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;margin-bottom:10px">' +
      '<div style="font-size:12px;color:#1d4ed8;margin-bottom:4px">当前左侧选中的会话</div>' +
      '<div style="font-weight:600;color:#1e3a8a;font-size:15px">' + esc(label) + '</div>' +
      '<div style="font-size:12px;color:#64748b;margin-top:4px">你是此会话拥有者，可分享给他人或取消分享。</div></div>' +
      '<div style="font-weight:600;color:#333;margin-bottom:6px">分享给其他用户</div>' +
      userRows;

    body.querySelectorAll('[data-share]').forEach(function (btn) {
      btn.onclick = function () { shareToUser(btn.getAttribute('data-share')); };
    });
    body.querySelectorAll('[data-unshare]').forEach(function (btn) {
      btn.onclick = function () { unshareFromUser(btn.getAttribute('data-unshare')); };
    });
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
    } catch (e) {}
    if (state.panelOpen) render();
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
