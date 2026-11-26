import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { API, type ConvertRunResponse } from "@dockermanager/shared";
import { post } from "../api";
import { DEFAULT_COMPOSE } from "../defaults";

interface Props {
  saving: boolean;
  onCancel: () => void;
  onCreate: (compose: string) => void;
  onNotice: (message: string) => void;
}

export function NewProject({ saving, onCancel, onCreate, onNotice }: Props) {
  const [command, setCommand] = useState("");
  const [compose, setCompose] = useState(DEFAULT_COMPOSE);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [converted, setConverted] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (timer.current !== null) window.clearTimeout(timer.current);

    const text = command.trim();
    if (!text) {
      setBusy(false);
      setCompose(DEFAULT_COMPOSE);
      setWarnings([]);
      setConverted(false);
      return;
    }

    timer.current = window.setTimeout(() => {
      setBusy(true);
      void post<ConvertRunResponse>(API.convertRun, { command: text })
        .then((result) => {
          if (cancelled) return;
          setWarnings(result.warnings ?? []);
          if (result.compose) {
            setCompose(result.compose);
            setConverted(true);
          } else {
            setConverted(false);
            onNotice("这条命令没识别出来，请检查后再试");
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) onNotice(error instanceof Error ? error.message : "自动转换失败");
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [command]);

  return (
    <section className="editor-pane new-project-pane">
      <header className="editor-head">
        <div className="editor-head-top">
          <h2>新建项目</h2>
          <span className="muted small">
            粘贴 docker run 命令自动生成配置；留空则使用示例配置
          </span>
        </div>
      </header>

      <div className="editor-body">
        <div className="editor-label">
          <span>docker run 命令（可选）</span>
          <span className="small">
            {busy ? "正在生成配置…" : converted ? "已根据命令生成" : "直接留空也可以用示例"}
          </span>
        </div>
        <textarea
          className="env-input"
          rows={4}
          spellCheck={false}
          placeholder="例如：docker run -d --name web -p 8080:80 -e TZ=Asia/Shanghai nginx:alpine"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />

        {warnings.length > 0 && (
          <div className="convert-warnings">
            {warnings.map((warning, index) => (
              <p key={index} className="muted small">⚠ {warning}</p>
            ))}
          </div>
        )}

        <div className="editor-label">
          <span>生成的配置（可以继续修改）</span>
        </div>
        <CodeMirror
          value={compose}
          theme="dark"
          extensions={[yaml()]}
          onChange={(value) => setCompose(value)}
          basicSetup={{ lineNumbers: true, foldGutter: false }}
        />

        <div className="editor-actions">
          <button className="ghost" onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={busy || saving}
            onClick={() => onCreate(compose)}
          >
            创建并启动
          </button>
        </div>
      </div>
    </section>
  );
}
