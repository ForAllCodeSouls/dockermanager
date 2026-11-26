import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API } from "@dockermanager/shared";
import { post } from "../api";

interface Props {
  mode: "login" | "setup";
}

export function AuthScreen({ mode }: Props) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(mode === "setup" ? API.setup : API.login, { password, token });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">SD</div>
        <h1>DockerManager</h1>
        <p className="muted">
          {mode === "setup" ? "首次使用，请设置管理密码" : "输入管理密码以继续"}
        </p>
        <label>
          管理密码
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "setup" ? "至少 8 个字符" : "密码"}
            required
            minLength={mode === "setup" ? 8 : 1}
          />
        </label>
        {mode === "setup" && (
          <label>
            设置令牌（若已配置 SETUP_TOKEN）
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="可选"
            />
          </label>
        )}
        {error && <div className="inline-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "请稍候…" : mode === "setup" ? "设置密码并进入" : "登录"}
        </button>
        <p className="hint">会话保存在 HttpOnly Cookie 中，前端不持有长期凭证。</p>
      </form>
    </div>
  );
}
