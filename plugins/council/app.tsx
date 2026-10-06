// bb-plugin-council — frontend entry.
//
// One nav panel ("Council"): a two-column page with the council list on the
// left and the debate room on the right. The room shows the seat roster as
// chips with live status, the transcript with stance badges, a job banner for
// the running debate, and a composer with a turn budget. Create and settings
// are inline forms. Styling is host Tailwind tokens only, matching the bb app.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { definePluginApp, Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CouncilDetail,
  CouncilSummary,
  ContextOptions,
  Job,
  Seat,
  SeatInput,
  Stance,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_SEATS, DEFAULT_CHIEF, DEFAULT_TURNS } from "./lib/default-roster";
import { createCouncilInputSchema, describeInputIssues, MAX_TURNS, REASONING_LEVELS } from "./lib/council-input";

type Contract = typeof rpcContract;

const PANEL_ID = "councils";
const PANEL_PATH = "councils";
const COUNCIL_CHANGED = "council-changed";

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  // BB preserves validation details on the thrown RPC error. Do not hide
  // them behind its generic "rpc input validation failed" message.
  if (cause instanceof Error && "issues" in cause && Array.isArray(cause.issues)) {
    const issues = cause.issues.filter((issue): issue is { path?: (string | number)[]; message: string } =>
      typeof issue === "object" && issue !== null && typeof issue.message === "string" &&
      (issue.path === undefined || (Array.isArray(issue.path) && issue.path.every((part: unknown) => typeof part === "string" || typeof part === "number"))));
    if (issues.length > 0) return describeInputIssues({ issues });
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function councilIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { councilId?: unknown }).councilId;
  return typeof id === "string" ? id : null;
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
  return { councils, error };
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
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime(COUNCIL_CHANGED, (payload) => {
    const changed = councilIdOf(payload);
    if (changed === null || changed === councilId) refetch();
  });
  // Seat status flips inside seat threads are not all published; poll slowly
  // while anything is running so the busy dots stay honest.
  const busy =
    detail?.seats.some((s) => s.status === "working") ||
    (detail?.job !== null && detail?.job !== undefined);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  return { rpc, detail, error, refetch };
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function isWorking(seat: Seat): boolean {
  return seat.status === "working";
}

function StatusDot({ seat }: { seat: Seat }) {
  if (isWorking(seat)) return <Icon name="Loading" className="size-3 shrink-0 animate-spin text-primary" aria-label="Working" />;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", seat.lastStance === null ? "bg-muted-foreground/40" : "bg-muted-foreground/70")}
    />
  );
}

const STANCE_STYLE: Record<Stance, string> = {
  agree: "border-foreground/30 text-foreground",
  disagree: "border-destructive/50 text-destructive",
  "need-info": "border-foreground/40 bg-foreground/10 text-foreground",
  pass: "border-border text-muted-foreground",
};
const STANCE_ICON: Record<Stance, "Check" | "CircleX" | "CircleQuestion" | "ArrowRight"> = {
  agree: "Check",
  disagree: "CircleX",
  "need-info": "CircleQuestion",
  pass: "ArrowRight",
};

function StanceBadge({ stance, small }: { stance: Stance; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]",
        STANCE_STYLE[stance],
      )}
      title={`Stance: ${stance}`}
    >
      <Icon name={STANCE_ICON[stance]} className={small ? "size-2.5" : "size-3"} />
      {stance}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  idle: "text-muted-foreground",
  convened: "text-primary",
  paused: "text-destructive",
  verdict: "text-foreground",
};

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Re-renders once a second while `enabled`, for elapsed timers. */
function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function WorkingRow({ seat, now }: { seat: Seat; now: number }) {
  void now;
  return (
    <li className="flex flex-col gap-1 py-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Icon name="Loading" className="size-3.5 animate-spin text-primary" />
        <span className="font-medium text-foreground">@{seat.handle}</span>
        <span className="text-muted-foreground">{seat.providerId}</span>
        <span className="text-muted-foreground">is thinking…</span>
      </div>
    </li>
  );
}

