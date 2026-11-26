import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API, type ServerEvent } from "@dockermanager/shared";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveState {
  status: ConnectionStatus;
  lastEventAt: number | null;
  eventCount: number;
  reconnectCount: number;
  lastError: string | null;
}

const initial: LiveState = {
  status: "connecting",
  lastEventAt: null,
  eventCount: 0,
  reconnectCount: 0,
  lastError: null,
};

const eventTypes = [
  "stack.upserted",
  "stack.deleted",
  "stack.status",
  "audit.created",
  "system.health",
  "update.available",
  "update.applied",
  "update.failed",
];

export function useLiveConnection(enabled: boolean): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>(initial);
  const seenSeq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let source: EventSource | null = null;

    const resync = () => {
      void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    };
    const scheduleResync = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(resync, 120);
    };

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(API.events);
      source = es;

      es.onopen = () => {
        setState((s) => ({ ...s, status: "live", lastError: null }));
        // Every (re)connection pulls a full snapshot. Event replay is only a
        // latency optimisation, never the sole source of truth.
        resync();
      };

      const onEvent = (raw: MessageEvent<string>) => {
        try {
          const event = JSON.parse(raw.data) as ServerEvent;
          if (event.seq <= seenSeq.current) return;
          seenSeq.current = event.seq;
          setState((s) => ({ ...s, lastEventAt: Date.now(), eventCount: s.eventCount + 1 }));
          scheduleResync();
          if (event.type === "audit.created") {
            void queryClient.invalidateQueries({ queryKey: ["audit"] });
          }
          if (event.type.startsWith("update.")) {
            window.dispatchEvent(
              new CustomEvent("dockermanager:update", { detail: event }),
            );
          }
        } catch {
          // malformed events are ignored; resync on reconnect still recovers
        }
      };

      es.onmessage = onEvent;
      for (const type of eventTypes) es.addEventListener(type, onEvent);

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setState((s) => ({
          ...s,
          status: document.hidden ? "offline" : "reconnecting",
          reconnectCount: s.reconnectCount + 1,
          lastError: new Date().toISOString(),
        }));
        reconnectTimer = setTimeout(connect, 2500);
      };
    };

    connect();

    const onVisibility = () => {
      if (document.hidden) return;
      resync();
      if (source?.readyState === EventSource.CLOSED) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        connect();
      }
    };
    const onOnline = () => {
      resync();
      if (source?.readyState === EventSource.CLOSED) connect();
    };
    const onOffline = () => setState((s) => ({ ...s, status: "offline" }));

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [enabled, queryClient]);

  return state;
}
