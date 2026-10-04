// bb-plugin-council — frontend entry.
//
// One nav panel ("Council"): the list of councils, a transcript with stance
// badges, a convene composer with a turn budget, and a seat roster showing
// each seat's provider, stance, and chief marker.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  CouncilDetail,
  CouncilSummary,
  ContextOptions,
  rpcContract,
} from "./server";

type Contract = typeof rpcContract;

const PANEL_ID = "councils";
const PANEL_PATH = "councils";
const COUNCIL_CHANGED = "council-changed";

function stanceBadgeColor(stance: string): string {
  if (stance === "agree") return "#16a34a";
  if (stance === "disagree") return "#dc2626";
  if (stance === "need-info") return "#d97706";
  return "#6b7280";
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function stanceBadge(stance: string | null): string | null {
  if (stance === null) return null;
  const colors: Record<string, string> = {
    agree: "#16a34a",
    disagree: "#dc2626",
    "need-info": "#d97706",
    pass: "#6b7280",
  };
  const color = colors[stance] ?? "#6b7280";
  return `<span style="color:${color};font-weight:600">[${stance}]</span>`;
}

function useCouncils() {
  const rpc = useRpc<Contract>();
  const [councils, setCouncils] = useState<CouncilSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("councils_list").then(
      (result) => {
        setCouncils(result.councils);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(COUNCIL_CHANGED, refetch);
  return { councils, error, refetch };
}

function useCouncil(councilId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<CouncilDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (councilId === null) return;
    rpc.call("councils_get", { councilId }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, councilId]);
  useEffect(refetch, [refetch]);
  useRealtime(COUNCIL_CHANGED, refetch);
  return { detail, error, refetch };
}

const composerStyles: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  marginTop: 8,
};

const textareaStyles: React.CSSProperties = {
  flex: 1,
  minHeight: 64,
  resize: "vertical",
  fontFamily: "inherit",
  fontSize: 13,
};

const badgeStyles: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 999,
  fontSize: 11,
  border: "1px solid var(--bb-border, #8884)",
  margin: "2px 4px 2px 0",
};

function statusColor(status: string): string {
  if (status === "convened") return "#2563eb";
  if (status === "paused") return "#d97706";
  if (status === "verdict") return "#16a34a";
  return "#6b7280";
}

function CouncilList(props: {
  councils: CouncilSummary[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: "4px 0" }}>Councils</h3>
        <button onClick={props.onCreate}>New council…</button>
      </div>
      {props.councils.map((council) => (
        <div
          key={council.id}
          onClick={() => props.onOpen(council.id)}
          style={{ padding: "8px 6px", borderRadius: 8, cursor: "pointer", borderBottom: "1px solid var(--bb-border, #8882)" }}
        >
          <div style={{ fontWeight: 600 }}>
            {council.title}{" "}
            <span style={{ color: statusColor(council.status), fontSize: 12 }}>[{council.status}]</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {council.handles.map((h) => `@${h}`).join(", ")} · {council.messageCount} msgs
            {council.lastAuthor !== null ? ` · last: ${council.lastAuthor}` : ""}
          </div>
        </div>
      ))}
      {props.councils.length === 0 && <p style={{ opacity: 0.7 }}>No councils yet. Create one, then convene it with a question.</p>}
    </div>
  );
}

function CreateCouncilForm(props: { onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [seatsText, setSeatsText] = useState("claude=claude-code,codex=acp-codex");
  const [chief, setChief] = useState("claude");
  const [turns, setTurns] = useState(8);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("context_options").then(
      (result) => {
        setOptions(result);
        if (result.projects.length > 0) setProjectId((current) => current || result.projects[0].id);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);

  const submit = () => {
    const seats = seatsText
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [head, flag] = entry.split(":");
        const [handle, providerId, model] = head.split("=");
        return {
          handle: (handle ?? "").trim(),
          providerId: (providerId ?? "").trim(),
          ...(model ? { model: model.trim() } : {}),
          canEdit: flag === "edit",
        };
      });
    rpc
      .call("councils_create", {
        title,
        projectId,
        seats,
        chief: chief.trim() || seats[0]?.handle || "",
        defaultTurns: turns,
      })
      .then(props.onDone, (cause: unknown) => setError(describeError(cause)));
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: "4px 0" }}>New council</h3>
      {error !== null && <p style={{ color: "#dc2626" }}>{error}</p>}
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} style={{ width: "100%" }} />
      </label>
      <label>
        Project
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} style={{ width: "100%" }}>
          {(options?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Seats (handle=provider[=model][:edit], comma-separated)
        <input value={seatsText} onChange={(event) => setSeatsText(event.target.value)} style={{ width: "100%" }} />
      </label>
      {options !== null && (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Known providers: {options.providers.map((provider) => provider.id).join(", ") || "(none)"}
        </div>
      )}
      <label>
        Chief (writes the verdict)
        <input value={chief} onChange={(event) => setChief(event.target.value)} style={{ width: "100%" }} />
      </label>
      <label>
        Turn budget
        <input type="number" min={2} max={40} value={turns} onChange={(event) => setTurns(Number(event.target.value))} style={{ width: 90 }} />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={title === "" || projectId === ""}>
          Create
        </button>
      </div>
    </div>
  );
}

