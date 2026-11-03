# Codex Remote (`codex-remote`)

无需安装外部运行时依赖的 **Codex 手机远程控制端**（云端 TOTP 2FA Web 网关 + 本地一体式注册脚本）。

## 核心特性

1. **TOTP 双因素安全登录 + 30天持久会话**：
   - 使用 **访问口令 + RFC 6238 6位动态验证码（Google / Microsoft Authenticator / 1Password）** 登录。
   - 内置 IP 防爆破限流锁死（单 IP 每分钟限 5 次尝试，连续失败 5 次自动封禁 24 小时）。
   - 支持多部手机 / 平板同时在线，实时同步对话流与审批状态。
2. **多 Agent 免配置注册 + 手机端一键信任**：
   - 本地电脑运行 `./bin/codex-up` 自动连接云端 `/ws/agent`（无需预配繁琐的注册 Token）。
   - 手机网页顶部支持一键点击 **[信任并绑定]**，并可在多台在线电脑之间随时切换。
3. **本机端到端指令签名（防云主机失陷）**：
   - 本机自动生成 `LOCAL_SIGNING_KEY`（格式如 `XXXX-XXXX-XXXX`），仅保存在本机与手机浏览器 `localStorage` 中，永不上传云服务器。
   - Codex 的新建会话、发消息、命令审批均经 `HMAC-SHA256` + 时间戳防重放校验。
4. **同步 ChatGPT / Codex 桌面端全部工作区与历史会话**：
   - 自动解析 `~/.codex/.codex-global-state.json` 与 `~/.codex/state_5.sqlite`，按工作区目录分组展示全部会话，支持手机端浏览本机目录、新建对话、查看 Diff 及一键审批命令。
5. **Markdown 回复与后台会话状态**：
   - 历史消息和流式回复支持标题、列表、代码块、表格等 Markdown 格式，使用随项目提供的 Marked 与 DOMPurify 渲染和过滤，无需访问 CDN。
   - 切换会话时保留各会话的消息、执行和审批状态；发送目标在提交时固定，加载历史不会覆盖更新的实时消息。
6. **DSH Web 转发与统一登录**：
   - `codex-up` 自动管理本机 DSH Web，默认监听 `127.0.0.1:3081`。登录 Remote 并信任设备后，选择设备，再点击 **DSH** 应用卡片打开原生页面，复用访问口令与 TOTP 会话。
   - 页面、API、上传下载、SSE 和 WebSocket 通过既有 Agent 连接流式转发；DSH 启动令牌与会话 Cookie 仅保存在本机 Agent 中。
7. **完整交互与执行恢复**：
   - 问答支持选择、自定义回答、多题与私密输入；命令、文件和权限审批显示请求范围，插件支持结构化表单与验证链接。未知交互会显示明确提示和拒绝入口。
   - 同时支持阻塞式问答请求与 `request_user_input_async` 生成的消息问答。异步问答从 `agentMessage.questions` 渲染，通过正常会话提交结构化答案；历史按消息分页恢复，回答后保留处理状态。
   - 右侧待处理入口只统计当前会话，左侧会话及折叠的目录显示各自的待处理标记；后台问答、审批和回答确认都会更新标记。
   - 历史首屏最多读取 60 条完整消息，轮次状态单独轻量读取；快速切换复用页面，未变化的消息不重复渲染，更早内容按需加载。空思考摘要不显示，有内容的公开摘要按 Markdown 渲染。
   - 网页可见且设备在线受信任时，每 8 秒读取当前会话的新消息，每 30 秒更新会话列表；切回网页立即同步，隐藏页面暂停轮询。同步失败自动重试，不清空已有消息、问答草稿或历史分页。
   - 外部 ChatGPT / Codex 会话的历史 `interrupted` 状态不能证明原端任务停止，网页显示“外部会话，运行状态以原端为准”。停止和追加控制仅用于本机 Agent 确认管理的任务。
   - 左侧保留工作区分组，各组内会话按最近更新时间倒序排列，工作区也按最近会话排序。首次加载和分页均按更新时间查询；兼容旧版 Agent，无需重启正在执行任务的 Agent。
   - 刷新、重连或切换会话后，从本机 Agent 恢复待处理交互与执行状态。提交需等待 Codex 确认；失败保留草稿，多设备回答防重复。私密答案不落盘，刷新后需要重新填写。
   - 运行中可追加指令；重连重试、失败、停止和完成分别显示。支持执行计划、工具进度、历史分页与回到最新消息；向上阅读时不强制滚动。
   - Codex 子进程退出会自动恢复，未完成请求会明确失败，旧进程的交互不能提交给新进程。
