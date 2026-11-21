# RemoteHub (`remote-hub`)

零外部运行时依赖的 **多设备远端服务控制中心**（云端 TOTP 2FA Web 网关 + 本地一体式注册 Agent，支持 **T3 Code / DSH / OpenCode / 通用 HTTP 端口** 的鉴权适配与页面内嵌）。

## 核心特性

1. **TOTP 双因素安全登录 + 30天持久会话**：
   - 使用 **访问口令 + RFC 6238 6位动态验证码（Google / Microsoft Authenticator / 1Password）** 登录。
   - 内置 IP 防爆破限流锁死（单 IP 每分钟限 5 次尝试，连续失败 5 次自动封禁 24 小时）。
2. **多设备免配置注册 + 网页一键信任**：
   - 本地电脑或服务器运行 `./bin/codex-up` 自动连接云端 `/ws/agent`。
   - 网页支持一键点击 **[信任并绑定]**，并可在左侧菜单栏随时切换多台在线设备。
3. **可折叠左侧菜单栏 + 右侧全屏内嵌工作区**：
   - 左侧可收缩菜单栏集成设备切换、网页服务列表、通用端口转发输入与云端文件入口；收起侧边栏后右侧内嵌 `iframe` 工作区可占满全屏。
   - **T3 Code / DSH / OpenCode / 通用网页服务** 均支持在右侧工作区直接内嵌使用（登录并信任设备后默认自动内嵌加载 T3 Code 等就绪服务），同时提供顶栏与菜单项 **[新窗口 ↗]** 按钮。
4. **通用转发 + 托管服务鉴权适配**：
   - 推荐通过 `services.json` 声明每台设备的服务清单（`kind` 支持 `t3-code`、`dsh`、`opencode` 和默认 `http`），统一走 `/local/<agentId>/<port>/` 通用转发与鉴权注入通道：
     - **`t3-code`**：自动启动 `t3 serve` 或复用已运行实例，在本机创建并兑换配对码，在回环转发时自动注入 T3 会话 Cookie。
     - **`dsh`**：自动管理 `dsh web`，换取启动 Token 与会话 Cookie 并注入通用转发层。
     - **`opencode`**：自动管理 `opencode serve`（2.0.32），读取原生密码注入 Authorization 头并适配子路径路由。
     - **`http`**：探测并转发任意已在运行的本地端口，支持在 `auth.headers` / `auth.query` 中声明自定义认证注入，修改保存后约 2 秒热重载。
   - 未指定 `services.json` 时，支持在左侧菜单栏直接输入任意本地端口或 `http://127.0.0.1:<port>/...` 地址，在右侧工作区内嵌打开或新窗口打开。
   - 完整支持 HTTP、上传下载、SSE 和 WebSocket 流式转发；当网络环境阻断 WebSocket 时，自动降级至 HTTPS 长轮询（`/api/socket/`）。
5. **云端文件存储与下载**：
   - 受信任的 Agent 使用 `codex-up --upload 文件路径` 流式上传。左侧菜单栏的 **云端文件** 入口展示文件列表，登录后可下载或删除，设备离线后文件仍可用。
   - 默认单文件上限 256 MiB、总存储 10 GiB，保存在 `CODEX_DATA_DIR/files/`。撤销设备信任会立即取消该设备的上传权限。

## 快速使用

需要 Node.js 20+。按需安装 `t3`（T3 Code CLI）、`dsh` 或 `opencode`（2.0.32）。运行 TLS 测试需要 `openssl`。

在项目目录准备本地配置：

```bash
cp .env.example .env
```

### 1. 本机启动并注册到云端

```bash
# 使用服务清单启动（推荐，统一管理 T3 Code / DSH / OpenCode / 本地面板）
./bin/codex-up --services ./examples/services.local.json

# 查看托管服务在本机的原生访问地址与凭据
./bin/codex-up --show-local-services

# 或直接启动通用端口转发模式，并自定义设备名称
./bin/codex-up --name home-workstation
```

`services.json` 格式示例（参考 [本地电脑清单](examples/services.local.json) 和 [服务器清单](examples/services.server.json)）：

```json
{
  "services": [
    { "id": "dsh", "name": "DSH", "kind": "dsh", "port": 3081 },
    { "id": "opencode", "name": "OpenCode", "kind": "opencode", "port": 3082 },
    { "id": "t3-code", "name": "T3 Code", "kind": "t3-code", "port": 3773 },
    { "id": "panel", "name": "9090 面板", "port": 9090, "path": "/ui/#/overview" }
  ]
}
```

Linux 上可安装为当前用户的 systemd 后台服务：

```bash
codex-up service install --services /absolute/path/to/services.json
codex-up service status
codex-up service restart
codex-up service logs
codex-up service uninstall
```

### 2. 启动云端服务

```bash
set -a
source .env
set +a
npm run cloud
```

默认监听 `3280` 端口。首次登录资料生成在服务器 `CODEX_DATA_DIR/auth.json` 中，不写入日志。可通过 `CODEX_TLS_CERT_FILE` 和 `CODEX_TLS_KEY_FILE` 直接启用 HTTPS/WSS。服务器容器化部署见 [Docker Compose 部署说明](deploy/docker/README.md)。

### 3. Agent 上传文件与登录下载

```bash
./bin/codex-up --upload ./report.pdf
./bin/codex-up --upload ./report.pdf --name '项目报告.pdf'
```

## 验证

运行 `npm test`（TLS 测试需要 `openssl`）。

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 neatLines。
