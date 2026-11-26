import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { API, type ComposePayload, type StackInfo } from "@stackdeck/shared";
import { apiFetch, put } from "../api";
import { TerminalView } from "./Terminal";

interface Props {
  stack: StackInfo;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
}

function LogView({ stack, service }: { stack: string; service: string }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    const source = new EventSource(API.logs(stack, service));
    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as string;
        setLines((old) => [...old.slice(-800), line]);
      } catch {
        // ignore
      }
    };
    return () => source.close();
  }, [stack, service]);
  return <pre className="log-view">{lines.join("\n")}</pre>;
}

export function StackEditor({ stack, onClose, onChanged, onNotice }: Props) {
  const query = useQuery({
    queryKey: ["stack", stack.name],
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
              <button className="primary" onClick={save} disabled={!dirty}>
                {dirty ? "保存更改" : "已保存"}
              </button>
            </>
          )}

          {tab === "terminal" && (
            <>
              {services.length === 0 && <p className="muted">未检测到运行中的服务。</p>}
              <div className="service-chips">
                {services.map((c) => (
                  <button key={c.id} onClick={() => setTerminalService(c.name)}>
                    {c.name}
                  </button>
                ))}
              </div>
              {terminalService && <TerminalView stack={stack.name} service={terminalService} />}
            </>
          )}

          {tab === "logs" && (
            <>
              <div className="service-chips">
                {services.map((c) => (
                  <button key={c.id} onClick={() => setLogService(c.name)}>
                    {c.name}
                  </button>
                ))}
              </div>
              {logService ? <LogView stack={stack.name} service={logService} /> : <p className="muted">选择服务以查看日志。</p>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