8. **云端文件存储与下载**：
   - 受信任的 Agent 使用 `codex-up --upload 文件路径` 流式上传。网页顶部的 **文件** 入口展示文件列表，登录后可下载，设备离线后文件仍可用。
   - 默认单文件上限 256 MiB、总存储 10 GiB，保存在 `CODEX_DATA_DIR/files/`。上传使用设备专用凭据，撤销设备信任会立即取消上传权限。文件按附件下载，不作为网页执行。

## 快速使用

需要 Node.js 20+。启用 Codex 时需安装并登录 Codex CLI；DSH 功能需安装 `dsh`；OpenCode 功能需安装 OpenCode 2.0.32。运行 TLS 测试需要 `openssl`。

在项目目录准备本地配置：

```bash
cp .env.example .env
```

按需编辑 `.env`。本机测试的网关地址默认为 `ws://127.0.0.1:3280/ws/agent`；连接远程服务器时，将 `CODEX_RELAY_URL` 改为自己的 HTTPS 网关对应的 WSS 地址。

### 1. 本机一键启动并注册到云端

```bash
./bin/codex-up
```

本机访问模型服务需要代理时，先在同一个终端执行 `proxyon`，再运行 `codex-up`；也可按 `.env.example` 将代理变量写入项目 `.env`，启动脚本会自动导出给 Agent 和 Codex 子进程。修改代理后需要重启已经运行的 `codex-up`。

支持可选参数：
```bash
# 指定使用 deepseek profile 启动本机 codex app-server
./bin/codex-up --profile deepseek

# 自定义本机在手机端显示的名称
./bin/codex-up --name home-workstation

# 仅在需要配对时显示本机密钥，随后退出，不启动另一个 Agent
./bin/codex-up --show-pairing-key
```

Linux 上可安装为当前用户的 systemd 后台服务：

```bash
# 需要代理时先 proxyon，安装会保存当前代理和 PATH；服务仍会加载项目 .env
codex-up service install

systemctl --user status codex-up
systemctl --user restart codex-up
systemctl --user stop codex-up
journalctl --user -u codex-up -f

# 可选：指定启动参数或仅安装、不立即启动
codex-up service install --profile deepseek --cwd /path/to/workspace
codex-up service install --no-start

# 卸载服务
codex-up service uninstall
```

安装默认启用开机自启动和用户驻留（linger），退出终端、退出登录后继续运行，进程退出后自动重启。若系统要求管理员权限，安装命令会提示执行 `sudo loginctl enable-linger 用户名`；完成此步骤才会在用户尚未登录时启动。服务以当前用户身份运行，沿用本机 Codex 登录、设备身份及配对密钥。

服务配置位于 `~/.config/systemd/user/codex-up.service`，代理、PATH 和启动环境保存于 `~/.config/codex-remote/service.env`（权限 600；遵循 `XDG_CONFIG_HOME`）。修改项目 `.env` 后重启服务即可；重新安装会更新保存的代理与命令路径，切换 Node/NVM 版本后也应重新安装。现有服务的启动参数更新后，执行一次 `codex-up service restart` 生效。

