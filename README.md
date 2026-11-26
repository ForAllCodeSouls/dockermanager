# DockerManager

一个从零实现的 Docker Compose 管理器，用于管理宿主机上的 Compose 栈与容器。它不是 Dockge 的分支，也没有复用其源码，只是保留了“compose 文件即唯一真源”的工作方式。数据以 HTTP 快照为唯一真值，实时事件只作增量提示；连接状态降级为顶部的小角标，不遮罩、不禁用操作；标签页重新可见时主动对齐最新状态。

## 快速开始

一条命令即可用 Compose 启动。先准备目录，再把下面的 `compose.yaml` 放到任意目录（例如 `/opt/dockermanager`）：

```bash
mkdir -p /opt/stacks /opt/dockermanager
```

```yaml
services:
  dockermanager:
    image: ghcr.io/forallcodesouls/dockermanager:dev
    container_name: dockermanager
    restart: unless-stopped
    ports:
      - "5001:5001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      - /opt/stacks:/opt/stacks
    environment:
      TZ: Asia/Shanghai
      STACKS_DIR: /opt/stacks
      DATA_DIR: /app/data
      SETUP_TOKEN: ${SETUP_TOKEN:-}
      AUTO_UPDATE: ${AUTO_UPDATE:-true}
      AUTO_UPDATE_APPLY: ${AUTO_UPDATE_APPLY:-true}
      UPDATE_INTERVAL_SECONDS: ${UPDATE_INTERVAL_SECONDS:-600}
      IMAGE_NAME: ghcr.io/forallcodesouls/dockermanager:dev
```

启动并访问：

```bash
cd /opt/dockermanager && docker compose up -d
```

浏览器打开 `http://<主机>:5001`。首次进入设置管理密码（至少 8 位），之后用该密码登录。

几点说明：

- **镜像**：推荐用 GHCR 镜像而不是 `build: .`，因为容器内自更新依赖镜像名。若要用本地源码构建，把 `image:` 换成 `build: .`，并按需调整 `IMAGE_NAME`。
- **GHCR 私有包**：首次推送的镜像默认是私有，需要在仓库 Packages 页面改为 Public，否则本机拉取会失败。
- **镜像名小写**：Docker 强制要求镜像路径全小写，因此统一使用 `ghcr.io/forallcodesouls/dockermanager`。CI 用 `github.repository` 生成镜像名并由 `metadata-action` 自动小写化，仓库名与账号名请保持小写，否则会出现 `repository name must be lowercase` 或匿名拉取被拒。
- **SETUP_TOKEN**：可选，用于保护首次设置密码。留空则任何人都能设置密码，建议仅在可信网络内使用。
- **路径一致**：`/opt/stacks` 在容器内外保持同一路径，是为了让 compose 里的相对路径 volume 能被 Docker daemon 正确解析；不要改成别的宿主机目录后再映射到不同容器路径。
- 栈文件实际保存在宿主机的 `/opt/stacks/<栈名>/compose.yaml`。

## 为什么重做

同类工具常见的痛点是：把整个 UI 的可用性绑定在一条 Socket.IO 长连接上。默认 `polling` 优先的升级路径在部分 Chrome / 局域网 / 反向代理组合下会出现空 `400` 响应与 connect-disconnect 循环；浏览器切到后台后的连接节流又会放大心跳超时。结果是“回来就要刷新”，正常使用也会周期性掉线。

DockerManager 的处理方式：

| 关注点 | 做法 |
| --- | --- |
| 数据真值 | HTTP 快照接口 `/api/stacks`，前端用 TanStack Query 缓存 |
| 实时更新 | SSE `/api/events`，服务端按序号回放，客户端用 `Last-Event-ID` 自动续传 |
| 断线表现 | 连接状态只显示为一个低调角标，页面上方不出现红色横幅，不弹遮罩、不禁用操作 |
| 标签页恢复 | `visibilitychange` 主动拉取全量快照，事件回放只用于降低延迟 |
| 双向交互 | 终端与日志流使用独立 WebSocket / SSE，和控制面互不牵连 |
| 传输兼容 | SSE 基于普通 HTTP，天然兼容直连与 Nginx / Traefik / Caddy 反向代理，无需 upgrade 竞态处理 |

