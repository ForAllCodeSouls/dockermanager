import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 需要手动输入这段文字才能确认，用于删除项目等高风险操作 */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 网页内确认框，替代浏览器原生 confirm/alert */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  requireText,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const matches = !requireText || typed.trim() === requireText;

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={`modal-icon ${danger ? "danger" : ""}`}>
          <AlertTriangle size={22} />
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        {requireText && (
          <label className="confirm-typed">
            <span>请输入 <code>{requireText}</code> 确认</span>
            <input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches && !busy) onConfirm();
              }}
              placeholder={requireText}
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={danger ? "modal-confirm danger" : "modal-confirm"}
            onClick={onConfirm}
            disabled={busy || !matches}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
