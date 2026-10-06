import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
async function setup() {
  const host = createFakePluginHost({ pluginId: "council" });
  hosts.push(host);
  host.harness.inspection.sdk.stub("providers.list", async () => [
    { id: "acp-omp", available: true }, { id: "codex", available: true },
  ]);
  await plugin(host.bb);
  return host.harness.behavior;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const input = {
  title: "Review", projectId: "project", chief: "glm", defaultTurns: 8,
  seats: [
    { handle: "glm", providerId: "acp-omp", model: "webster/glm-5.3-flash" },
    { handle: "codex", providerId: "codex" },
  ],
};

describe("create contract and persistence", () => {
  it("accepts an OMP chief through the real RPC contract and persists it", async () => {
    const rpc = await setup();
    const created = await rpc.callRpc("councils_create", input) as { council: { id: string } };
    const detail = await rpc.callRpc("councils_get", { councilId: created.council.id });
    expect(detail).toMatchObject({
      council: { chief: "glm" },
      seats: [
        { handle: "glm", providerId: "acp-omp", model: "webster/glm-5.3-flash", isChief: true },
        { handle: "codex", isChief: false },
      ],
    });
  });

  it("rejects duplicate handles before leaving a partial council", async () => {
    const rpc = await setup();
    await expect(rpc.callRpc("councils_create", { ...input, seats: [input.seats[0], input.seats[0]] }))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ path: ["seats", 1, "handle"] })] });
    expect(await rpc.callRpc("councils_list", null)).toEqual({ councils: [] });
  });

  it("enforces duplicate and seat-count validation on the CLI as well", async () => {
    const rpc = await setup();
    for (const seats of ["glm=acp-omp,glm=codex", "glm=acp-omp"]) {
      const result = await rpc.runCli(["create", "--title", "Review", "--project", "project", "--seats", seats]);
      expect(result.exitCode).not.toBe(0);
    }
    expect(await rpc.callRpc("councils_list", null)).toEqual({ councils: [] });
  });

  it.each([
    { chief: "removed" },
    { defaultTurns: 2.5 },
    { title: "x".repeat(121) },
  ])("rejects invalid fields with structured details: %j", async (patch) => {
    const rpc = await setup();
    await expect(rpc.callRpc("councils_create", { ...input, ...patch }))
      .rejects.toMatchObject({ issues: expect.any(Array) });
    expect(await rpc.callRpc("councils_list", null)).toEqual({ councils: [] });
  });
});

async function setupLaunch({ unavailable = "", failSeat = "" } = {}) {
  const host = createFakePluginHost({ pluginId: "council" });
  hosts.push(host);
  const sdk = host.harness.inspection.sdk;
  sdk.stub("environments.get", async () => ({ id: "workspace", projectId: "project", status: "ready" }));
  sdk.stub("providers.list", async () => ["acp-omp", "codex", "claude-code"].map((id) => ({ id, available: id !== unavailable })));
  sdk.stub("providers.models", async ({ providerId }) => ({ models: providerId === "acp-omp" ? [
    { model: "webster/glm-5.3-flash", isDefault: true },
    { model: "webster/deepseek-v4-flash", isDefault: false },
  ] : [{ model: `${providerId}-default`, isDefault: true }] }));
  let sequence = 0;
  sdk.stub("threads.spawn", async (args) => {
    if (args.title?.endsWith(`@${failSeat}`)) throw new Error("provider disconnected");
    return { id: `seat-${++sequence}`, environmentId: "workspace" };
  });
  await plugin(host.bb);
  return { rpc: host.harness.behavior, sdk };
}

const launchInput = {
  projectId: "project", environmentId: "workspace", question: "Which design should we choose?\nConsider the existing code.",
};

describe("four-seat launcher", () => {
  it("starts exactly four seats in the caller's workspace with the intended models and chief", async () => {
    const { rpc, sdk } = await setupLaunch();
    const result = await rpc.callRpc("councils_launch", launchInput) as { council: { id: string } };
    expect(result).toMatchObject({ council: { chief: "glm", environmentId: "workspace", status: "convened", defaultTurns: 8 }, failures: [] });
    const detail = await rpc.callRpc("councils_get", { councilId: result.council.id });
    expect(detail).toMatchObject({ seats: [
      { handle: "glm", model: "webster/glm-5.3-flash", isChief: true },
      { handle: "codex", model: "codex-default", isChief: false },
      { handle: "claude", model: "claude-code-default", isChief: false },
      { handle: "dsv4", model: "webster/deepseek-v4-flash", isChief: false },
    ] });
    const spawns = sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(4);
    for (const call of spawns) {
      expect(call[0]).toMatchObject({ environment: { type: "reuse", environmentId: "workspace" }, projectId: "project" });
      expect((call[0] as { prompt: string }).prompt).toContain(launchInput.question);
      expect((call[0] as { prompt: string }).prompt).toContain("council-seat skill");
      expect((call[0] as { prompt: string }).prompt).toContain("Do not invoke /council");
    }
  });

  it("fails before creating anything if a required provider is unavailable", async () => {
    const { rpc, sdk } = await setupLaunch({ unavailable: "claude-code" });
    await expect(rpc.callRpc("councils_launch", launchInput)).rejects.toThrow("requires claude-code");
    expect(await rpc.callRpc("councils_list", null)).toEqual({ councils: [] });
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("does not substitute a missing preset model", async () => {
    const { rpc, sdk } = await setupLaunch();
    sdk.stub("providers.models", async () => ({ models: [{ model: "other-default", isDefault: true }] }));
    await expect(rpc.callRpc("councils_launch", launchInput)).rejects.toThrow("webster/glm-5.3-flash is unavailable");
    expect(await rpc.callRpc("councils_list", null)).toEqual({ councils: [] });
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("rejects a workspace from a different project", async () => {
    const { rpc, sdk } = await setupLaunch();
    await expect(rpc.callRpc("councils_launch", { ...launchInput, projectId: "wrong-project" })).rejects.toThrow("does not belong");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("reports partial launch failures without pretending all seats started", async () => {
    const { rpc, sdk } = await setupLaunch({ failSeat: "claude" });
    expect(await rpc.callRpc("councils_launch", launchInput)).toMatchObject({
      failures: [{ handle: "claude", error: "provider disconnected" }],
    });
    expect(sdk.callsTo("threads.spawn")).toHaveLength(4);
  });
});