## 反向代理

SSE 需要关闭缓冲。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:5001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding on;
}
```

WebSocket 终端同样走该 location，`Upgrade` 头由 Nginx 默认转发；若你的配置里显式设置了 `Connection`，请保留 `Upgrade` 和 `Connection "upgrade"`。

Traefik 用户需要关闭该路由的缓冲中间件，并将 `entryPoint` 的响应超时调到足够大。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5001` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/app/data` | 认证信息、会话密钥与审计日志目录 |
| `STACKS_DIR` | `/opt/stacks` | 栈文件根目录 |
| `SETUP_TOKEN` | 空 | 首次设置密码所需的令牌，留空则不校验 |
| `COOKIE_SECURE` | `false` | 全站 HTTPS 时设为 `true` |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥，默认持久化在 `DATA_DIR/session-secret` |
| `WEB_DIST` | 自动推断 | 前端构建产物目录 |

## 功能

- 栈的创建、编辑（YAML 语法校验）、删除
- 启动、停止、重启、拉取、更新、down
- 多选批量启动 / 停止 / 重启 / 更新
- 容器服务状态、Web 终端、实时日志
- 操作审计日志（append-only JSONL）
- 连接诊断面板（连接状态、事件计数、快照序号、Docker 引擎状态）

## 安全说明

- Docker socket 拥有宿主机级别的权限。只把 DockerManager 暴露给可信网络，或置于带认证的反向代理之后。
- 会话使用 HMAC 签名的 HttpOnly Cookie，前端不保存长期凭证。
- 栈名与服务名经过白名单校验，作为命令行参数传递，不经过 shell 拼接。
- 全站 HTTPS 环境请设置 `COOKIE_SECURE=true`。

## 本地开发

```bash
npm install
npm run build
npm test
# 终端 1
npm run dev:server
# 终端 2
npm run dev:web
```

开发模式下 Vite 将 `/api` 代理到 `127.0.0.1:5001`。

## CI / CD

- `ci.yml`：push 与 PR 时执行依赖安装、构建、类型检查与单元测试。
- `docker.yml`：push 到 `main` 发布 `ghcr.io/forallcodesouls/dockermanager:dev`；推送 `v*` 标签发布 `:latest` 及版本标签。镜像元数据包含 commit SHA 与构建时间。

## 自更新

容器内守护进程定期检查当前镜像是否有新版本：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTO_UPDATE` | `true` | 关闭后只保留手动更新 |
| `AUTO_UPDATE_APPLY` | `true` | 发现新版本后自动重启自身容器 |
| `UPDATE_INTERVAL_SECONDS` | `600` | 检查间隔，最小 60 秒 |
| `IMAGE_NAME` | 空（自动检测） | 可显式指定 `ghcr.io/forallcodesouls/dockermanager:dev` |

更新过程只做两件事：拉取自身镜像、重启自身容器。不修改宿主机文件、不重启其他容器、不安装宿主机脚本。若未挂载 docker.sock，检查会失败并在诊断面板显示原因。

手动操作入口位于诊断面板的“检查更新”与“立即更新”。

## 远程调试

诊断面板的“生成调试链接”会创建 HMAC 签名的短期只读 URL（默认 1 小时），持有者可访问：

- `/api/system/version`：版本与镜像信息
- `/api/system/update`：更新状态
- `/api/system/logs?lines=200`：容器日志
- `/api/system/diagnostics`：完整诊断包（版本、更新状态、快照、审计、日志）

链接不含密码、会话 Cookie 或任何写操作权限，可安全提供用于远程排查。

## 已知限制

- 单用户模型（admin），尚未实现多用户与 RBAC。
- 多主机 / agent 管理尚未实现。
- 终端会话在刷新后会新建 PTY，不恢复原 shell 上下文。
- 当前版本的构建与测试在 Node 22 上通过；容器镜像需要在有 Docker 的环境内做最终实测。

## License

MIT
