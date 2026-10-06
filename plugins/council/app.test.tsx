// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createCouncilInputSchema } from "./lib/council-input";

const options = {
  projects: [{ id: "project", name: "Test project", kind: "standard" }],
  providers: [
    { id: "acp-omp", displayName: "OMP", available: true, reasoningLevels: [], models: [
      { model: "webster/glm-5.3-flash", displayName: "GLM 5.3 Flash", isDefault: true },
      { model: "webster/deepseek-v4-flash", displayName: "DeepSeek v4 Flash", isDefault: false },
    ] },
    { id: "codex", displayName: "Codex", available: true, reasoningLevels: ["high"], models: [] },
    { id: "claude-code", displayName: "Claude Code", available: true, reasoningLevels: ["high"], models: [] },
  ],
};

async function setup(contextOptions = options, createOverride?: (input: unknown) => unknown) {
  const app = await loadPluginApp(() => import("./app"));
  const create = vi.fn(createOverride ?? ((input: unknown) => {
    const parsed = createCouncilInputSchema.parse(input);
    return { council: { ...parsed, id: "created" } };
  }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "new" }, {
    rpc: { councils_list: () => ({ councils: [] }), context_options: () => contextOptions, councils_create: create },
  });
  await slot.findByLabelText("Title");
  fireEvent.change(slot.getByLabelText("Title"), { target: { value: "Design review" } });
  const submit = () => {
    const event = new Event("submit", { bubbles: true, cancelable: true });
    fireEvent(slot.getByRole("button", { name: "Create council" }).closest("form")!, event);
    expect(event.defaultPrevented).toBe(true);
  };
  return { slot, create, submit };
}
afterEach(cleanup);

describe("council creation", () => {
  it("submits the four requested combinations with GLM as chief and prevents navigation", async () => {
    const { slot, create, submit } = await setup();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      chief: "glm", defaultTurns: 8,
      seats: [
        { handle: "glm", providerId: "acp-omp", model: "webster/glm-5.3-flash", canEdit: true },
        { handle: "codex", providerId: "codex", canEdit: false },
        { handle: "claude", providerId: "claude-code", canEdit: false },
        { handle: "dsv4", providerId: "acp-omp", model: "webster/deepseek-v4-flash", canEdit: true },
      ],
    });
    await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  });

  it.each(["chief claude", "glm"])("reports invalid or duplicate handle %s without calling RPC", async (handle) => {
    const { slot, create, submit } = await setup();
    fireEvent.change(slot.getAllByLabelText("Handle")[2], { target: { value: handle } });
    submit();
    expect((await slot.findByRole("alert")).textContent).toContain("Seat 3 handle:");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the selected chief when its handle changes", async () => {
    const { slot, create, submit } = await setup();
    fireEvent.change(slot.getAllByLabelText("Handle")[0], { target: { value: "chair" } });
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ chief: "chair" });
  });

  it("selects a remaining chief when the chief is removed", async () => {
    const { slot, create, submit } = await setup();
    fireEvent.click(slot.getAllByLabelText("Remove seat")[0]);
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ chief: "codex" });
  });

  it("shows RPC validation details instead of only the generic error", async () => {
    const { slot, submit } = await setup(options, () => {
      throw Object.assign(new Error("rpc input validation failed"), {
        issues: [{ path: ["seats", 3, "model"], message: "Choose an available model." }],
      });
    });
    submit();
    expect((await slot.findByRole("alert")).textContent).toBe("Seat 4 model: Choose an available model.");
  });

  it("preserves the explicit OMP models if catalog loading fails", async () => {
    const context = structuredClone(options);
    context.providers[0].models = [];
    const { create, submit } = await setup(context);
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ seats: [
      { model: "webster/glm-5.3-flash" }, {}, {}, { model: "webster/deepseek-v4-flash" },
    ] });
  });

  it("rejects an unavailable preset model with a seat-specific error", async () => {
    const context = structuredClone(options);
    context.providers[0].models.pop();
    const { slot, create, submit } = await setup(context);
    submit();
    expect((await slot.findByRole("alert")).textContent).toContain("Seat @dsv4:");
    expect(create).not.toHaveBeenCalled();
  });
});
