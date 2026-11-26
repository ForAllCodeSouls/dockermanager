import Docker from "dockerode";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ContainerInfo, EngineInfo } from "@stackdeck/shared";
import { config } from "./config.js";

const docker = new Docker();

export async function engineInfo(): Promise<EngineInfo> {
  try {
    const info = await docker.version();
    return { reachable: true, version: info.Version ?? "unknown", message: null };
  } catch (error) {
    return {
      reachable: false,
      version: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function containersForProject(name: string): Promise<ContainerInfo[]> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${name}`] },
    });
    return containers.map((item) => ({
      id: item.Id.slice(0, 12),
      name: item.Names[0]?.replace(/^\//, "") ?? item.Id.slice(0, 12),
      image: item.Image,
      state: item.State,
      status: item.Status,
      ports: item.Ports.map((p) =>
        p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`,
      ).join(", "),
    }));
  } catch {
    return [];
  }
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

export function composeFileFor(name: string): string | null {
  const dir = path.join(config.stacksDir, name);
  for (const file of config.composeFileNames) {
    const candidate = path.join(dir, file);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // missing
    }
  }
  return null;
}

export function runCompose(name: string, args: string[]): Promise<CommandResult> {
  const composeFile = composeFileFor(name);
  if (!composeFile) {
    return Promise.resolve({ ok: false, output: "未找到 compose 文件" });
  }
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", "-f", composeFile, "-p", name, ...args], {
      cwd: path.dirname(composeFile),
      env: { ...process.env, COMPOSE_INTERACTIVE_NO_CLI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, output: output.trim() || `exit code ${code}` }),
    );
  });
}
