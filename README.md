# DockerManager

一个从零实现的 Docker Compose 管理器。设计目标很明确：**切走标签页再回来，不需要刷新；网络抖动时界面不崩、不弹整屏红条。**

DockerManager 不是 Dockge 的分支，也没有复用其源码。它保留“compose 文件即唯一真源”的工作方式，但重新设计了通信与状态层。

## 为什么重做

同类工具常见的痛点是：把整个 UI 的可用性绑定在一条 Socket.IO 长连接上。默认 `polling` 优先的升级路径在部分 Chrome / 局域网 / 反向代理组合下会出现空 `400` 响应与 connect-disconnect 循环；浏览器切到后台后的连接节流又会放大心跳超时。结果是“回来就要刷新”，正常使用也会周期性掉线。

DockerManager 的处理方式：

| 关注点 | 做法 |
| --- | --- |
| 数据真值 | HTTP 快照接口 `/api/stacks`，前端用 TanStack Query 缓存 |
| 实时更新 | SSE `/api/events`，服务端按序号回放，客户端用 `Last-Event-ID` 自动续传 |
| 断线表现 | 仅顶部角标变为“重连中 · 显示缓存数据”，不弹全屏遮罩、不禁用操作 |
| 标签页恢复 | `visibilitychange` 主动拉取全量快照，事件回放只用于降低延迟 |
| 双向交互 | 终端与日志流使用独立 WebSocket / SSE，和控制面互不牵连 |
| 传输兼容 | SSE 基于普通 HTTP，天然兼容直连与 Nginx / Traefik / Caddy 反向代理，无需 upgrade 竞态处理 |

## 快速开始

在宿主机准备目录：

```bash
mkdir -p /opt/stacks
```

修改 `compose.yaml` 中的 `SETUP_TOKEN`（可选，用于保护首次密码设置），然后：

```bash
docker compose up -d --build
```

访问 `http://<主机>:5001`。首次进入设置管理密码（至少 8 位），之后用该密码登录。

> compose 文件保存在宿主机的 `/opt/stacks/<栈名>/compose.yaml`。该路径在容器内与宿主机保持一致，是为了让 compose 中的相对路径 volume 能被 Docker daemon 正确解析。

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

仓库包含两个 GitHub Actions 工作流：

- `ci.yml`：在 push 与 PR 时执行依赖安装、类型检查、单元测试和全量构建。
- `docker.yml`：推送 `v*` 标签时构建多架构镜像并发布到 GHCR（`ghcr.io/<owner>/<repo>`），使用内置的 `GITHUB_TOKEN`，无需额外配置密钥。

## 已知限制

- 单用户模型（admin），尚未实现多用户与 RBAC。
- 多主机 / agent 管理尚未实现。
- 终端会话在刷新后会新建 PTY，不恢复原 shell 上下文。
- 当前版本的构建与测试在 Node 22 上通过；容器镜像需要在有 Docker 的环境内做最终实测。

## License

MIT
