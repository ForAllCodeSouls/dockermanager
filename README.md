# DockerManager

一个从零实现的 Docker Compose 管理器，用于管理宿主机上的 Compose 项目与容器。它不是 Dockge 的分支，也没有复用其源码，只是保留了“compose 文件即唯一真源”的工作方式。数据以 HTTP 快照为唯一真值，实时事件只作增量提示；连接状态降级为顶部的小角标，不遮罩、不禁用操作；标签页重新可见时主动对齐最新状态。

## 快速开始

和 Dockge 一样，三步部署：

```bash
mkdir -p /opt/stacks /opt/dockermanager
cd /opt/dockermanager
curl -fsSL https://raw.githubusercontent.com/ForAllCodeSouls/dockermanager/main/compose.yaml -o compose.yaml
docker compose up -d
```

浏览器打开 `http://<主机 IP>:5001`。首次进入设置管理密码（至少 8 位），之后用该密码登录。

<details>
<summary>如果拉不到 compose 文件，手动新建也可以（点击展开）</summary>

在 `/opt/dockermanager/compose.yaml` 写入：

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

然后执行 `docker compose up -d`。

</details>

<details>
<summary>部署说明（点击展开）</summary>

- **镜像**：推荐用 GHCR 镜像而不是 `build: .`，因为容器内自更新依赖镜像名。若要用本地源码构建，把 `image:` 换成 `build: .`，并按需调整 `IMAGE_NAME`。
- **GHCR 私有包**：首次推送的镜像默认是私有，需要在仓库 Packages 页面改为 Public，否则本机拉取会失败。
- **镜像名小写**：Docker 强制要求镜像路径全小写，因此统一使用 `ghcr.io/forallcodesouls/dockermanager`。CI 用 `github.repository` 生成镜像名并由 `metadata-action` 自动小写化，仓库名与账号名请保持小写，否则会出现 `repository name must be lowercase` 或匿名拉取被拒。
- **SETUP_TOKEN**：可选，用于保护首次设置密码。留空则任何人都能设置密码，建议仅在可信网络内使用。
- **路径一致**：`/opt/stacks` 在容器内外保持同一路径，是为了让 compose 里的相对路径 volume 能被 Docker daemon 正确解析；不要改成别的宿主机目录后再映射到不同容器路径。
- 项目配置实际保存在宿主机的 `/opt/stacks/<项目名>/compose.yaml`。

</details>

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
| `STACKS_DIR` | `/opt/stacks` | 项目配置根目录 |
| `SETUP_TOKEN` | 空 | 首次设置密码所需的令牌，留空则不校验 |
| `COOKIE_SECURE` | `false` | 全站 HTTPS 时设为 `true` |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥，默认持久化在 `DATA_DIR/session-secret` |
| `WEB_DIST` | 自动推断 | 前端构建产物目录 |
| `STATS_ENABLED` | `false` | 是否开启容器性能采样（CPU/内存/网络/磁盘 IO）。默认关闭，设置为 `true` 才启用 |
| `MODE` | `server` | `server` 主实例 / `agent` 远程代理 |
| `AGENT_TOKEN` | 空 | agent 模式的共享密钥（Bearer Token） |
| `AGENTS` | 空 | 主实例的 agent 列表，JSON 数组：`[{"id":"nas2","name":"备份机","url":"http://192.168.1.20:5001","token":"同一密钥"}]` |

## 功能

- 点击左侧「+ 新建项目」直接生成示例项目并打开配置，改完点「保存并启动」即可运行；也支持编辑、检查、下载、删除
- 启动、停止、重启、拉取、更新、停止并移除——**实时流式输出进度**
- 多选批量启动 / 停止 / 重启 / 更新，以及工具栏「全部拉取 / 全部更新」
- **单服务操作**：启动 / 停止 / 重启 / 拉取，输出同样进入实时任务面板
- **镜像管理**：镜像列表（含大小、标签、创建时间）、引用关系（哪些容器/项目在用）、未使用与悬空镜像检测、单个删除与批量清理；顶部「镜像」面板与项目页「镜像」标签均可操作
- **容器详情与文件**：查看环境变量（密钥脱敏）、挂载、端口、网络、健康检查；在线浏览 / 新建 / 编辑 / 删除容器文件
- **资源管理**：卷与网络的列表、创建、删除、清理未使用项；容器连接/断开网络
- **维护与备份**：一键清理停止的容器、未使用网络/卷、构建缓存；导出/恢复所有项目的 compose 与 .env（含卷元信息，卷内数据需另行备份）
- 容器服务状态、Web 终端、实时日志（**远程主机终端也可直接透传**）
- 容器实时统计（CPU / 内存 / 网络 / 磁盘 IO，每 3 秒采样）——**默认关闭，采样尚未完善**，需设置 `STATS_ENABLED=true` 开启
- **粘贴命令新建项目**：点左侧「+ 新建项目」，直接粘贴 `docker run` 启动命令，自动生成配置并一键创建、启动
- **多 Docker 主机管理**（顶部主机切换器，agent 模式；项目操作、日志、任务与终端均代理）
- **日志中心**：容器日志、任务输出、操作审计、服务自身运行日志都按启动时间单独存一个文件，追加写入 + 定时刷盘，避免断电损坏；实时日志只显示新输出，不再混入历史
  - 顶部「日志」按钮进入总入口，可按分类筛选、点开任意历史文件细看、下载或删除；任务输出用独立的紫色标识，和其他日志明显区分
  - 日志工具栏「历史」、任务面板「历史」、审计面板「查看历史文件」、诊断面板「运行日志」都能跳到对应分类
  - 日志中心可分别设置四类日志的保留天数（0 = 永久保留），并手动清理过期文件