安装时若已有前台 Agent，服务会等待它退出后接管，避免重复连接；当前任务结束后在原终端按 Ctrl+C 即可。服务运行期间仍可执行 `codex-up --upload ...` 或 `--show-pairing-key`。也可用 `codex-up service start|stop|restart|status|logs` 管理。

### 2. 启动云端服务

在服务器的项目目录中加载自己的配置并启动网关：

```bash
set -a
source .env
set +a
npm run cloud
```

默认监听 `3280` 端口。若自行配置了名为 `codex-remote-cloud` 的 systemd 服务，可使用以下命令管理：

```bash
sudo systemctl status codex-remote-cloud
sudo journalctl -u codex-remote-cloud -f
```

前端更新需要同步云端的整个 `src/public/` 目录（包括 `interactions.js`、`markdown.js` 和 `vendor/`），然后刷新网页。本地 Agent 逻辑更新后，停止并重新运行 `codex-up`。启动日志不再输出访问口令、TOTP 密钥、验证码或配对密钥；首次登录资料在服务器 `CODEX_DATA_DIR/auth.json` 中，由管理员在服务器本机安全读取。

### 3. HTTPS / WSS 与私有 CA

云端可通过 `CODEX_TLS_CERT_FILE` 和 `CODEX_TLS_KEY_FILE` 直接启用 TLS，无需反向代理。将 `CODEX_CLOUD_PORT` 设为 `443`；配置 `CODEX_HTTP_REDIRECT_PORT=80` 和 `CODEX_PUBLIC_ORIGIN=https://remote.example.com` 后，HTTP 入口会跳转至 HTTPS。将示例域名替换为自己的服务地址。登录 Cookie 自动设置 `Secure`。

本机 `.env` 使用以下配置连接私有 CA 签发的服务器证书：

```bash
CODEX_RELAY_URL=wss://remote.example.com/ws/agent
CODEX_RELAY_CA_FILE=/absolute/path/to/your-ca.crt
```

该 CA 只用于 Agent 的中继连接，证书链和服务器 IP 校验仍保持启用。浏览器或手机需要导入并信任同一 CA；HTTP 与 HTTPS 的浏览器本地存储独立，切换后需要在 HTTPS 页面重新登录、填写本机配对密钥。证书私钥保存在服务器 `/etc/ssl/codex-remote/`，不放入网页目录。更新 `.env` 后重启 `codex-up`。

### 4. 设备与原生应用

服务器和本地电脑都注册为设备。登录后先选设备，页面展示该设备启用的应用及运行状态：Codex 进入 Remote 会话界面，DSH 和 OpenCode 在新标签页打开原生界面。设备离线时保留入口但禁止打开；切换设备回到应用列表。每个原生页面的 URL 固定包含设备 ID，可同时打开不同设备的会话。

OpenCode：先在设备上配置并验证 OpenCode 2.0.32 的模型供应商，然后运行：

```bash
codex-up --opencode                       # 本地电脑：Codex + DSH + OpenCode
codex-up --opencode --no-codex --no-dsh   # 服务器：只运行 OpenCode
codex-up service install --opencode --no-codex --no-dsh  # Linux 常驻
```

OpenCode 仅监听 `127.0.0.1:3082`，使用每次启动随机生成的服务口令，网页通过 `/opencode/<agentId>/` 访问。无需开放额外公网端口。可通过 `CODEX_OPENCODE_BIN`、`CODEX_OPENCODE_PORT`、`CODEX_OPENCODE_CWD` 指定程序、端口与默认目录；`--no-opencode` 或 `CODEX_OPENCODE_ENABLED=0` 关闭。配置中的凭据由 OpenCode 自己保存，Remote 不把供应商密钥写入前端配置。

适配器保留 OpenCode 原生界面，只调整设备 URL 前缀、资源路径和路由，关闭其 Service Worker，并压缩文本资源以降低带宽消耗。当前固定支持 **2.0.32**，升级前需验证原生前端适配；建议设置 OpenCode 的 `"update": "disable"`。两台设备各自保存项目和会话，切换设备不会迁移工作目录或执行任务。