function MessageRow({ message, providerOf }: { message: CouncilDetail["messages"][number]; providerOf: (handle: string) => string | null }) {
  const isUser = message.author === "user";
  if (message.author === "system") {
    return <li className="py-1.5 text-center text-xs text-muted-foreground">{message.text}</li>;
  }
  const provider = providerOf(message.author);
  return (
    <li className={cn("flex flex-col gap-1 py-3", isUser && "items-end")} id={`msg-${message.seq}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground">{isUser ? "you" : `@${message.author}`}</span>
        {provider ? <span className="text-muted-foreground">{provider}</span> : null}
        {message.stance ? <StanceBadge stance={message.stance} /> : null}
        <span className="text-muted-foreground">
          #{message.seq} · {timeLabel(message.createdAt)}
        </span>
      </div>
      <div className={cn("max-w-[85%] rounded-lg border border-border px-3.5 py-2.5 text-sm", isUser ? "bg-foreground/5" : "bg-card")}>
        <Markdown content={message.text} />
        {message.openPoints.length > 0 ? (
          <div className="mt-2 border-t border-border pt-2 text-xs">
            <span className="font-medium text-muted-foreground">Open</span>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {message.openPoints.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function JobBanner({ job, onResume, onVerdict, disabled }: { job: NonNullable<Job>; onResume: () => void; onVerdict: () => void; disabled: boolean }) {
  const roster = job.current !== null ? `@${job.current} is responding` : "";
  const text = job.paused
    ? `Paused. @${job.paused.handle} needs input: ${job.paused.question}`
    : `Debate · turn ${job.turn}/${job.totalTurns}${roster ? ` · ${roster}` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-2 text-xs">
      {job.paused ? (
        <Icon name="Pause" className="size-3.5 text-muted-foreground" />
      ) : (
        <Icon name="Loading" className="size-3.5 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {job.paused ? (
        <Button variant="outline" size="sm" onClick={onResume} disabled={disabled}>
          <Icon name="Play" className="size-3.5" />
          Resume
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onVerdict} disabled={disabled}>
        <Icon name="Square" className="size-3.5" />
        Verdict now
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seat chip
// ---------------------------------------------------------------------------

function SeatChip({ seat, isChief, onOpenThread }: { seat: Seat; isChief: boolean; onOpenThread: () => void }) {
  return (
    <span className="relative inline-flex items-stretch overflow-visible rounded-full border border-border text-xs">
      <span
        className="inline-flex items-center gap-1.5 rounded-l-full px-2.5 py-1"
        title={`${seat.providerId}${seat.model ? ` · ${seat.model}` : ""}${seat.reasoningLevel ? ` · ${seat.reasoningLevel}` : ""}${seat.canEdit ? " · may edit" : ""}`}
      >
        <StatusDot seat={seat} />
        <span className="font-medium">@{seat.handle}</span>
        <span className="text-muted-foreground">{seat.providerId}</span>
        {isChief ? <Icon name="Star" className="size-3 text-muted-foreground" aria-label="Chief" /> : null}
        {seat.canEdit ? <Icon name="Edit" className="size-3 text-muted-foreground" aria-label="May edit files" /> : null}
        {seat.lastStance ? <StanceBadge stance={seat.lastStance} small /> : null}
      </span>
      <button
        type="button"
        onClick={onOpenThread}
        disabled={seat.threadId === null}
        title={seat.threadId === null ? "No thread yet" : "Open the seat's thread in bb"}
        aria-label={`Open @${seat.handle} thread`}
        className="inline-flex items-center rounded-r-full border-l border-border px-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
      >
        <Icon name="PanelRight" className="size-3.5" />
      </button>
    </span>
  );
}

type ReasoningLevel = NonNullable<SeatInput["reasoningLevel"]> & string;

interface SeatDraft {
  handle: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | "";
  canEdit: boolean;
}

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function toSeatInput(seat: SeatDraft) {
  return {
    handle: seat.handle.trim().toLowerCase(),
    providerId: seat.providerId,
    ...(seat.model ? { model: seat.model } : {}),
    ...(seat.reasoningLevel ? { reasoningLevel: seat.reasoningLevel } : {}),
    canEdit: seat.canEdit,
  };
}

function defaultSeats(options: ContextOptions): SeatDraft[] {
  const available = options.providers.filter((p) => p.available);
  const seats: SeatDraft[] = DEFAULT_SEATS
    .filter((seat) => available.some((provider) => provider.id === seat.providerId))
    .map((seat) => ({ ...seat, reasoningLevel: "" }));
  if (seats.length === 0 && available[0]) seats.push({
    handle: "agent", providerId: available[0].id, model: "", reasoningLevel: "", canEdit: false,
  });
  return seats;
}

function SeatEditor({ seat, options, onChange, onRemove }: { seat: SeatDraft; options: ContextOptions; onChange: (patch: Partial<SeatDraft>) => void; onRemove?: () => void }) {
  const provider = options.providers.find((p) => p.id === seat.providerId);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <span className="text-xs text-muted-foreground">@</span>
      <Input
        value={seat.handle}
        onChange={(e) => onChange({ handle: e.target.value })}
        placeholder="handle"
        title="1–24 letters, digits, or dashes, starting with a letter"
        required
        className="h-8 w-28 text-xs"
        aria-label="Handle"
      />
      <select value={seat.providerId} onChange={(e) => onChange({ providerId: e.target.value, model: "", reasoningLevel: "" })} className={selectClass} aria-label="Provider">
        {options.providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.displayName}
            {p.available ? "" : " (unavailable)"}
          </option>
        ))}
      </select>
      <select value={seat.model} onChange={(e) => onChange({ model: e.target.value })} className={selectClass} aria-label="Model">
        <option value="">default model</option>
        {seat.model && !provider?.models.some((m) => m.model === seat.model) ? (
          <option value={seat.model}>{seat.model} (not in catalog)</option>
        ) : null}
        {(provider?.models ?? []).map((m) => (
          <option key={m.model} value={m.model}>
            {m.displayName}
            {m.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
      {(provider?.reasoningLevels.length ?? 0) > 0 ? (
        <select value={seat.reasoningLevel} onChange={(e) => { const next = e.target.value; onChange({ reasoningLevel: next === "" || (REASONING_LEVELS as readonly string[]).includes(next) ? next as ReasoningLevel | "" : "" }); }} className={selectClass} aria-label="Reasoning">
          <option value="">default reasoning</option>
          {(provider?.reasoningLevels ?? [])
            .filter((level): level is ReasoningLevel => (REASONING_LEVELS as readonly string[]).includes(level))
            .map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
        </select>
      ) : null}
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Read-only seats inspect the workspace but never change it">
        <input type="checkbox" checked={seat.canEdit} onChange={(e) => onChange({ canEdit: e.target.checked })} className="size-3.5" />
        may edit files
      </label>
      {onRemove ? (
        <Button type="button" variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground hover:text-foreground" aria-label="Remove seat" onClick={onRemove}>
          <Icon name="Trash2" className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function CreateCouncilForm({ onCreated, onCancel }: { onCreated: (councilId: string) => void; onCancel: () => void }) {
  const rpc = useRpc<Contract>();
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [seats, setSeats] = useState<SeatDraft[]>([]);
  const [chiefIndex, setChiefIndex] = useState(0);
  const [turns, setTurns] = useState(DEFAULT_TURNS);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    rpc.call("context_options").then(
      (result) => {
        setOptions(result);
        const defaults = defaultSeats(result);
        setSeats(defaults);
        setChiefIndex(Math.max(0, defaults.findIndex((s) => s.handle === DEFAULT_CHIEF)));
        setProjectId((current) => current || result.projects[0]?.id || "");
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);

  const update = (index: number, patch: Partial<SeatDraft>) => setSeats((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || options === null) return;
    setPending(true);
    setError(null);
    try {
      const input = createCouncilInputSchema.safeParse({
        title,
        projectId,
        seats: seats.map(toSeatInput),
        chief: seats[chiefIndex]?.handle.trim().toLowerCase() ?? "",
        defaultTurns: turns,
      });
      if (!input.success) throw new Error(describeInputIssues(input.error));
      for (const seat of input.data.seats) {
        const provider = options.providers.find((p) => p.id === seat.providerId);
        if (!provider?.available) throw new Error(`Seat @${seat.handle}: choose an available provider.`);
        if (seat.model && provider.models.length > 0 && !provider.models.some((m) => m.model === seat.model)) {
          throw new Error(`Seat @${seat.handle}: ${seat.model} is not available from ${provider.displayName}. Choose a model from its list.`);
        }
      }
      const { council } = await rpc.call("councils_create", input.data);
      onCreated(council.id);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };

  if (options === null) {
    return (
      <div className="p-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <EmptyState>Loading providers…</EmptyState>}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <form onSubmit={submit} noValidate className="mx-auto w-full max-w-3xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold">New council</h2>
          <p className="text-xs text-muted-foreground">
            Every seat gets its own thread in one shared workspace; threads are created when you convene. What each agent should do goes in your question; the council only tells them how the stance footer and the turn budget work.
          </p>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Title
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="DB choice" maxLength={120} required />
        </label>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={cn(selectClass, "block h-9 w-full")}>
            {options.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Seats</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={seats.length >= 8}
              onClick={() => {
                const first = options.providers.find((p) => p.available) ?? options.providers[0];
                if (!first) return;
                setSeats((current) => [...current, { handle: "", providerId: first.id, model: "", reasoningLevel: "", canEdit: false }]);
              }}
            >
              <Icon name="Plus" className="size-4" />
              Add seat
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Handles identify seats in @mentions. Use 1–24 letters, digits, or dashes, starting with a letter. The chief can be any seat, regardless of its name or provider.</p>
          <div className="space-y-2">
            {seats.map((seat, index) => (
              <SeatEditor key={index} seat={seat} options={options} onChange={(patch) => update(index, patch)} onRemove={seats.length > 2 ? () => {
                setSeats((current) => current.filter((_, i) => i !== index));
                setChiefIndex((current) => current === index ? 0 : current > index ? current - 1 : current);
              } : undefined} />
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs text-muted-foreground">
            Chief (writes the verdict)
            <select value={chiefIndex} onChange={(event) => setChiefIndex(Number(event.target.value))} className={cn(selectClass, "block h-9 w-full")}>
              {seats.map((seat, index) => (
                <option key={index} value={index}>
                  {seat.handle.trim() ? `@${seat.handle.trim().toLowerCase()}` : `Seat ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Turn budget
            <Input
              type="number"
              min={2}
              max={MAX_TURNS}
              value={turns}
              onChange={(event) => setTurns(Math.min(MAX_TURNS, Math.max(2, Number(event.target.value) || 8)))}
              className="h-8 w-16 text-xs"
            />
            <span>how many seat replies before the chief synthesizes</span>
          </label>
        </div>

        {error ? <p role="alert" className="whitespace-pre-line text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || seats.length < 2 || title.trim() === "" || projectId === ""}>
            <Icon name="MessageSquarePlus" className="size-4" />
            Create council
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Council room
// ---------------------------------------------------------------------------

function CouncilRoom({ councilId, compact = false }: { councilId: string; compact?: boolean }) {
  const { rpc, detail, error, refetch } = useCouncil(councilId);
  const navigate = useBbNavigate();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<"convene" | "say" | "resume" | "halt" | "verdict" | "archive" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const now = useTicker(detail?.seats.some(isWorking) ?? false);

  useEffect(() => {
    const el = listRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, detail?.job?.current]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const run = async (action: NonNullable<typeof pendingAction>, fn: () => Promise<unknown>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await fn();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const afterSend = () => {
    setText("");
    stickToBottom.current = true;
    refetch();
  };

  const convene = () =>
    run("convene", async () => {
      const body = text.trim();
      if (body === "") return;
      await rpc.call("councils_convene", { councilId, question: body, ...(turns === null ? {} : { turns }) });
      afterSend();
    });

  const say = () =>
    run("say", async () => {
      const body = text.trim();
      if (body === "") return;
      await rpc.call("councils_say", { councilId, text: body });
      afterSend();
    });

  const resume = () => run("resume", () => rpc.call("councils_resume", { councilId }));
  const verdict = () => run("verdict", () => rpc.call("councils_verdict", { councilId }));
  const halt = () =>
    run("halt", async () => {
      if (!window.confirm("Stop every running seat?")) return;
      await rpc.call("councils_halt", { councilId });
      refetch();
    });
  const archive = () =>
    run("archive", async () => {
      if (!window.confirm("Archive this council?")) return;
      await rpc.call("councils_archive", { councilId });
      if (!compact) navigate.toPluginPanel(PANEL_PATH, { replace: true });
    });

  if (error !== null) {
    return (
      <div className="p-4">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="p-4">
        <EmptyState>Loading council…</EmptyState>
      </div>
    );
  }

  const { council, seats, messages, job } = detail;
  const providerOf = (handle: string) => seats.find((s) => s.handle === handle)?.providerId ?? null;
  const working = seats.filter(isWorking);
  const effectiveTurns = turns ?? council.defaultTurns;
  const primaryDisabled = text.trim() !== "" && pendingAction === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {council.title} <span className={cn("text-xs font-normal", STATUS_STYLE[council.status] ?? "text-muted-foreground")}>[{council.status}]</span>
          </h2>
        </div>
        {council.status === "convened" ? (
          <Button variant="outline" size="sm" onClick={halt} disabled={pendingAction !== null} aria-label="Stop every running seat">
            <Icon name="Square" className="size-3.5" />
            Halt
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={archive} disabled={pendingAction !== null} aria-label="Archive council">
          <Icon name="Archive" className="size-4" />
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {seats.map((seat) => (
          <SeatChip key={seat.handle} seat={seat} isChief={seat.isChief} onOpenThread={() => { if (seat.threadId !== null) navigate.toThread(seat.threadId); }} />
        ))}
      </div>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4">
        {messages.length === 0 ? (
          <div className="py-6">
            <EmptyState>Convene with a question. Every seat answers in parallel; the debate runs until consensus or the turn cap.</EmptyState>
          </div>
        ) : (
          <ul className="mx-auto w-full max-w-3xl divide-y divide-border/60">
            {messages.map((message) => (
              <MessageRow key={message.seq} message={message} providerOf={providerOf} />
            ))}
            {working.map((seat) => (
              <WorkingRow key={`working-${seat.handle}`} seat={seat} now={now} />
            ))}
          </ul>
        )}
      </div>

      {job !== null ? <JobBanner job={job} onResume={resume} onVerdict={verdict} disabled={pendingAction !== null} /> : null}

      <form
        className="border-t border-border px-4 py-3"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (council.status === "idle") void convene();
          else void say();
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          placeholder={
            job?.paused
              ? `Answer @${job.paused.handle}; sending resumes the debate…`
              : council.status === "idle"
                ? "The question every seat answers…"
                : "Interject as the moderator…"
          }
          aria-label={council.status === "idle" ? "Question" : "Message"}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (council.status === "idle") void convene();
              else void say();
            }
          }}
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {council.status === "idle"
              ? `Convene posts this to every seat at once under a ${effectiveTurns}-turn budget.`
              : council.status === "paused"
                ? "Sending answers the paused seat and resumes the debate."
                : "Sending posts as the moderator; the current speaker sees it."}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {council.status === "idle" ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Seat replies before the chief synthesizes">
                Turns
                <Input
                  type="number"
                  min={2}
                  max={MAX_TURNS}
                  value={effectiveTurns}
                  onChange={(event) => setTurns(Math.min(MAX_TURNS, Math.max(2, Number(event.target.value) || 8)))}
                  className="h-8 w-14 text-xs"
                  aria-label="Turns"
                />
              </label>
            ) : null}
            {council.status === "idle" ? (
              <Button type="submit" size="sm" disabled={!primaryDisabled}>
                <Icon name="Zap" className="size-3.5" />
                Convene
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={!primaryDisabled}>
                <Icon name="Sent" className="size-3.5" />
                Say
              </Button>
            )}
          </div>
        </div>
        {actionError !== null ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p> : null}
      </form>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Page: list + room
// ---------------------------------------------------------------------------

function CouncilListItem({ council, active, onSelect }: { council: CouncilSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn("w-full rounded-md px-2.5 py-2 text-left hover:bg-state-hover", active && "bg-state-active")}
      >
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          {council.status === "convened" ? <Icon name="Loading" className="size-3 animate-spin text-muted-foreground" /> : null}
          {council.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {council.handles.map((h) => `@${h}`).join(" ")} · {council.messageCount} msg
          {council.lastAuthor !== null ? ` · last ${council.lastAuthor === "user" ? "you" : `@${council.lastAuthor}`}` : ""}
        </div>
      </button>
    </li>
  );
}

function CouncilPage({ subPath }: { subPath: string }) {
  const { councils, error } = useCouncils();
  const navigate = useBbNavigate();
  const [head] = subPath.split("/");
  const creating = head === "new";
  const councilId = !creating && head !== "" ? head : null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">Councils</span>
          <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "new" })}>
            <Icon name="Plus" className="size-4" />
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {error ? (
            <p role="alert" className="px-2 text-xs text-destructive">{error}</p>
          ) : councils === null ? (
            <p className="px-2 text-xs text-muted-foreground">Loading…</p>
          ) : councils.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No councils yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {councils.map((council) => (
                <CouncilListItem key={council.id} council={council} active={council.id === councilId} onSelect={() => navigate.toPluginPanel(PANEL_PATH, { subPath: council.id })} />
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {creating ? (
          <CreateCouncilForm onCreated={(id) => navigate.toPluginPanel(PANEL_PATH, { subPath: id, replace: true })} onCancel={() => navigate.toPluginPanel(PANEL_PATH, { replace: true })} />
        ) : councilId !== null ? (
          <CouncilRoom key={councilId} councilId={councilId} />
        ) : (
          <div className="p-6">
            <EmptyState>
              Pick a council or create one. Convene posts one question to every seat in parallel; the debate runs until consensus or the turn budget, then the chief writes the verdict.
            </EmptyState>
          </div>
        )}
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Council",
    icon: "Users",
    path: PANEL_PATH,
    component: CouncilPage,
  });
});
