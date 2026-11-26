import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { API } from "@dockermanager/shared";
import { getCurrentHost } from "../api";

interface Props {
  stack: string;
  service: string;
  host?: string;
}

interface TerminalFrame {
  type: "opened" | "data" | "error" | "closed";
  data?: string;
}

export function TerminalView({ stack, service, host }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const hostId = host ?? getCurrentHost();

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Xterm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0b1020", foreground: "#d7e0ef" },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    term.focus();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({
      host: hostId,
      stack,
      service,
    });
    const socket = new WebSocket(`${protocol}//${location.host}${API.terminal}?${query}`);
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as TerminalFrame;
        if (frame.type === "data" && frame.data) term.write(frame.data);
        if (frame.type === "opened" && frame.data) term.write(`\r\n[${frame.data}]\r\n`);
        if (frame.type === "error" || frame.type === "closed") {
          term.write(`\r\n[${frame.type}] ${frame.data ?? ""}\r\n`);
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => term.write("\r\n[连接已关闭]\r\n");

    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    const resize = () => fit.fit();
    window.addEventListener("resize", resize);

    return () => {
      input.dispose();
      window.removeEventListener("resize", resize);
      socket.close();
      term.dispose();
    };
  }, [stack, service, hostId]);

  return <div className="terminal-host" ref={hostRef} />;
}