function CouncilRoom(props: { councilId: string; onBack: () => void }) {
  const rpc = useRpc<Contract>();
  const { detail, error, refetch } = useCouncil(props.councilId);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<number | "">("");
  const [actionError, setActionError] = useState<string | null>(null);

  const convene = () => {
    if (draft.trim() === "") return;
    rpc
      .call("councils_convene", {
        councilId: props.councilId,
        question: draft.trim(),
        ...(turns === "" ? {} : { turns }),
      })
      .then(
        () => {
          setDraft("");
          refetch();
        },
        (cause: unknown) => setActionError(describeError(cause)),
      );
  };

  const say = () => {
    if (draft.trim() === "") return;
    rpc.call("councils_say", { councilId: props.councilId, text: draft.trim() }).then(
      () => {
        setDraft("");
        refetch();
      },
      (cause: unknown) => setActionError(describeError(cause)),
    );
  };

  if (error !== null) return <p style={{ color: "#dc2626" }}>{error}</p>;
  if (detail === null) return <p>Loading…</p>;
  const { council, seats, messages, job } = detail;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: "4px 0" }}>
          {council.title}{" "}
          <span style={{ color: statusColor(council.status), fontSize: 12 }}>[{council.status}]</span>
        </h3>
        <button onClick={props.onBack}>All councils</button>
      </div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
        {seats.map((seat) => (
          <span key={seat.handle} style={badgeStyles}>
            {seat.isChief ? "★ " : ""}
            @{seat.handle} · {seat.providerId}
            {seat.lastStance !== null ? ` · ${seat.lastStance}` : ""}
            {seat.status !== null ? ` · ${seat.status}` : ""}
          </span>
        ))}
      </div>
      {job !== null && (
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          Debate: turn {job.turn}/{job.totalTurns}
          {job.current !== null ? ` · speaking: @${job.current}` : ""}
          {job.paused !== null ? ` · PAUSED — @${job.paused.handle} asks: ${job.paused.question}` : ""}
        </div>
      )}
      <div style={{ display: "grid", gap: 10, maxHeight: "55vh", overflowY: "auto" }}>
        {messages.map((message) => (
          <div key={message.seq} style={{ borderBottom: "1px solid var(--bb-border, #8882)", paddingBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 2 }}>
              #{message.seq} · {message.author === "user" ? "MODERATOR" : `@${message.author}`}
              {message.stance !== null && message.author !== "system" && (
                <span style={{ color: stanceBadgeColor(message.stance), fontWeight: 600, marginLeft: 8 }}>
                  [{message.stance}]
                </span>
              )}
            </div>
            <Markdown content={message.text} />
          </div>
        ))}
      </div>
      {actionError !== null && <p style={{ color: "#dc2626" }}>{actionError}</p>}
      <div style={composerStyles}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={council.status === "paused" ? "Answer the paused seat…" : "Convene with a question…"}
          style={textareaStyles}
        />
        <div style={{ display: "grid", gap: 6 }}>
          {council.status === "idle" && (
            <label style={{ fontSize: 12 }}>
              Turns
              <input
                type="number"
                min={2}
                max={40}
                value={turns}
                onChange={(event) => setTurns(event.target.value === "" ? "" : Number(event.target.value))}
                style={{ width: 70 }}
              />
            </label>
          )}
          {council.status === "idle" && <button onClick={convene}>Convene</button>}
          {(council.status === "paused" || council.status === "convened") && <button onClick={say}>Say</button>}
          {council.status === "paused" && (
            <button
              onClick={() =>
                rpc.call("councils_resume", { councilId: props.councilId }).then(refetch, (cause: unknown) => setActionError(describeError(cause)))
              }
            >
              Resume
            </button>
          )}
          {council.status === "convened" && (
            <button
              onClick={() =>
                rpc.call("councils_halt", { councilId: props.councilId }).then(refetch, (cause: unknown) => setActionError(describeError(cause)))
              }
            >
              Halt
            </button>
          )}
          {(council.status === "convened" || council.status === "paused") && (
            <button
              onClick={() =>
                rpc.call("councils_verdict", { councilId: props.councilId }).then(refetch, (cause: unknown) => setActionError(describeError(cause)))
              }
            >
              Verdict now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Council",
    icon: "Users",
    path: PANEL_PATH,
    component: () => {
      const { councils, error } = useCouncils();
      const [creating, setCreating] = useState(false);
      const [openId, setOpenId] = useState<string | null>(null);
      if (openId !== null) return <CouncilRoom councilId={openId} onBack={() => setOpenId(null)} />;
      if (creating) return <CreateCouncilForm onDone={() => setCreating(false)} />;
      if (error !== null) return <p style={{ color: "#dc2626" }}>{error}</p>;
      if (councils === null) return <p>Loading…</p>;
      return <CouncilList councils={councils} onOpen={setOpenId} onCreate={() => setCreating(true)} />;
    },
  });
});
