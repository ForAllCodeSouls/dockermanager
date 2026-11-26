import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import {
  API,
  type ComposePayload,
  type ContainerInfo,
  type ServiceAction,
  type StackAction,
  type StackInfo,
  type TaskStarted,
  type ValidateResponse,
} from "@dockermanager/shared";
import { apiFetch, getCurrentHost, post, put, scopedUrl } from "../api";

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
  { action: "down", label: "Down" },
];

const serviceActions: { action: ServiceAction; label: string }[] = [
  { action: "start", label: "启动" },
  { action: "stop", label: "停止" },
  { action: "restart", label: "重启" },
  { action: "pull", label: "拉取" },
];

const statusLabel: Record<string, string> = {
  running: "运行中",
  exited: "已停止",
  partial: "部分运行",
  created: "已创建",
  unknown: "未知",
  error: "异常",
};

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
  const [tab, setTab] = useState<"compose" | "services">("compose");

  useEffect(() => {
    if (query.data) {
      setCompose(query.data.compose);
      setEnv(query.data.env ?? "");
      setDirty(false);
    }
  }, [query.data]);

  async function save() {
    try {
      await put(API.stack(stack.name), { compose, env });
      setDirty(false);
      onChanged();
      onNotice(`已保存 ${stack.name}`);
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

  return (
    <section className="editor-pane">
      <header className="editor-head">
        <div className="editor-head-top">
          <h2 title={stack.name}>{stack.name}</h2>
          <span className={`status-badge ${stack.status}`}>
            {statusLabel[stack.status] ?? stack.status}
          </span>
          <span className="muted small">
            {services.length} 个服务 · {new Date(stack.composeModifiedAt).toLocaleString("zh-CN")}
          </span>
        </div>
        <div className="stack-actions">
          {stackActions.map((item) => (
            <button
              key={item.action}
              className="ghost"
              onClick={() => onStackAction(stack.name, item.action)}
            >
              {item.label}
            </button>
          ))}
          <button className="ghost danger" onClick={() => onRemove(stack.name)}>删除</button>
        </div>
      </header>

      <nav className="editor-tabs">
        <button className={tab === "compose" ? "active" : ""} onClick={() => setTab("compose")}>
          compose.yaml
        </button>
        <button className={tab === "services" ? "active" : ""} onClick={() => setTab("services")}>
          服务 ({services.length})
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
              theme="dark"
              extensions={[yaml()]}
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
              <button className="ghost" onClick={() => void validate()}>校验配置</button>
              <button className="ghost" onClick={downloadCompose} disabled={!compose}>下载 YAML</button>
              <button className="primary" onClick={() => void save()} disabled={!dirty}>
                保存更改
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
              <p className="muted">该栈暂无运行中的服务。</p>
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

        {stack.error && <div className="inline-error">{stack.error}</div>}
      </div>
    </section>
  );
}
