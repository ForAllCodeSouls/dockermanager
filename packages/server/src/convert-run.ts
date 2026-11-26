import type { ConvertRunResponse } from "@dockermanager/shared";

/**
 * 将 docker run 命令解析为 compose.yaml。
 * 支持常见参数：-p/-v/-e/--name/--network/--restart/--hostname/--user/-w/--entrypoint
 * 以及 --privileged、--cap-add、--device、--dns、--link、--label。
 * 解析采用词法扫描，正确处理引号包裹的空格。
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of input.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function yamlQuote(value: string): string {
  // 保守起见：含冒号、空格、= 等特殊字符一律加引号，避免 YAML 把
  // 8080:80 当 sexagesimal、把 TZ=xxx 等误解析。
  if (/^[a-zA-Z0-9_./-]+$/.test(value) && !/^(true|false|null|yes|no|on|off|[0-9]+)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/** 镜像引用含 tag（nginx:alpine）是 compose 标准写法，保留原样 */
function imageRef(value: string): string {
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function yamlBlockList(key: string, values: string[]): string {
  if (values.length === 0) return "";
  return `    ${key}:\n${values.map((v) => `      - ${yamlQuote(v)}`).join("\n")}\n`;
}

export function convertRunCommand(input: string): ConvertRunResponse {
  const warnings: string[] = [];
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch {
    return { compose: "", warnings: ["命令解析失败"] };
  }
  if (tokens[0] !== "docker" || tokens[1] !== "run") {
    return { compose: "", warnings: ["请输入以 'docker run' 开头的命令"] };
  }

  let image = "";
  let name = "";
  let restart = "";
  let network = "";
  let hostname = "";
  let user = "";
  let workdir = "";
  let entrypoint = "";
  let privileged = false;
  const ports: string[] = [];
  const volumes: string[] = [];
  const env: string[] = [];
  const labels: string[] = [];
  const devices: string[] = [];
  const dns: string[] = [];
  const caps: string[] = [];
  const command: string[] = [];

  const repeatableValue = (i: number): string | null => tokens[i + 1] ?? null;

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    const consume = (): string => {
      const value = tokens[i + 1] ?? "";
      i += 1;
      return value;
    };

    // docker run 的选项都在镜像名之前；镜像之后的内容是容器启动命令
    if (image) {
      command.push(token);
      continue;
    }

    switch (token) {
      case "-d":
      case "--detach":
      case "-it":
      case "-i":
      case "-t":
      case "--rm":
      case "--init":
        break;
      case "--name":
        name = consume();
        break;
      case "-p":
      case "--publish": {
        const value = consume();
        if (value) ports.push(value);
        break;
      }
      case "-v":
      case "--volume": {
        const value = consume();
        if (value) volumes.push(value);
        break;
      }
      case "-e":
      case "--env": {
        const value = consume();
        if (value) env.push(value);
        break;
      }
      case "--env-file":
        warnings.push("检测到 --env-file，请将文件内容手动写入 .env");
        consume();
        break;
      case "-l":
      case "--label": {
        const value = consume();
        if (value) labels.push(value);
        break;
      }
      case "--network":
        network = consume();
        break;
      case "--restart":
        restart = consume();
        break;
      case "--hostname":
        hostname = consume();
        break;
      case "-u":
      case "--user":
        user = consume();
        break;
      case "-w":
      case "--workdir":
        workdir = consume();
        break;
      case "--entrypoint":
        entrypoint = consume();
        break;
      case "--privileged":
        privileged = true;
        break;
      case "--cap-add": {
        const value = consume();
        if (value) caps.push(value);
        break;
      }
      case "--device": {
        const value = consume();
        if (value) devices.push(value);
        break;
      }
      case "--dns": {
        const value = consume();
        if (value) dns.push(value);
        break;
      }
      case "-P":
      case "--publish-all":
        warnings.push("检测到 --publish-all，请手动确认端口映射");
        break;
      case "--mount":
        warnings.push("检测到 --mount，请手动转换为 volume 语法");
        consume();
        break;
      default:
        if (token.startsWith("-")) {
          warnings.push(`未识别的参数 ${token}，请手动确认`);
          if (repeatableValue(i) && !tokens[i + 1]?.startsWith("-")) i += 1;
        } else {
          image = token;
        }
    }
  }

  if (!image) {
    return { compose: "", warnings: ["未识别到镜像名称，请检查命令"] };
  }

  const safeName = name || image.split("/").pop()?.split(":")[0] || "app";
  const serviceName = safeName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "app";
  const lines: string[] = ["services:", `  ${serviceName}:`];
  lines.push(`    image: ${imageRef(image)}`);
  if (name) lines.push(`    container_name: ${yamlQuote(name)}`);
  if (restart) lines.push(`    restart: ${yamlQuote(restart)}`);
  if (network) lines.push(`    networks:\n      - ${yamlQuote(network)}`);
  if (hostname) lines.push(`    hostname: ${yamlQuote(hostname)}`);
  if (user) lines.push(`    user: ${yamlQuote(user)}`);
  if (workdir) lines.push(`    working_dir: ${yamlQuote(workdir)}`);
  if (entrypoint) lines.push(`    entrypoint: ${yamlQuote(entrypoint)}`);
  if (privileged) lines.push("    privileged: true");

  const block = (key: string, values: string[]) => {
    const text = yamlBlockList(key, values);
    if (text) lines.push(text.replace(/\n$/, ""));
  };
  block("ports", ports);
  block("volumes", volumes);
  block("environment", env);
  block("labels", labels);
  block("devices", devices);
  block("dns", dns);
  block("cap_add", caps);

  if (command.length > 0) {
    lines.push(`    command: ${command.map(yamlQuote).join(" ")}`);
  }

  return { compose: `${lines.join("\n")}\n`, warnings };
}
