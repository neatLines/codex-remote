# Docker 部署

这里将 HTTPS 转发网关和服务器 OpenCode 分成两个容器。OpenCode 容器内同时运行设备注册 Agent，继续使用原来的设备 ID、原生页面地址和 Remote 登录。其他电脑仍按原来的方式连接网关。

当前适配 Linux x86_64、Node 22.23.4 和 OpenCode 2.0.32。需要 Docker Engine、支持 `additional_contexts` 与 `start_interval` 的 Compose v2.20.2+，以及服务器上已经配置好的 TLS、网关数据和 OpenCode 用户目录。已验证 Docker 29.9.2 / Compose 5.7.0。

## 构建与启动

在包含本目录的项目副本中操作：

```bash
cd deploy/docker
cp .env.example .env
chmod 600 .env
# 编辑 .env，使用服务器现有的数据、证书、工作目录及 UID/GID。
# 将 examples/services.server.json 安装到 OPENCODE_HOME_DIR/.config/opencode/remote-services.json，
# 文件由 OpenCode 对应 UID/GID 持有，权限 600；该目录已挂载到容器。
sudo docker compose config --quiet
sudo docker compose build
```

OpenCode 镜像从 `OPENCODE_BINARY_DIR/opencode` 复制现有二进制，并校验 SHA-256 和版本。网关与 Agent 源码来自仓库；构建上下文只允许应用源码与容器入口，不包含模型密钥、数据库、工作区或 TLS 私钥。国内服务器可在 `.env` 启用示例中的腾讯云镜像源。

先确认云端 OpenCode 没有运行任务或待处理审批，再停止原来的服务；不能让两个 OpenCode 实例同时写同一数据库，也不能让两个 Agent 使用同一身份连接网关。先备份，随后切换：

```bash
sudo systemctl stop codex-remote-agent codex-remote-cloud
# 在服务停止期间备份下面列出的持久化目录及 systemd 单元。
sudo docker compose up -d --no-build --wait --wait-timeout 120
sudo docker compose ps
# 完成登录、设备连接、模型和终端验证后，关闭旧服务的开机启动。
sudo systemctl disable codex-remote-agent codex-remote-cloud
```

Compose 使用 `restart: unless-stopped`；Docker 服务须开启自启动。只发布 80/443，HTTP 跳转到原来的 HTTPS 地址。OpenCode 3082 与健康检查 3090 只监听容器内部回环地址，不发布端口。Agent 经原来的 WSS 地址连接网关，保留 CA 与服务器名称验证；服务器需能够从 Docker 网络访问这个地址。

## 数据与权限

| 内容 | 宿主机位置（由 `.env` 配置） | 容器位置 |
| --- | --- | --- |
| 登录、TOTP、设备信任和上传文件 | `REMOTE_DATA_DIR` | 网关 `/data` |
| HTTPS 证书与私钥 | `REMOTE_TLS_DIR` | 网关 `/run/tls`，只读 |
| CA 证书 | `REMOTE_CA_FILE` | 两个容器 `/run/remote-ca.crt`，只读 |
| 代码与工作文件 | `OPENCODE_HOME_DIR/workspaces` | `/home/opencode/workspaces` |
| 设备身份与上传凭据 | `OPENCODE_HOME_DIR/.codex` | `/home/opencode/.codex` |
| 模型设置 | `OPENCODE_HOME_DIR/.config/opencode` | `/home/opencode/.config/opencode` |
| 会话、模型登录凭据及日志 | `OPENCODE_HOME_DIR/.local/share/opencode` | 同路径 |
| 运行状态与缓存 | `OPENCODE_HOME_DIR/.local/state/opencode`、`.cache/opencode` | 同路径 |
| 容器内新增的用户文件/工具 | Docker 卷 `codex-remote_opencode-home` | `/home/opencode`，以上目录单独绑定 |

绑定目录必须预先存在且由对应 UID/GID 读写；Compose 不自动创建空目录掩盖路径错误。现有安装使用 `/home/opencode`，保持容器中的相同绝对路径可以保留历史会话的工作目录。若原来的会话在其他目录，先显式添加对应挂载并保持路径一致。

OpenCode 使用独立普通用户，不挂载 Docker socket、宿主机根目录、SSH 私钥或其他用户目录；没有附加 Docker 组、特权模式或宿主机网络。命令在容器内执行，镜像包含 Node/npm、Git、Python/venv、curl、SSH 客户端与 ripgrep。需要额外系统工具时更新 Dockerfile 并重建；用户工具可安装到持久化的 `~/.local`。工作目录下的所有子目录仍按文件权限可见。

两个容器的根文件系统只读，配置了进程数限制、日志轮转、健康检查和资源上限：网关 0.5 CPU / 256 MiB，OpenCode 2 CPU / 1536 MiB。OpenCode 的 `/tmp` 是 256 MiB 的可执行 tmpfs，因为 Bun 会在此解包并加载 PTY 和文件监听原生库；此空间计入容器内存，重建后清空。工作目录与持久化卷不会随容器重建清空。不要使用 `down -v` 删除用户卷。

## 日常管理

```bash
sudo docker compose ps
sudo docker compose logs --tail 100 -f gateway opencode
sudo docker compose restart opencode
sudo docker compose restart gateway
sudo docker compose exec opencode bash
```

更新源码后先 `sudo docker compose build`，在没有运行任务时执行 `sudo docker compose up -d --no-build --wait`。`restart` 不会应用 Compose 的环境变量或挂载改动，修改后应使用 `up -d`。OpenCode 主进程由 Agent 自动恢复，WSS 断线会自动重连；健康检查还验证 Agent 已连接且 OpenCode 就绪。单纯变为 unhealthy 不会触发 Docker 自动重启，可查看日志定位问题。

## 本次服务器迁移与回退

上海服务器的运行副本位于 `/home/ubuntu/codex-remote-docker`，Compose 文件位于其中的 `deploy/docker`。网关数据仍使用 `/home/ubuntu/codex-remote/data`，OpenCode 数据仍使用 `/home/opencode` 下的上述目录。旧代码、二进制与 systemd 单元保留，Hermes 独立运行。

需要回退时，在服务器执行：

```bash
cd /home/ubuntu/codex-remote-docker/deploy/docker
sudo docker compose down
sudo systemctl enable --now codex-remote-cloud
sudo systemctl enable --now codex-remote-agent
```

两个部署使用相同版本的 OpenCode 和相同持久化目录，常规回退直接使用最新数据，不覆盖数据库。迁移时的离线备份位于 `/home/ubuntu/codex-remote-backups/docker-*`；备份含登录凭据，只允许管理员读取。恢复备份前停止相关写入服务，避免覆盖迁移后的新会话。

## 设备服务清单

OpenCode 容器读取 `OPENCODE_SERVICES_FILE`，默认 `/home/opencode/.config/opencode/remote-services.json`（Compose 中传给 `CODEX_WEB_SERVICES_FILE`）。把 `examples/services.server.json` 复制到宿主机现有 OpenCode 配置目录的 `remote-services.json`，由该配置目录的现有挂载提供给容器。清单只声明 OpenCode；它仍由 Agent 管理启动，公网访问使用网关鉴权。
