import type { StackAction, StackInfo } from "@dockermanager/shared";

interface Props {
  stacks: StackInfo[];
  activeName: string | null;
  selected: string[];
  search: string;
  busy: boolean;
  onSearch: (value: string) => void;
  onSelectStack: (name: string) => void;
  onToggleCheck: (name: string, checked: boolean) => void;
  onBatch: (action: StackAction) => void;
  onNewProject: () => void;
}

const batchActions: { action: StackAction; label: string }[] = [
  { action: "start", label: "启动" },
  { action: "stop", label: "停止" },
  { action: "restart", label: "重启" },
  { action: "update", label: "更新" },
];

export function Sidebar({
  stacks,
  activeName,
  selected,
  search,
  busy,
  onSearch,
  onSelectStack,
  onToggleCheck,
  onBatch,
  onNewProject,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-search">
          <input
            className="search"
            placeholder="搜索项目…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <div className="sidebar-label">
          <span>项目 · {stacks.length}</span>
          <button
            className="ghost"
            style={{ padding: "3px 9px", fontSize: 12 }}
            disabled={busy}
            onClick={onNewProject}
          >
            + 新建项目
          </button>
        </div>
      </div>

      <div className="stack-list">
        {stacks.length === 0 && (
          <p className="muted small" style={{ padding: "8px 6px" }}>
            暂无项目，点击“+ 新建项目”粘贴 docker run 命令创建。
          </p>
        )}
        {stacks.map((stack) => (
          <div
            key={stack.name}
            className={`stack-item ${activeName === stack.name ? "selected" : ""}`}
            onClick={() => onSelectStack(stack.name)}
          >
            <label className="stack-check" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selected.includes(stack.name)}
                onChange={(e) => onToggleCheck(stack.name, e.target.checked)}
              />
            </label>
            <span className={`status-dot ${stack.status}`} title={stack.status} />
            <span className="stack-name" title={stack.name}>{stack.name}</span>
            <span className="stack-meta">{stack.services.length}</span>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className="batch-panel">
          <div className="batch-title">
            <span>批量操作</span>
            <span>已选 {selected.length}</span>
          </div>
          <div className="batch-actions">
            {batchActions.map((item) => (
              <button
                key={item.action}
                className="ghost"
                disabled={busy || selected.length === 0}
                onClick={() => onBatch(item.action)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <p className="sidebar-tip">诊断、审计、镜像和日志都在顶部菜单里。</p>
      </div>
    </aside>
  );
}
