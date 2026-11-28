import { spawn } from "node:child_process";
import Docker from "dockerode";
import type {
  ContainerDetail,
  ContainerFileContent,
  ContainerFileEntry,
  ContainerFilesResponse,
} from "@dockermanager/shared";

const docker = new Docker();
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 容器 ID / 路径白名单，避免把用户输入拼进危险命令 */
export function safeId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id);
}

export function safePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  return !value.split("/").includes("..");
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function exec(id: string, args: string[], input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", id, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = (chunk: Buffer, current: string) =>
      current.length > MAX_FILE_BYTES * 2 ? current : current + chunk.toString("utf8");
    child.stdout?.on("data", (chunk: Buffer) => { stdout = cap(chunk, stdout); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = cap(chunk, stderr); });
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message, code: null }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr, code }));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export async function inspectContainer(id: string): Promise<ContainerDetail> {
  if (!safeId(id)) throw new Error("容器 ID 不合法");
  const detail = await docker.getContainer(id).inspect();
  const config = detail.Config ?? {};
  const state = detail.State ?? {};
  const networkSettings = detail.NetworkSettings ?? {};
  const env = (config.Env ?? []).map((line) => {
    const index = line.indexOf("=");
    if (index < 0) return line;
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    return /PASS|TOKEN|SECRET|KEY|CREDENTIAL|AUTH/i.test(key) ? `${key}=***` : line;
  });
  const health = state.Health?.Status ?? null;
  return {
    id: detail.Id?.slice(0, 12) ?? id,
    name: (detail.Name ?? "").replace(/^\//, ""),
    image: config.Image ?? "",
    state: state.Status ?? "unknown",
    status: state.Status ?? "unknown",
    createdAt: detail.Created ?? "",
    startedAt: state.StartedAt ?? "",
    command: [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])].join(" "),
    env,
    mounts: (detail.Mounts ?? []).map((mount) => ({
      type: mount.Type ?? "",
      source: mount.Source ?? "",
      destination: mount.Destination ?? "",
      mode: mount.Mode ?? "",
    })),
    ports: Object.entries(networkSettings.Ports ?? {}).flatMap(([privatePort, mappings]) =>
      (mappings?.length ? mappings : [{ HostIp: "", HostPort: null }]).map((item) => ({
        ip: item.HostIp ?? "",
        privatePort: Number(String(privatePort).split("/")[0]),
        publicPort: item.HostPort ? Number(item.HostPort) : null,
        type: String(privatePort).includes("/") ? String(privatePort).split("/")[1] : "tcp",
      })),
    ),
    networks: Object.keys(networkSettings.Networks ?? {}),
    labels: config.Labels ?? {},
    restartPolicy: detail.HostConfig?.RestartPolicy?.Name ?? "no",
    health,
    note: "环境变量中的密码、令牌、密钥已脱敏；修改容器文件不会自动重启容器。",
  };
}

/**
 * 解析 ls -la 的一行，同时兼容两种输出：
 * - GNU:  mode links owner group size 2026-11-28T09:04:57 name
 * - BusyBox: mode links owner group size Nov 28 09:04 name
 */
export function parseLsLine(line: string, dir: string): ContainerFileEntry | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) return null;
  const mode = parts[0];
  let nameIndex = 6;
  let modifiedAt = parts[5];
  if (/^[A-Za-z]{3}$/.test(parts[5]) && parts.length >= 9) {
    // BusyBox 把时间拆成「月 日 时:分」或「月 日 年」三段
    nameIndex = 8;
    modifiedAt = parts.slice(5, 8).join(" ");
  }
  const rawName = parts.slice(nameIndex).join(" ");
  if (!rawName || rawName === "." || rawName === "..") return null;
  // 链接行会带 " -> 目标"，只把链接名当作可点击进入的条目
  const name = rawName.split(" -> ")[0];
  const kind = mode.startsWith("d")
    ? "dir"
    : mode.startsWith("l")
      ? "link"
      : mode.startsWith("-")
        ? "file"
        : "other";
  return {
    name,
    path: dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`,
    type: kind,
    size: Number(parts[4]) || 0,
    modifiedAt,
    mode,
  };
}

export async function listContainerFiles(id: string, dir: string): Promise<ContainerFilesResponse> {
  if (!safeId(id) || !safePath(dir)) throw new Error("容器 ID 或路径不合法");
  // 优先用 GNU ls 的固定时间格式；Alpine/BusyBox 不支持 --time-style 时回退。
  let result = await exec(id, ["ls", "-la", "--time-style=+%Y-%m-%dT%H:%M:%S", "--", dir]);
  let compatible = false;
  if (!result.ok) {
    result = await exec(id, ["ls", "-la", dir]);
    compatible = true;
  }
  if (!result.ok) throw new Error(result.stderr.trim() || "读取目录失败");
  const entries: ContainerFileEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const entry = parseLsLine(line, dir);
    if (entry) entries.push(entry);
  }
  return {
    path: dir,
    entries,
    note: compatible
      ? "已用兼容模式读取目录，部分容器不显示精确修改时间。"
      : "点击目录进入，点击文件查看内容。二进制文件不能直接编辑。",
  };
}

export async function readContainerFile(id: string, filePath: string): Promise<ContainerFileContent> {
  if (!safeId(id) || !safePath(filePath)) throw new Error("容器 ID 或路径不合法");
  const result = await exec(id, ["cat", "--", filePath]);
  if (!result.ok) throw new Error(result.stderr.trim() || "读取文件失败");
  const truncated = result.stdout.length > MAX_FILE_BYTES;
  const content = truncated ? result.stdout.slice(0, MAX_FILE_BYTES) : result.stdout;
  return {
    path: filePath,
    content,
    truncated,
    note: truncated ? "文件过大，只显示前 2MB。" : "",
  };
}

export async function writeContainerFile(
  id: string,
  filePath: string,
  content: string,
): Promise<void> {
  if (!safeId(id) || !safePath(filePath)) throw new Error("容器 ID 或路径不合法");
  const result = await exec(id, ["tee", filePath], content);
  if (!result.ok) throw new Error(result.stderr.trim() || "写入文件失败");
}

export async function deleteContainerFile(id: string, filePath: string): Promise<void> {
  if (!safeId(id) || !safePath(filePath)) throw new Error("容器 ID 或路径不合法");
  const result = await exec(id, ["rm", "-f", "--", filePath]);
  if (!result.ok) throw new Error(result.stderr.trim() || "删除文件失败");
}
