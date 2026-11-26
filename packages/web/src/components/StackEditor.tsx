import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import {
  API,
  type ComposePayload,
  type ContainerInfo,
  type ServiceAction,
  type StackInfo,
  type TaskStarted,
  type ValidateResponse,
} from "@dockermanager/shared";
import { apiFetch, getCurrentHost, post, put, scopedUrl } from "../api";
import { TerminalView } from "./Terminal";

interface Props {
  stack: StackInfo;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
  onTask: (task: TaskStarted) => void;
}

const serviceActions: { action: ServiceAction; label: string }[] = [
  { action: "start", label: "启动" },
  { action: "stop", label: "停止" },
  { action: "restart", label: "重启" },
  { action: "pull", label: "拉取" },
];

function ServiceRows({
  services,
  onSelect,
  onAction,
}: {
  services: ContainerInfo[];
  onSelect: (service: string) => void;
  onAction: (service: string, action: ServiceAction) => void;
}) {
  return (
    <div className="service-rows">
      {services.map((container) => (
        <div className="service-row" key={container.id}>
          <button className="service-select" onClick={() => onSelect(container.name)}>
            {container.name}
          </button>
          <span className="service-mini-actions">
            {serviceActions.map((item) => (
              <button
                key={item.action}
                title={`${item.label}服务 ${container.name}`}
                onClick={() => onAction(container.name, item.action)}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function LogView({
  stack,
  service,
  host,
}: {
  stack: string;
  service: string;
  host: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    const source = new EventSource(scopedUrl(API.logs(stack, service)));
    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as string;
        setLines((old) => [...old.slice(-800), line]);
      } catch {
        // ignore
      }
    };
    return () => source.close();
  }, [stack, service, host]);
  return <pre className="log-view">{lines.join("\n")}</pre>;
}

export function StackEditor({ stack, onClose, onChanged, onNotice, onTask }: Props) {
  const host = getCurrentHost();
  const query = useQuery({
    queryKey: ["stack", host, stack.name],
    queryFn: () => apiFetch<ComposePayload>(API.stack(stack.name)),
  });
  const [compose, setCompose] = useState("");
  const [env, setEnv] = useState("");
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"compose" | "terminal" | "logs">("compose");
  const [terminalService, setTerminalService] = useState<string | null>(null);
  const [logService, setLogService] = useState<string | null>(null);

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

  async function runService(service: string, action: ServiceAction) {
    try {
      const started = await post<TaskStarted>(
        API.stackServiceAction(stack.name, service, action),
      );
      onTask(started);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "服务操作启动失败");
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
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{stack.name}</h2>
            <span className={`status ${stack.status}`}>{stack.status}</span>
          </div>
          <button className="ghost" onClick={onClose}>关闭</button>
        </header>

        <nav className="tabs">
          <button className={tab === "compose" ? "active" : ""} onClick={() => setTab("compose")}>
            配置
          </button>
          <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>
            终端
          </button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
            日志
          </button>
        </nav>

        <div className="drawer-body">
          {tab === "compose" && (
            <>
              {query.isLoading && <p className="muted">读取配置中…</p>}
              {query.isError && <p className="inline-error">{String(query.error)}</p>}
              <div className="editor-label">compose.yaml</div>
              <CodeMirror
                value={compose}
                theme="dark"
                extensions={[yaml()]}
                onChange={(value) => { setCompose(value); setDirty(true); }}
                basicSetup={{ lineNumbers: true, foldGutter: false }}
              />
              <div className="editor-label">.env</div>
              <textarea
                className="env-input"
                value={env}
                onChange={(e) => { setEnv(e.target.value); setDirty(true); }}
                spellCheck={false}
                rows={4}
              />
              <div className="editor-actions">
                <button className="ghost" onClick={() => void validate()}>校验配置</button>
                <button className="ghost" onClick={downloadCompose} disabled={!compose}>
                  下载 YAML
                </button>
                <button className="primary" onClick={() => void save()} disabled={!dirty}>
                  {dirty ? "保存更改" : "已保存"}
                </button>
              </div>
            </>
          )}

          {tab === "terminal" && (
            <>
              {services.length === 0 && <p className="muted">未检测到服务。</p>}
              <ServiceRows
                services={services}
                onSelect={setTerminalService}
                onAction={(service, action) => void runService(service, action)}
              />
              {terminalService && (
                <TerminalView host={host} stack={stack.name} service={terminalService} />
              )}
            </>
          )}

          {tab === "logs" && (
            <>
              <ServiceRows
                services={services}
                onSelect={setLogService}
                onAction={(service, action) => void runService(service, action)}
              />
              {logService ? (
                <LogView host={host} stack={stack.name} service={logService} />
              ) : (
                <p className="muted">选择服务以查看日志。</p>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
