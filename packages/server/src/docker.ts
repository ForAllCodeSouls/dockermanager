import Docker from "dockerode";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ContainerInfo, EngineInfo } from "@dockermanager/shared";
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

/**
 * 用 docker compose config 校验未保存的编辑内容。
 * 临时文件写在栈目录内，保证相对路径与 --env-file 解析位置和真实部署一致；
 * 校验过程只运行 config，不创建、不启动任何容器。
 */
export function validateCompose(
  name: string,
  compose: string,
  env: string,
): Promise<CommandResult> {
  const dir = path.join(config.stacksDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomUUID();
  const composeFile = path.join(dir, `.dockermanager-validate-${suffix}.yaml`);
  const envFile = path.join(dir, `.dockermanager-validate-${suffix}.env`);
  fs.writeFileSync(composeFile, compose, "utf8");
  fs.writeFileSync(envFile, env, "utf8");

  const cleanup = () => {
    for (const file of [composeFile, envFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 已被清理
      }
    }
  };

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "-p",
        name,
        "config",
        "-q",
      ],
      {
        cwd: dir,
        env: { ...process.env, COMPOSE_INTERACTIVE_NO_CLI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        output: output.trim() || (code === 0 ? "配置有效" : `exit code ${code}`),
      }),
    );
  }).finally(cleanup);
}
