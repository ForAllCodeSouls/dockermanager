import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  Box,
  ChevronDown,
  CloudDownload,
  Download,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import {
  API,
  type ComposePayload,
  type ContainerInfo,
  type ImageInfo,
  type ImageRemoveRequest,
  type ImageRemoveResult,
  type ImagesResponse,
  type ServiceAction,
  type StackAction,
  type StackInfo,
  type TaskStarted,
  type ValidateResponse,
} from "@dockermanager/shared";
import { apiFetch, getCurrentHost, post, put, scopedUrl } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  stack: StackInfo;
  selectedService: string | null;
  onServiceSelect: (service: string) => void;
  onStackAction: (name: string, action: StackAction) => void;
  onServiceAction: (service: string, action: ServiceAction) => void;
  onRemove: (name: string) => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
}

const stackActions: { action: StackAction; label: string }[] = [
  { action: "start", label: "启动" },
  { action: "stop", label: "停止" },
  { action: "restart", label: "重启" },
  { action: "update", label: "更新" },
  { action: "pull", label: "拉取" },
  { action: "down", label: "停止并移除" },
];

const serviceActions: { action: ServiceAction; label: string }[] = [
  { action: "start", label: "启动" },
  { action: "stop", label: "停止" },
  { action: "restart", label: "重启" },
  { action: "pull", label: "拉取" },
];

const statusLabel: Record<string, string> = {
  running: "已启动",
  exited: "已停止",
  partial: "部分启动",
  created: "已创建",
  unknown: "未知",
  error: "异常",
};

const imageUsageLabel: Record<string, string> = {
  used: "使用中",
  declared: "项目声明",
  unused: "未使用",
  dangling: "悬空",
};

/** 与后端一致的镜像名规范化，供项目页匹配服务镜像。 */
function imageRefKeys(ref: string): string[] {
  const raw = (ref ?? "").trim().toLowerCase();
  if (!raw || raw.startsWith("<none>")) return [];
  if (raw.startsWith("sha256:")) return [raw];
  const slash = raw.lastIndexOf("/");
  const colon = raw.lastIndexOf(":");
  const hasTag = colon > slash;
  const repo = hasTag ? raw.slice(0, colon) : raw;
  const tag = hasTag ? raw.slice(colon + 1) : "latest";
  const keys = new Set([`${repo}:${tag}`, repo]);
  const bare = repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (bare !== repo) {
    keys.add(`${bare}:${tag}`);
    keys.add(bare);
  }
  if (!repo.includes("/")) {
    keys.add(`docker.io/library/${repo}:${tag}`);
    keys.add(`docker.io/library/${repo}`);
    keys.add(`library/${repo}:${tag}`);
    keys.add(`library/${repo}`);
  }
  return [...keys];
}

function matchesImage(image: ImageInfo, ref: string): boolean {
  const keys = imageRefKeys(ref);
  const imageKeys = [
    ...imageRefKeys(image.fullId),
    ...image.tags.flatMap(imageRefKeys),
  ];
  return keys.some((key) => imageKeys.includes(key));
}

/** YAML 语法高亮：键名蓝、字符串绿、数字橙、注释灰 */
const yamlHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "#7dcfff" },
  { tag: tags.string, color: "#9ece6a" },
  { tag: tags.number, color: "#ff9e64" },
  { tag: tags.bool, color: "#ff9e64" },
  { tag: tags.null, color: "#ff9e64" },
  { tag: tags.keyword, color: "#bb9af7" },
  { tag: tags.comment, color: "#6b7690", fontStyle: "italic" },
]);

const yamlTheme = EditorView.theme(
  {
    "&": { fontSize: "13px", backgroundColor: "var(--terminal-bg)" },
    ".cm-content": { padding: "10px 0", caretColor: "#7dcfff" },
    ".cm-gutters": {
      backgroundColor: "var(--terminal-bg)",
      borderRight: "1px solid var(--border-soft)",
      color: "#5b6580",
    },
    ".cm-activeLine": { backgroundColor: "rgba(125,207,255,.05)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(125,207,255,.08)" },
  },
  { dark: true },
);