与 DSH 相同，OpenCode 原生 API 使用 Remote 登录与设备信任鉴权，不使用 Codex RPC 的 HMAC 签名；退出登录或撤销信任会关闭代理连接。OpenCode 以启动它的系统用户权限执行，服务器建议使用专用普通用户。

#### DSH Web

本机安装 `dsh` 后直接运行 `codex-up`。它会从用户主目录启动 `dsh web --no-open --host 127.0.0.1 --port 3081`，自动换取 DSH 会话，进程退出后重试，停止 `codex-up` 时一并停止托管进程。工作目录、可执行文件和端口可通过 `.env` 中的 `CODEX_DSH_CWD`、`CODEX_DSH_BIN`、`CODEX_DSH_PORT` 设置；使用 `codex-up --no-dsh` 或 `CODEX_DSH_ENABLED=0` 可关闭。

DSH 入口为 `/dsh/<agentId>/`，需 Remote 登录、目标设备在线并受信任。撤销设备信任或退出登录会关闭已有代理连接。每次上传最多 256 MiB，传输使用分块确认控制内存占用。DSH 原生请求使用 Remote 会话鉴权；Codex RPC 的端到端 HMAC 签名不应用于 DSH 原生 API。

### 5. Agent 上传文件与登录下载

升级后先重新运行一次 `codex-up`，并确保该设备已在网页上受信任。Agent 会自动保存专用上传凭据到 `CODEX_HOME/remote-agent-upload.json`（仅当前用户可读），不需要提供网页登录口令。

```bash
# 在另一个终端上传文件；不会启动另一个 Codex 进程
./bin/codex-up --upload ./report.pdf

# 指定下载名称，并关联一个会话（可选）
./bin/codex-up --upload ./report.pdf --name '项目报告.pdf' --thread-id THREAD_ID
```

成功后输出 JSON，其中 `file.url` 为下载地址。接收者需要登录同一个 Remote 服务后才能下载。也可在网页顶部点击 **文件** 浏览、刷新和分页下载。重新上传同名文件会创建新记录，不覆盖既有文件；上传失败和中断不会留下可下载的半成品。下载支持断点续传，文件不会自动过期。

云端通过 `CODEX_FILES_MAX_BYTES` 和 `CODEX_FILES_MAX_STORAGE_BYTES` 调整单文件及总容量，最多保存 10,000 个文件；最多同时处理 4 个上传，同一设备最多 2 个。存储不足时上传会明确失败。此版本提供列表和下载，清理存储由服务器管理员在停服后处理对应的文件及元数据。

接口：Agent 使用 `POST /api/files` 上传二进制，提供 `Authorization: Bearer <上传凭据>`、`X-Codex-Agent-Id`、URL 编码的 `X-File-Name` 和 `Content-Length`；网页登录会话访问 `GET /api/files` 及 `GET /api/files/<文件ID>/download`。上传凭据不会出现在文件列表、下载链接或 Git 中；私有 CA 配置同样用于上传连接。

## 验证

运行 `npm test`（TLS 测试需要 `openssl`）。测试覆盖认证、签名、HTTPS/WSS、DSH、交互确认与多设备去重、断线重连、进程崩溃和请求超时，以及切换会话、后台回复、历史竞态、分页和追加指令。自动集成测试使用临时目录与模拟服务，不访问本机真实会话或调用模型。

## 本地配置与版本控制

仓库只包含源码、测试、文档和无凭据的 `.env.example`。真实 `.env`、`data/`、`certs/`、私钥、运行日志及工具私有目录已由 `.gitignore` 排除。部署时自行配置域名、路径和证书；不要强制添加这些本地文件。第三方 Markdown 组件及其许可证保留在 `src/public/vendor/`。
