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

  var state = {
    me: null,
    users: [],
    sessionId: '',
    sessionItems: [],
    menuOpen: false,
    panelOpen: false,
    acl: null,
    sidebarLabel: ''
  };

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
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

  function rpcSessionId(obj) {
    if (!obj || typeof obj !== 'object') return '';
    var payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
    if (payload.sessionId) return normalizeSessionId(payload.sessionId);
    if (payload.parentSessionId && !payload.sessionId) return normalizeSessionId(payload.parentSessionId);
    return '';
  }

  function ingestSessionList(items) {
    if (!Array.isArray(items)) return;
    state.sessionItems = items.filter(function (row) { return row && row.sessionId; });
  }

  function catalogLabel(sessionId) {
    var row = state.sessionItems.find(function (x) { return x.sessionId === sessionId; });
    if (!row) return '';
    return String(row.displayLabel || row.title || row.name || '').trim();
  }

  async function fetchSessionList() {
    try {
      var r = await fetch('/simple-auth/sessions', { credentials: 'same-origin' });
      if (r.ok) {
        var data = await r.json();
        if (data && Array.isArray(data.items)) ingestSessionList(data.items);
      }
    } catch (e) {}
    return state.sessionItems;
  }

  async function resolveSessionId() {
    try {
      var r = await fetch('/simple-auth/current-session', { credentials: 'same-origin' });
      if (r.ok) {
        var data = await r.json();
        if (data && data.sessionId) {
          rememberSession(data.sessionId);
          state.acl = data;
          return data.sessionId;
        }
      }
    } catch (e) {}
    if (state.sessionId) return state.sessionId;
    try {
      var stored = sessionStorage.getItem('dsh_simple_auth_session') || '';
      if (stored) {
        rememberSession(stored);
        return state.sessionId;
      }
    } catch (e) {}
    return '';
  }

  function hookTransports() {
    if (!window.__dshSimpleAuthFetchHook) {
      window.__dshSimpleAuthFetchHook = true;
      var origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        try {
          var body = init && init.body;
          if (body && typeof body !== 'string' && body.byteLength) {
            body = new TextDecoder().decode(body);
          }
          if (typeof body === 'string' && url.indexOf('/api/') >= 0) {
            var req = JSON.parse(body);
            var reqSid = rpcSessionId(req);
            if (reqSid) rememberSession(reqSid);
          }
        } catch (e) {}
        return origFetch(input, init).then(function (res) {
          try {
            if (url.indexOf('/api/') < 0) return res;
            return res.clone().json().then(function (data) {
              if (url.indexOf('session.list') >= 0 && data.result && data.result.value && data.result.value.items) {
                ingestSessionList(data.result.value.items);
              }
              return res;
            }).catch(function () { return res; });
          } catch (e) {
            return res;
          }
        });
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
              var sid = rpcSessionId(msg);
              if (sid) rememberSession(sid);
            }
          } catch (e) {}
          return origSend(data);
        };
        ws.addEventListener('message', function (ev) {
          try {
            if (typeof ev.data === 'string') {
              var msg = JSON.parse(ev.data);
              var sid = rpcSessionId(msg);
              if (sid) rememberSession(sid);
            }
          } catch (e) {}
        });
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

  var root, menu, panel, body, meEl, fabBtn;

  var btnStyle =
    'display:block;width:100%;padding:9px 14px;background:#fff;color:#111;border:1px solid #d0d0d0;border-radius:8px;' +
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);font:13px/1.2 ui-sans-serif,system-ui,sans-serif;text-align:left;white-space:nowrap';

  function paintUser() {
    var userEl = document.getElementById('dsh-sa-user');
    if (!userEl) return;
    if (!state.me) {
      userEl.textContent = '…';
      return;
    }
    userEl.textContent = state.me.name || state.me.id;
    if (meEl) meEl.textContent = '当前用户：' + (state.me.name || state.me.id);
  }

  function setMenuOpen(open) {
    state.menuOpen = !!open;
    if (menu) menu.style.display = state.menuOpen ? 'flex' : 'none';
    if (fabBtn) fabBtn.setAttribute('aria-expanded', state.menuOpen ? 'true' : 'false');
    if (state.menuOpen) paintUser();
  }

  function closePanel() {
    state.panelOpen = false;
    if (panel) panel.style.display = 'none';
  }

  function openPanel() {
    state.panelOpen = true;
    setMenuOpen(false);
    if (panel) {
      panel.style.display = 'block';
      panel.style.zIndex = '2147483647';
    }
    if (root) root.style.zIndex = '2147483645';
  }

  function confirmSwitchUser() {
    if (!state.me) return false;
    var name = state.me.name || state.me.id;
    return window.confirm(
      '确定要退出当前用户「' + name + '」并返回登录页吗？\\n\\n退出后需要重新输入访问密钥才能进入。'
    );
  }

  function mount() {
    if (!document.body || document.getElementById('dsh-simple-auth-fab')) return;

    root = document.createElement('div');
    root.id = 'dsh-simple-auth-fab';
    root.setAttribute('data-dsh-simple-auth-ui', 'fab');
    root.style.cssText =
      'position:fixed;right:16px;bottom:20px;z-index:2147483645;display:flex;flex-direction:column;align-items:flex-end;gap:10px;' +
      'font:13px/1.2 ui-sans-serif,system-ui,sans-serif;pointer-events:auto';

    menu = document.createElement('div');
    menu.id = 'dsh-sa-menu';
    menu.style.cssText = 'display:none;flex-direction:column;align-items:stretch;gap:8px;min-width:148px';
    menu.innerHTML =
      '<div id="dsh-sa-user" style="padding:8px 12px;background:#fff;color:#111;border:1px solid #d0d0d0;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.12);font-weight:600;text-align:center">…</div>' +
      '<button type="button" id="dsh-sa-share-btn" style="' + btnStyle + ';background:#1f6b52;color:#fff;border:0;font-weight:600;text-align:center">分享会话</button>' +
      '<button type="button" id="dsh-sa-switch" style="' + btnStyle + '">切换用户</button>';
    root.appendChild(menu);

    fabBtn = document.createElement('button');
    fabBtn.type = 'button';
    fabBtn.id = 'dsh-sa-fab';
    fabBtn.setAttribute('aria-label', '账户与分享');
    fabBtn.setAttribute('aria-expanded', 'false');
    fabBtn.style.cssText =
      'width:48px;height:48px;border:0;border-radius:50%;background:#1f6b52;color:#fff;cursor:pointer;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.22);font-size:22px;line-height:1;font-weight:700';
    fabBtn.textContent = '⋮';
    root.appendChild(fabBtn);

    panel = document.createElement('div');
    panel.id = 'dsh-simple-auth-share';
    panel.setAttribute('data-dsh-simple-auth-ui', 'panel');
    panel.style.cssText =
      'display:none;position:fixed;right:16px;bottom:88px;z-index:2147483647;width:min(340px,calc(100vw - 32px));' +
      'max-height:min(50vh,360px);overflow:auto;background:#fff;color:#111;border:1px solid #d0d0d0;border-radius:10px;padding:12px;' +
      'font:13px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.22)';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<div style="font-weight:600;color:#111">会话分享</div>' +
      '<button type="button" id="dsh-sa-close" style="background:transparent;border:0;color:#666;cursor:pointer;font-size:18px;line-height:1">×</button></div>' +
      '<div id="dsh-sa-me" style="color:#555;margin-bottom:8px"></div>' +
      '<div id="dsh-sa-body" style="color:#444">加载中…</div>';
    (document.documentElement || document.body).appendChild(panel);

    (document.documentElement || document.body).appendChild(root);

    body = panel.querySelector('#dsh-sa-body');
    meEl = panel.querySelector('#dsh-sa-me');

    fabBtn.onclick = async function () {
      if (state.panelOpen) {
        closePanel();
        setMenuOpen(false);
        return;
      }
      if (!state.me) await boot();
      setMenuOpen(!state.menuOpen);
    };

    document.getElementById('dsh-sa-switch').onclick = function () {
      if (!confirmSwitchUser()) return;
      location.href = '/logout?next=' + encodeURIComponent('/login');
    };

    document.getElementById('dsh-sa-close').onclick = function () {
      closePanel();
    };

    document.getElementById('dsh-sa-share-btn').onclick = async function () {
      openPanel();
      await render();
    };

    document.addEventListener('click', function (ev) {
      if (!root || !state.menuOpen) return;
      if (root.contains(ev.target) || (panel && panel.contains(ev.target))) return;
      setMenuOpen(false);
    });

    hookTransports();
    boot();
  }

  async function render() {
    paintUser();
    if (!state.me) {
      if (body) body.textContent = '请重新登录';
      return;
    }
    if (!body) return;

    var sid = await resolveSessionId();
    if (!sid) {
      body.innerHTML =
        '<div style="color:#666">还没有捕获到当前会话。</div>' +
        '<div style="color:#888;font-size:12px;margin-top:6px">DSH 打开会话时会带上 sessionId；请点一次左侧会话（或等对话加载完成）后再分享。</div>';
      return;
    }
    rememberSession(sid);

    var acl = state.acl && state.acl.sessionId === sid ? state.acl : await loadSessionAcl(sid);
    if (!acl) {
      body.innerHTML = '<div style="color:#b91c1c">无法读取当前会话权限，请刷新后重试。</div>';
      return;
    }

    var label = acl.displayLabel || catalogLabel(sid) || '当前会话';

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

  var bootPromise = null;

  async function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = (async function () {
      try {
        var meR = await fetch('/simple-auth/me', { credentials: 'same-origin' });
        if (!meR.ok) {
          if (root) root.style.display = 'none';
          if (panel) panel.style.display = 'none';
          return;
        }
        state.me = await meR.json();
        if (state.me && state.me.currentSessionId) rememberSession(state.me.currentSessionId);
        var usersR = await fetch('/simple-auth/users', { credentials: 'same-origin' });
        if (usersR.ok) state.users = await usersR.json();
        await fetchSessionList();
      } catch (e) {}
      paintUser();
      if (state.panelOpen) render();
    })();
    try {
      await bootPromise;
    } finally {
      if (!state.me) bootPromise = null;
    }
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
