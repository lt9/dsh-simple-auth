# dsh-simple-auth

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 的**单密钥**登录门。

没有用户表，没有「首次访问抢注密码」，没有运行时依赖。你准备一把访问密钥（环境变量或文件），访客输入一次，插件签发 HttpOnly Cookie，之后所有页面、API、WebSocket 升级都要带着有效会话。

形态和常见的私有看板 API Key 一样：一把密钥、一个输入框、可选「在这台设备记住」。

[English](README.md)

## 要求

- Node.js ≥ 20
- dsh 的 web profile（在 `@deepseek-ai/dsh@0.1.1-rc.2` 上验证；只要仍暴露 `webServer.server` 的新版本也应可用）
- 使用 `dsh plugin add` 时，`PATH` 上需要 `pnpm`

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-simple-auth
# 若报 ERR_PNPM_ADDING_TO_ROOT，把 -w 传给 pnpm：
#   dsh plugin --profile web add -w /path/to/dsh-simple-auth
```

**重启 dsh 之前**先配好密钥。门是**默认拒绝**的：密钥缺失时登录页会说明原因，其它请求一律拒绝。

```bash
export DSH_SIMPLE_AUTH_KEY='足够长的随机串'
```

systemd / Docker 把同一变量写进 `Environment` / `EnvironmentFile`。若要复用已经在用的密钥（例如和另一块本机看板同一把），不要把密钥写进 YAML，只改 `keyEnv` 指向那个环境变量：

```yaml
# $DSH_HOME/cordis.patch.yml
- id: dsh-simple-auth
  config:
    keyEnv: EXISTING_SECRET_ENV
```

重启 dsh web 进程，打开页面，输入密钥即可。

## 未登录时的行为

| 入口 | 未登录 | 已登录 |
|---|---|---|
| 页面 `GET`/`HEAD` | `302` → `/login` | 放行 |
| API / 其它方法 | `401` JSON | 放行 |
| WebSocket | 握手 `401` | 放行 |
| 脚本 | `Authorization: Bearer <key>` 或 `X-Api-Key` | 与会话等价 |

公开路径只有 `/login` 和 `/logout`。

## 配置

全部可选。默认值在代码里合并（home 层 patch 的 `config` **整段替换**，不是深合并）。

| 项 | 默认 | 含义 |
|---|---|---|
| `keyEnv` | `DSH_SIMPLE_AUTH_KEY` | 存放密钥的环境变量名 |
| `keyFile` | `""` | 若设置，从该文件读取密钥（去空白），优先于 `keyEnv` |
| `cookieName` | `dsh_simple_auth` | 会话 Cookie 名 |
| `sessionTtl` | `604800` | Cookie 有效期（秒） |
| `cookieSecure` | `auto` | `auto` 跟随 `X-Forwarded-Proto`；`true` / `false` 强制 `Secure` |
| `rewriteLoopback` | `true` | 已登录请求改写成 `127.0.0.1:<port>`，避免反代后 dsh 的 Host 围栏对特权 API 返回 403 |
| `title` | `DeepSeek Harness` | 登录页标题 |
| `hint` | 内置中英文案 | 登录页说明 |
| `remember` | `true` | 显示「在这台设备记住密钥」（只写 localStorage；服务端仍认 Cookie） |

不要把密钥写进 YAML 或 git。

## 安全

- 这是访问控制，不是 TLS、系统加固或「agent 等于远程代码执行」的替代品。拿到密钥就能驱动 agent。
- 配置缺失时关死，不会把界面裸奔出去。
- 登录按客户端 IP 限速（仅当对端是回环时才信任 `X-Forwarded-For`）。
- 会话用访问密钥做 HMAC 签名（无状态）。轮换密钥会使全部 Cookie 失效。
- 公网请走 HTTPS，并保持 `cookieSecure: auto`。

## 开发

```bash
node --test
```

生产依赖为零。Host 半区包裹 `webServer.server` 的 `request` / `upgrade` 监听器，因此静态资源、`/api` 和 socket 都会经过这扇门。

## License

MIT
