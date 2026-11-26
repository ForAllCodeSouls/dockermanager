import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { API, type ConvertRunResponse } from "@dockermanager/shared";
import { post } from "../api";

interface Props {
  onClose: () => void;
  onNotice: (message: string) => void;
  onCreate: (compose: string) => void;
}

export function ConvertTool({ onClose, onNotice, onCreate }: Props) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<ConvertRunResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function convert() {
    if (!command.trim()) return;
    setBusy(true);
    try {
      const response = await post<ConvertRunResponse>(API.convertRun, { command });
      setResult(response);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "转换失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>把启动命令变成配置文件</h2>
            <span className="muted small">
              粘贴一条 docker run 命令，自动生成 DockerManager 可以直接创建和管理的 compose 配置
            </span>
          </div>
          <button className="ghost" onClick={onClose}>关闭</button>
        </header>
        <div className="drawer-body">
          <div className="editor-label">把启动容器的 docker run 命令粘贴到这里</div>
          <textarea
            className="env-input"
            rows={4}
            placeholder="例如：docker run -d --name web -p 8080:80 -e TZ=Asia/Shanghai nginx:alpine"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            spellCheck={false}
          />
          <button className="primary" onClick={convert} disabled={busy || !command.trim()}>
            {busy ? "生成中…" : "生成配置"}
          </button>
          {result && (
            <>
              {result.warnings.length > 0 && (
                <div className="convert-warnings">
                  {result.warnings.map((warning, index) => (
                    <p key={index} className="muted small">⚠ {warning}</p>
                  ))}
                </div>
              )}
              {result.compose ? (
                <>
                  <div className="editor-label">生成的配置如下，可以直接新建项目，也可以复制走</div>
                  <CodeMirror
                    value={result.compose}
                    theme="dark"
                    extensions={[yaml()]}
                    editable={false}
                    basicSetup={{ lineNumbers: true, foldGutter: false }}
                  />
                  <button
                    className="primary"
                    onClick={() => {
                      onCreate(result.compose);
                      onClose();
                    }}
                  >
                    用这份配置新建项目
                  </button>
                  <button
                    className="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(result.compose).catch(() => undefined);
                      onNotice("已复制配置内容");
                    }}
                  >
                    复制结果
                  </button>
                </>
              ) : (
                <div className="inline-error">无法转换，请查看提示</div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
