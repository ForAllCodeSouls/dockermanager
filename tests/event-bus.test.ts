import { describe, expect, it } from "vitest";
import { EventBus } from "../packages/server/src/event-bus";

describe("EventBus", () => {
  it("publishes monotonic sequence numbers", () => {
    const bus = new EventBus();
    const first = bus.publish("stack.upserted", { name: "web" });
    const second = bus.publish("stack.deleted", { name: "web" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("replays only events after the given sequence", () => {
    const bus = new EventBus();
    bus.publish("stack.upserted", { name: "a" });
    bus.publish("stack.status", { name: "a" });
    expect(bus.replayAfter(1).map((e) => e.type)).toEqual(["stack.status"]);
    expect(bus.replayAfter(2)).toEqual([]);
  });

  it("notifies subscribers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type));
    bus.publish("system.health", {});
    unsubscribe();
    bus.publish("system.health", {});
    expect(seen).toEqual(["system.health"]);
  });
});