function ServiceRows({
  services,
  selectedService,
  onSelect,
  onAction,
}: {
  services: ContainerInfo[];
  selectedService: string | null;
  onSelect: (service: string) => void;
  onAction: (service: string, action: ServiceAction) => void;
}) {
  return (
    <div className="service-rows">
      {services.map((container) => {
        const serviceName = container.service || container.name;
        return (
        <div
          className="service-row"
          key={container.id}
          style={selectedService === serviceName ? { borderColor: "var(--accent)" } : undefined}
        >
          <span className={`status-dot ${container.state}`} />
          <button className="service-select" onClick={() => onSelect(serviceName)}>
            {container.name}
          </button>
          <span className="service-sub">{container.status}</span>
          <span className="service-mini-actions">
            {serviceActions.map((item) => (
              <button
                key={item.action}
                title={`${item.label}服务 ${container.name}`}
                onClick={() => onAction(serviceName, item.action)}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
        );
      })}
    </div>
  );
}

export function StackEditor({
  stack,
  selectedService,
  onServiceSelect,
  onStackAction,
  onServiceAction,
  onRemove,
  onChanged,
  onNotice,
}: Props) {
  const host = getCurrentHost();
  const query = useQuery({
    queryKey: ["stack", host, stack.name],
    queryFn: () => apiFetch<ComposePayload>(API.stack(stack.name)),
  });
  const [compose, setCompose] = useState("");
  const [env, setEnv] = useState("");
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"compose" | "services" | "images">("compose");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<ImageInfo | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const imagesQuery = useQuery({
    queryKey: ["images"],
    queryFn: () => apiFetch<ImagesResponse>(API.images),
  });
  const removeImage = useMutation({
    mutationFn: (ids: string[]) =>
      post<{ results: ImageRemoveResult[] }>(API.imageRemove, {
        ids,
      } satisfies ImageRemoveRequest),
    onSuccess: (result) => {
      const failed = result.results.filter((item) => !item.ok);
      setPendingImage(null);
      onNotice(
        failed.length ? failed.map((item) => item.message).join("；") : "镜像已删除",
      );
      void queryClient.invalidateQueries({ queryKey: ["images"] });
      onChanged();
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "删除镜像失败"),
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (query.data) {
      setCompose(query.data.compose);
      setEnv(query.data.env ?? "");
      setDirty(false);
    }
  }, [query.data]);

  async function save(start = false) {
    try {
      await put(API.stack(stack.name), { compose, env });
      setDirty(false);
      onChanged();
      onNotice(start ? `已保存并启动 ${stack.name}` : `已保存 ${stack.name}`);
      if (start) onStackAction(stack.name, "start");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存失败");
    }
  }

  async function validate() {
    try {
      const result = await post<ValidateResponse>(API.stackValidate(stack.name), {
        compose,
        env,
      });
      onNotice(result.message);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "校验失败");
    }
  }

  function downloadCompose() {
    const blob = new Blob([compose], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${stack.name}-compose.yaml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const services = stack.services;
  const projectImages = useMemo(() => {
    const refs = services.map((service) => service.image).filter(Boolean);
    return (imagesQuery.data?.images ?? []).filter((image) =>
      refs.some((ref) => matchesImage(image, ref)),
    );
  }, [services, imagesQuery.data]);
  // 运行中显示“停止”，其余状态（已停止/已创建/部分启动/异常）统一显示“启动”，
  // 与状态徽章保持一致，避免“停止”和“启动”两个按钮同时出现。
  const isRunning = stack.status === "running";

  return (
    <section className="editor-pane">
      <header className="editor-head">
        <div className="editor-head-top">
          <span className={`status-badge ${stack.status}`}>
            {statusLabel[stack.status] ?? stack.status}
          </span>
          <h2 title={stack.name}>{stack.name}</h2>
          <span className="head-meta muted small">
            {services.length} 个服务 · 更新于 {new Date(stack.composeModifiedAt).toLocaleString("zh-CN")}
          </span>
        </div>
        <div className="stack-actions">
          <div className="action-group">
            <button
              className={`action-btn ${tab === "compose" ? "active" : ""}`}
              title="编辑配置"
              onClick={() => setTab("compose")}
            >
              <Pencil size={14} /> 编辑
            </button>
            <button className="action-btn" title="重启项目" onClick={() => onStackAction(stack.name, "restart")}>
              <RotateCw size={14} /> 重启
            </button>
            <button className="action-btn" title="拉取并更新" onClick={() => onStackAction(stack.name, "update")}>
              <CloudDownload size={14} /> 更新
            </button>
            <button
              className="action-btn"
              title={isRunning ? "停止项目" : "启动项目"}
              onClick={() => onStackAction(stack.name, isRunning ? "stop" : "start")}
            >
              {isRunning ? <Square size={13} fill="currentColor" /> : <Play size={13} />}
              {isRunning ? "停止" : "启动"}
            </button>
            <div className="action-more" ref={menuRef}>
              <button
                className="action-btn action-chevron"
                title="更多操作"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <ChevronDown size={15} />
              </button>
              {menuOpen && (
                <div className="action-menu">
                  {stackActions
                    .filter((item) => ["pull", "down"].includes(item.action))
                    .map((item) => (
                      <button
                        key={item.action}
                        onClick={() => {
                          onStackAction(stack.name, item.action);
                          setMenuOpen(false);
                        }}
                      >
                        {item.action === "start" ? <Play size={13} /> : item.action === "pull" ? <Download size={13} /> : <Box size={13} />}
                        {item.label}
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>
          <button className="delete-btn" title="删除项目" onClick={() => onRemove(stack.name)}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      </header>

      <nav className="editor-tabs">
        <button className={tab === "compose" ? "active" : ""} onClick={() => setTab("compose")}>
          compose.yaml
        </button>
        <button className={tab === "services" ? "active" : ""} onClick={() => setTab("services")}>
          服务 ({services.length})
        </button>
        <button className={tab === "images" ? "active" : ""} onClick={() => setTab("images")}>
          镜像 ({projectImages.length})
        </button>
      </nav>

      <div className="editor-body">
        {tab === "compose" && (
          <>
            {query.isLoading && <p className="muted">读取配置中…</p>}
            {query.isError && <p className="inline-error">{String(query.error)}</p>}
            <div className="editor-label">
              <span>compose.yaml</span>
              <span className="small">{dirty ? "未保存的更改" : "已保存"}</span>
            </div>
            <CodeMirror
              value={compose}
              theme={yamlTheme}
              extensions={[yaml(), syntaxHighlighting(yamlHighlight)]}
              onChange={(value) => { setCompose(value); setDirty(true); }}
              basicSetup={{ lineNumbers: true, foldGutter: false }}
            />
            <div className="editor-label"><span>.env</span></div>
            <textarea
              className="env-input"
              value={env}
              onChange={(e) => { setEnv(e.target.value); setDirty(true); }}
              spellCheck={false}
              rows={4}
            />
            <div className="editor-actions">
              <button className="ghost" onClick={() => void validate()}>检查配置</button>
              <button className="ghost" onClick={downloadCompose} disabled={!compose}>下载配置文件</button>
              <button className="ghost" onClick={() => void save()} disabled={!dirty}>只保存</button>
              <button className="primary" onClick={() => void save(true)}>
                保存并启动
              </button>
            </div>
          </>
        )}

        {tab === "services" && (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              点击服务名可在右侧查看终端与日志；操作会实时输出到任务面板。
            </p>
            {services.length === 0 ? (
              <p className="muted">这个项目暂无运行中的服务。</p>
            ) : (
              <ServiceRows
                services={services}
                selectedService={selectedService}
                onSelect={onServiceSelect}
                onAction={(service, action) => onServiceAction(service, action)}
              />
            )}
          </>
        )}

        {tab === "images" && (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              这里只显示当前项目服务使用的镜像。运行中的镜像需先停止服务才能删除；完整清理请打开顶部「镜像」面板。
            </p>
            {imagesQuery.isLoading && <p className="muted">读取镜像中…</p>}
            {imagesQuery.isError && <p className="inline-error">{String(imagesQuery.error)}</p>}
            {!imagesQuery.isLoading && projectImages.length === 0 && (
              <p className="muted">未找到该项目服务对应的镜像。</p>
            )}
            <div className="project-images">
              {projectImages.map((image) => (
                <div className="project-image-row" key={image.id}>
                  <div className="image-main">
                    <div className="image-tags">
                      {image.tags.length ? (
                        image.tags.map((tag) => <code key={tag}>{tag}</code>)
                      ) : (
                        <code className="muted">&lt;none&gt;</code>
                      )}
                    </div>
                    <div className="image-meta muted small">
                      ID {image.id} · {image.sizeLabel} ·{" "}
                      <span className={`image-usage usage-${image.usage}`}>
                        {imageUsageLabel[image.usage] ?? image.usage}
                      </span>
                    </div>
                  </div>
                  <button
                    className="ghost image-delete"
                    disabled={!image.cleanable || removeImage.isPending}
                    title={
                      image.cleanable
                        ? "删除镜像"
                        : "镜像正在被容器使用，请先停止服务"
                    }
                    onClick={() => setPendingImage(image)}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {stack.error && <div className="inline-error">{stack.error}</div>}
      </div>

      {pendingImage && (
        <ConfirmDialog
          title="删除镜像"
          message={`确定删除镜像 ${pendingImage.tags[0] ?? pendingImage.id} 吗？删除后下次启动会重新拉取，此操作不可撤销。`}
          confirmLabel="删除"
          danger
          busy={removeImage.isPending}
          onCancel={() => setPendingImage(null)}
          onConfirm={() => removeImage.mutate([pendingImage.fullId])}
        />
      )}
    </section>
  );
}
