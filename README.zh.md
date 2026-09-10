# dsh-simple-auth

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 的极致轻量登录门。

零生产依赖。一个输入框。可选 **master / guest** 多把密钥。会话默认隔离；只有 **owner** 能分享或取消分享；侧栏列表按 **ACL 过滤**；右下角 **分享 FAB** 针对当前选中的会话。

目录里已有的登录门偏密码、TOTP、设置卡片。这一款只做共享密钥（或每用户密钥文件）+ 会话 ACL。不要和 `dsh-auth-gate`、`dsh-webui-auth`、`dsh-web-startup-auth`、`dsh-auth-gateway` 叠装。

[English](README.md)

## 安装

```bash
dsh plugin --profile web add github:lt9/dsh-simple-auth
```

若 profile 是 pnpm workspace 并报 `ERR_PNPM_ADDING_TO_ROOT`：

```bash
dsh plugin --profile web add -w github:lt9/dsh-simple-auth
```

本地目录：

```bash
dsh plugin --profile web add ./dsh-simple-auth
```

**重启 dsh 之前**先配好密钥。门是**默认拒绝**的：密钥缺失时登录页会说明原因，其它请求一律拒绝。

```bash
export DSH_SIMPLE_AUTH_KEY='足够长的随机串'
```

systemd / Docker 把同一变量写进 `Environment` / `EnvironmentFile`。若要复用已经在用的密钥，不要把密钥写进 YAML，只改 `keyEnv` 指向那个环境变量：

```yaml
# $DSH_HOME/cordis.patch.yml
- id: dsh-simple-auth
  config:
    keyEnv: EXISTING_SECRET_ENV
```

重启 dsh web 进程，打开页面，输入密钥即可。

`dsh --profile web --dump-config` 应能看到名为 `dsh-simple-auth` 的行。

## 截图

### 登录页

访客输入访问密钥进入；可选「在这台设备记住密钥」。

![登录页](docs/screenshots/login.png)

### 会话分享（多用户）

右下角分享面板：针对**左侧当前选中的会话**，owner 可分享给其他用户或取消分享；被分享方双方均可访问，但不能再次分享或取消。

![会话分享](docs/screenshots/session-share.png)

## 要求

- Node.js ≥ 20
- dsh 的 web profile（在 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `@deepseek-ai/dsh@0.1.2-rc.1` 上验证；两者仍暴露 `webServer.server`）
- 使用 `dsh plugin add` 时，`PATH` 上需要 `pnpm`

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
| `rpcMinTimeoutMs` | `120000` | 注入到页面的 `AbortSignal.timeout` 下限。dsh unary RPC 默认 30 秒，大历史页走隧道会报 `The user aborted a request`。`0` 关闭注入 |

不要把密钥写进 YAML 或 git。

## 多用户与会话分享（0.2+）

配置 `usersFile` 后进入多用户模式：登录页仍只填一把密钥，每把密钥绑定 `id` + `name`。Cookie 签 `userId`（独立 `secret` 文件），不再用登录密钥签名。

```json
// $DSH_HOME/simple-auth/users.json（0600）
[
  { "id": "master", "name": "master", "keyEnv": "LLAMA_API_KEY" },
  { "id": "guest", "name": "guest", "keyFile": "/path/to/guest-key" },
  { "id": "guest2", "name": "访客乙", "keyFile": "/path/to/guest2-key" }
]
```

`users.json` 是数组，可配置**任意多个访客**。每个用户独立 `id`、`name` 和密钥（`key` / `keyFile` / `keyEnv`）。

- 默认会话隔离：`session.list` / WebSocket 事件按 ACL 过滤
- **当前会话**以 DSH RPC 信封里的 `payload.sessionId` 为准（`session.history` / `session.prompt` 等），标题来自官方 `session.list`，不解析会话日志
- 分享后双方共用同一 `sessionId`；`session.prompt` / `session.updateQueue` 互斥（第二人 409 `session-busy`）
- 仅会话 **owner** 可分享或取消分享；被分享方只能访问，不能管理分享关系
- 归档等破坏性操作仅 owner
- 页面右下角注入分享面板（见上方截图）；也可调 `POST /simple-auth/share`、`/simple-auth/unshare`

| 项 | 默认 | 含义 |
|---|---|---|
| `usersFile` | `""` | 多用户 JSON；非空且有效时启用多用户 |
| `aclFile` | `$DSH_HOME/simple-auth/acl.json` | 会话 owner / sharedWith |
| `secretFile` | `$DSH_HOME/simple-auth/secret` | Cookie HMAC 密钥（自动生成） |
| `legacyOwner` | `master` | 升级时未登记 owner 的存量会话归此用户 |

## 已知限制

- 分享会话等于分享能跑命令的 agent，不只是聊天文本。llama 凭据、bash、workspace、settings 仍是整机共享。
- 这是访问控制，不是 TLS 或「agent 等于远程代码执行」的替代品。
- 目录上架（若已列出）不等于安全审计。

## 停用 / 卸载

```bash
dsh plugin --profile web remove dsh-simple-auth
```

然后重启 dsh web 进程。若只想暂时关掉而不卸载，去掉 `usersFile` / `keyEnv` / `keyFile`——门会关死。

## 安全

- 配置缺失时关死，不会把界面裸奔出去。
- 登录按客户端 IP 限速（仅当对端是回环时才信任 `X-Forwarded-For`）。
- 会话用访问密钥做 HMAC 签名（无状态）。轮换密钥会使全部 Cookie 失效。
- 已登录的 JSON `/api` 若是历史页，会丢掉已闭合消息的 `assistant/chunk`（[dsh #4678](https://github.com/deepseek-ai/deepseek-harness/discussions/4678)），避免浏览器拉十几 MB 的冗余增量。
- 公网请走 HTTPS，并保持 `cookieSecure: auto`。
- 走隧道时，把浏览器地址栏的主机也交给 dsh：`--trusted-host 你的域名或IP:端口`（可重复）。本插件登录后会把 `Host`/`Origin` 改写成回环；CLI 参数是官方文档里的备用围栏。

## 开发

```bash
node --test
```

生产依赖为零。Host 半区包裹 `webServer.server` 的 `request` / `upgrade` 监听器，因此静态资源、`/api` 和 socket 都会经过这扇门。0.1.2 的 Web 面额外有一层浏览器会话 Cookie（`connection.authorizeIndex`）；本插件在自家登录 Cookie 已通过后会跳过这层 401，这样无需进程启动 token 也能打开 SPA。0.1.1 没有这层围栏，行为不变。

## License

MIT
