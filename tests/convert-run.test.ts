import { describe, expect, it } from "vitest";
import { convertRunCommand } from "../packages/server/src/convert-run.js";

describe("convertRunCommand", () => {
  it("converts a typical docker run command", () => {
    const result = convertRunCommand(
      'docker run -d --name web -p 8080:80 -e TZ=Asia/Shanghai -v /data:/data nginx:alpine',
    );
    expect(result.warnings).toEqual([]);
    expect(result.compose).toContain("services:");
    expect(result.compose).toContain("image: nginx:alpine");
    expect(result.compose).toContain("container_name: web");
    expect(result.compose).toContain('- "8080:80"');
    expect(result.compose).toContain('- "TZ=Asia/Shanghai"');
    expect(result.compose).toContain('- "/data:/data"');
  });

  it("handles quoted command arguments", () => {
    const result = convertRunCommand('docker run --name app alpine sh -c "echo hello world"');
    expect(result.compose).toContain("command: sh -c");
    expect(result.compose).toContain("hello world");
  });

  it("collects unsupported flags as warnings", () => {
    const result = convertRunCommand("docker run --rm --env-file .env nginx:alpine");
    expect(result.warnings.some((w) => w.includes("env-file"))).toBe(true);
  });

  it("rejects non-docker-run input", () => {
    const result = convertRunCommand("docker ps -a");
    expect(result.compose).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("converts restart, network and privileged", () => {
    const result = convertRunCommand(
      "docker run -d --restart unless-stopped --network host --privileged nginx:alpine",
    );
    expect(result.compose).toContain("restart: unless-stopped");
    expect(result.compose).toContain("networks:");
    expect(result.compose).toContain("privileged: true");
  });
});