- 操作审计日志（append-only JSONL，按启动时间分片，旧版单文件自动迁移）
- **手机网页适配**：窄屏自动切成单栏，底部「项目 / 配置 / 容器 / 日志」导航，日志、终端和任务在手机上同样可用；顶栏只保留日志 / 镜像 / 工具，其余操作收进「工具」菜单
- 自带网页标签图标与手机桌面图标（SVG / ICO / Apple Touch / PWA manifest），手机上可「添加到主屏幕」全屏使用
- 操作更稳妥：删除项目需输入项目名确认，批量操作二次确认，任务执行时锁定项目操作；支持 Ctrl/Cmd+S 保存配置、Esc 关闭面板
- 日志可切换自动跟随，手动上滚后显示「回到最新」；「隐藏当前」只清屏幕不删文件
- 连接诊断面板（连接状态、事件计数、快照序号、Docker 引擎状态）
- 容器自更新与只读调试链接

## 多 Docker 主机（Agent 模式）

在一台主实例之外，把 DockerManager 以 agent 模式部署到每台远程主机，即可在一个界面管理所有主机。

**远程主机（agent）** —— 挂载该主机的 docker.sock 与 stacks 目录，设置一个共享密钥：

```yaml
services:
  dockermanager-agent:
    image: ghcr.io/forallcodesouls/dockermanager:dev
    container_name: dockermanager-agent
    restart: unless-stopped
    ports:
      - "5001:5001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/stacks:/opt/stacks
    environment:
      MODE: agent
      AGENT_TOKEN: 换成一个长随机字符串
      STACKS_DIR: /opt/stacks
```

**主实例** —— 在原有 compose 的 `environment` 增加 `AGENTS`：

```yaml
      AGENTS: '[{"id":"nas2","name":"备份机","url":"http://192.168.1.20:5001","token":"同样的字符串"}]'
```

重启主实例后，顶部“主机”下拉框会出现远程主机。切换后所有项目操作、日志、统计、任务进度与交互式终端都会转发到该主机。

终端透传链路：浏览器连接主实例的 `/api/terminal?host=<id>&...`，主实例用会话 Cookie 校验用户身份，再用 `AGENT_TOKEN` 作为 Bearer Token 与远程 agent 建立 WebSocket，双向转发终端帧。远程 agent 不再需要暴露到公网，只需要主实例能访问其 `url`。

注意事项：
- `AGENT_TOKEN` 必须在主实例与 agent 完全一致；建议用 `openssl rand -hex 32` 生成。
- agent 的 `/api/health` 无需 token（用于在线探测），其余 API 与终端 WebSocket 均需 Bearer Token。
- 反向代理后的主实例需要支持 `Upgrade` 头（见“反向代理”一节）。
- 单一主机部署无需配置，默认行为与之前完全一致。

## 安全说明

- Docker socket 拥有宿主机级别的权限。只把 DockerManager 暴露给可信网络，或置于带认证的反向代理之后。
- 会话使用 HMAC 签名的 HttpOnly Cookie，前端不保存长期凭证。
- 项目名与服务名经过白名单校验，作为命令行参数传递，不经过 shell 拼接。
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

更新过程会拉取自身镜像，用一个**一次性 helper 容器**复制当前容器的 Env / Binds / 端口 / 网络 / Labels / 重启策略等配置，以新镜像重建自身容器，而不是原地 restart 旧容器。之所以用独立容器执行，是因为容器内 node 是 1 号进程，自己 stop 自己会导致后续重建步骤无法执行；helper 与主容器分离后即可安全完成。同时有互斥锁防止自动检查与手动更新并发触发。失败时会回滚到原镜像 ID。不修改宿主机文件、不重启其他容器、不安装宿主机脚本。若未挂载 docker.sock，检查会失败并在诊断面板显示原因。

手动操作入口位于诊断面板的“检查更新”与“立即更新”。

## 远程调试

`/api/system/version` 是公开只读接口，便于外部监控确认当前运行的提交与镜像 ID，不暴露配置、密码或容器数据。

诊断面板的“生成调试链接”会创建 HMAC 签名的短期只读 URL（默认 1 小时），持有者可访问：

- `/api/system/update`：更新状态
- `/api/system/logs?lines=200`：容器日志
- `/api/system/diagnostics`：完整诊断包（版本、更新状态、快照、审计、日志）

链接不含密码、会话 Cookie 或任何写操作权限，可安全提供用于远程排查。

## 已知限制

- 单用户模型（admin），尚未实现多用户与 RBAC。
- 终端会话在刷新后会新建 PTY，不恢复原 shell 上下文。
- 远程终端通过主实例中转；如果主实例与 agent 之间网络中断，终端会关闭，但 HTTP 数据与 SSE 会自动恢复。
- 自更新需要用新镜像重建自身容器，重建瞬间服务会有几秒不可用；需要零停机可改用外部反向代理做蓝绿切换。

## License

MIT
