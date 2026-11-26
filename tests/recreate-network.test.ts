import { describe, expect, it } from "vitest";
import { recreatableEndpoints } from "../packages/server/src/recreate.js";

// 模拟 docker inspect 返回的 NetworkSettings.Networks：
// 里面混着大量 Docker 运行后才写入的只读派生字段。若把这些字段原样回填到
// EndpointsConfig，createContainer 会失败，自更新删掉旧容器后就再起不来（502）。
const endpoint = {
  IPAMConfig: undefined,
  Links: undefined,
  Aliases: ["dockermanager", "dockermanager-alias"],
  NetworkID: "k8x2abcnetid000000000000000000000000000000000000000000000000",
  EndpointID: "a1b2c3endpointid000000000000000000000000000000000000000000000",
  Gateway: "172.20.0.1",
  IPAddress: "172.20.0.5",
  IPPrefixLen: 16,
  IPv6Gateway: "",
  GlobalIPv6Address: "",
  GlobalIPv6PrefixLen: 0,
  MacAddress: "02:42:ac:14:00:05",
};

describe("recreatableEndpoints", () => {
  it("只保留 create 可写的字段，剔除 IPAddress/Gateway/EndpointID/MacAddress 等派生字段", () => {
    const result = recreatableEndpoints({ "project_default": endpoint });
    expect(result).toBeDefined();
    const clean = result!["project_default"];
    expect(clean.Aliases).toEqual(["dockermanager", "dockermanager-alias"]);
    expect("IPAddress" in clean).toBe(false);
    expect("IPPrefixLen" in clean).toBe(false);
    expect("Gateway" in clean).toBe(false);
    expect("EndpointID" in clean).toBe(false);
    expect("NetworkID" in clean).toBe(false);
    expect("MacAddress" in clean).toBe(false);
  });

  it("空网络输入返回 undefined", () => {
    expect(recreatableEndpoints({})).toBeUndefined();
    expect(recreatableEndpoints(undefined as never)).toBeUndefined();
  });

  it("多网络时逐个清洗", () => {
    const result = recreatableEndpoints({
      frontend: endpoint,
      backend: { ...endpoint, Aliases: ["backend"], IPAddress: "10.0.0.9" },
    });
    expect(Object.keys(result!)).toEqual(["frontend", "backend"]);
    expect(result!.backend.Aliases).toEqual(["backend"]);
    expect("IPAddress" in result!.backend).toBe(false);
  });
});
