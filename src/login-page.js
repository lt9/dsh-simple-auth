function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderLoginPage({ title, hint, next, error, remember, lang }) {
  const zh = lang === 'zh'
  const copy = zh
    ? {
        heading: title,
        hint: hint || '输入访问密钥后进入。本机会记住，下次打开自动登录；点退出才会忘掉。',
        placeholder: '访问密钥',
        enter: '进入',
        need: '请填写密钥',
        bad: '密钥不正确',
        rate: '尝试过于频繁，请稍后再试',
        missing: '服务端未配置访问密钥。设置环境变量或 keyFile 后重启。'
      }
    : {
        heading: title,
        hint: hint || 'Enter the access key to continue. This browser can remember it until you sign out.',
        placeholder: 'Access key',
        enter: 'Continue',
        need: 'Key is required',
        bad: 'Incorrect key',
        rate: 'Too many attempts, try again later',
        missing: 'No access key is configured. Set the environment variable or keyFile and restart.'
      }

  return `<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="referrer" content="no-referrer"/>
  <title>${esc(copy.heading)}</title>
  <style>
    :root { color-scheme: light; --ink:#1a1a1a; --muted:#667085; --line:#d9d9d9; --bg:#f6f5f2; --card:#fff; --accent:#1f4e3d; }
    * { box-sizing: border-box; }
    body { margin:0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color:var(--ink); background:var(--bg); }
    .box { max-width: 400px; margin: 14vh auto; padding: 28px 24px; background:var(--card); border:1px solid var(--line); border-radius: 10px; }
    h1 { font-size: 20px; margin: 0 0 8px; letter-spacing: -0.02em; }
    p { color: var(--muted); margin: 0 0 16px; }
    .lang { display:flex; gap:6px; margin-bottom: 14px; }
    .lang button { height: 28px; padding: 0 10px; border:1px solid var(--line); background:#fff; border-radius: 6px; cursor:pointer; color:var(--muted); }
    .lang button.on { border-color: var(--accent); color: var(--accent); }
    input { width:100%; height:44px; padding:0 12px; border:1px solid var(--line); border-radius:6px; font: inherit; }
    input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); border-color: var(--accent); }
    .btn { width:100%; height:44px; margin-top:12px; border:0; border-radius:6px; background:var(--accent); color:#fff; font: inherit; cursor:pointer; }
    .btn:hover { filter: brightness(1.08); }
    .err { color:#b42318; min-height: 1.4em; margin: 10px 0 0; font-size: 13px; }
    .row { display:flex; align-items:center; gap:8px; margin-top:12px; color:var(--muted); font-size:13px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="lang">
      <button type="button" data-lang="zh" class="${zh ? 'on' : ''}">中文</button>
      <button type="button" data-lang="en" class="${zh ? '' : 'on'}">EN</button>
    </div>
    <h1>${esc(copy.heading)}</h1>
    <p>${esc(copy.hint)}</p>
    <form id="f" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}"/>
      <input id="key" name="key" type="password" autocomplete="current-password" placeholder="${esc(copy.placeholder)}" enterkeyhint="go" autofocus/>
      <p id="err" class="err">${error === 'unconfigured' ? esc(copy.missing) : error === 'bad' ? esc(copy.bad) : error === 'rate' ? esc(copy.rate) : ''}</p>
      ${remember ? `<label class="row"><input type="checkbox" id="remember" checked/> ${zh ? '在这台设备记住密钥' : 'Remember key on this device'}</label>` : ''}
      <button class="btn" type="submit">${esc(copy.enter)}</button>
    </form>
  </div>
  <script>
    const STORE = 'dsh_simple_auth_key';
    const LANG = 'dsh_simple_auth_lang';
    const remember = ${remember ? 'true' : 'false'};
    const next = ${JSON.stringify(next)};
    for (const btn of document.querySelectorAll('[data-lang]')) {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(LANG, btn.getAttribute('data-lang')); } catch (e) {}
        const u = new URL(location.href);
        u.searchParams.set('lang', btn.getAttribute('data-lang'));
        location.href = u.pathname + u.search;
      });
    }
    if (remember) {
      try {
        const stored = localStorage.getItem(STORE) || '';
        if (stored && !document.getElementById('key').value) document.getElementById('key').value = stored;
      } catch (e) {}
    }
    document.getElementById('f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const key = (document.getElementById('key').value || '').trim();
      const err = document.getElementById('err');
      if (!key) { err.textContent = ${JSON.stringify(copy.need)}; return; }
      err.textContent = '';
      try {
        const r = await fetch('/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ key, next })
        });
        if (r.status === 429) { err.textContent = ${JSON.stringify(copy.rate)}; return; }
        if (!r.ok) { err.textContent = ${JSON.stringify(copy.bad)}; return; }
        if (remember) {
          const keep = document.getElementById('remember')?.checked;
          try {
            if (keep) localStorage.setItem(STORE, key);
            else localStorage.removeItem(STORE);
          } catch (e) {}
        }
        const data = await r.json().catch(() => ({}));
        location.href = data.next || next || '/';
      } catch (e) {
        err.textContent = e && e.message ? e.message : 'error';
      }
    });
  </script>
</body>
</html>`
}
