# dsh-simple-auth

A **single shared-key** login gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web.

No user table, no first-visit password claim, no extra runtime dependencies. You set one access key (environment variable or file). Visitors type that key once; the plugin sets an HttpOnly cookie and then every HTTP request and WebSocket upgrade is closed to everyone else.

This is the same shape as a private-dashboard API key: one secret, a login field, optional “remember on this device”.

[中文说明](README.zh.md)

## Requirements

- Node.js ≥ 20
- dsh web profile (tested on `@deepseek-ai/dsh@0.1.1-rc.2`; newer builds that still expose `webServer.server` should work)
- `pnpm` on `PATH` if you use `dsh plugin add`

## Install

```bash
dsh plugin --profile web add /path/to/dsh-simple-auth
# Some dsh web profiles are a pnpm workspace. If add refuses with
# ERR_PNPM_ADDING_TO_ROOT, pass -w through to pnpm:
#   dsh plugin --profile web add -w /path/to/dsh-simple-auth
```

Set the key **before** restarting dsh. The gate **fails closed**: if the key is missing, the login page explains that and every other request is denied.

```bash
export DSH_SIMPLE_AUTH_KEY='a-long-random-secret'
```

systemd / Docker: put the same variable in the service `Environment` / `EnvironmentFile`. To reuse an existing secret (for example the same value you already type into another local dashboard), point `keyEnv` at that variable instead of copying it:

```yaml
# $DSH_HOME/cordis.patch.yml  (home layer; replaces this plugin row's config)
- id: dsh-simple-auth
  config:
    keyEnv: EXISTING_SECRET_ENV
```

Restart the dsh web process, open the UI, enter the key.

## What it protects

| Surface | Unauthenticated | Authenticated |
|---|---|---|
| Pages (`GET`/`HEAD`) | `302` → `/login` | passed through |
| APIs / other methods | `401` JSON | passed through |
| WebSocket upgrade | handshake `401` | passed through |
| Scripts | `Authorization: Bearer <key>` or `X-Api-Key` | same as a session |

`/login` and `/logout` are the only public paths.

## Configuration

All keys are optional. Defaults are applied in code (home-layer patch `config` **replaces** the whole object, it does not deep-merge).

| Key | Default | Meaning |
|---|---|---|
| `keyEnv` | `DSH_SIMPLE_AUTH_KEY` | Environment variable that holds the access key |
| `keyFile` | `""` | If set, read the key from this file (trimmed). Takes precedence over `keyEnv` |
| `cookieName` | `dsh_simple_auth` | Session cookie name |
| `sessionTtl` | `604800` | Cookie lifetime in seconds (7 days) |
| `cookieSecure` | `auto` | `auto` follows `X-Forwarded-Proto`; `true` / `false` force the `Secure` flag |
| `rewriteLoopback` | `true` | Present authenticated traffic as `127.0.0.1:<port>` so dsh’s reverse-proxy Host fence does not 403 privileged APIs |
| `title` | `DeepSeek Harness` | Login heading |
| `hint` | (built-in zh/en copy) | Login subtitle |
| `remember` | `true` | Show “remember key on this device” (localStorage only; the server still uses the cookie) |

Never put the key itself in YAML or git.

## Security notes

- This is **access control**, not a substitute for TLS, OS hardening, or treating the agent as remote code execution. Anyone with the key can drive the agent.
- Fail-closed: misconfiguration does not leave the UI open.
- Login attempts are rate-limited per client IP (honors `X-Forwarded-For` only when the peer is loopback).
- Sessions are HMAC-signed with the access key (stateless). Rotating the key invalidates every cookie.
- Do not expose dsh over plaintext on the public internet; use HTTPS and keep `cookieSecure: auto`.

## Development

```bash
node --test
```

Zero production dependencies. The host half wraps `webServer.server` `request` / `upgrade` listeners (the same approach used by other dsh auth gates) so static files, `/api`, and sockets are covered even on builds that have no request-gate extension point.

## License

MIT
