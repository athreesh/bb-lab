// bb-plugin-usage-hud — frontend.
//
// A fixed bottom-left HUD showing inference metrics for the thread currently
// open in the active pane: per-turn token breakdown (native events on
// codex/claude-code/pi; omp's own session store on acp-omp), context-window
// ring, cost, and omp per-model perf (TTFT, decode tok/s).
//
// Uses experimental_appOverlay: an app-wide React mount with SDK hooks, no
// host chrome — the component renders its own fixed positioning. Visual
// language mirrors bb's native context pill (theme tokens, tabular-nums,
// warning ≥75%, destructive ≥90%).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbContext,
  useRealtime,
  useRpc,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadUsage } from "./server";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const REFRESH_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

interface HudState {
  threadId: string | null;
  usage: ThreadUsage | null;
  error: string | null;
}

function useThreadUsage(): HudState {
  const rpc = useRpc<Contract>();
  const context = useBbContext();
  const split = useSidebarSplitLayout();
  const pluginId = experimental_usePluginId();

  // The thread the user is actually looking at: pane A, else pane B, else the
  // context thread. Null on the New-thread screen.
  const focusThreadId = useMemo(() => {
    const paneThread = (threadId: string | null | undefined) => (typeof threadId === "string" ? threadId : null);
    const panes = split?.panes ?? [];
    return (
      paneThread(panes[0]?.threadId ?? null) ??
      paneThread(panes[1]?.threadId ?? null) ??
      context.threadId
    );
  }, [split, context.threadId]);

  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (focusThreadId === null) {
      setUsage(null);
      setError(null);
      return;
    }
    let cancelled = false;
    // providerThreadId is discovered server-side from the thread's own events.
    rpc
      .call("usage_for_thread", { threadId: focusThreadId, providerThreadId: "" })
      .then((result) => {
        if (cancelled) return;
        setUsage(result);
        setError(null);
      }, (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, focusThreadId, tick]);

  // Live updates: any thread event append triggers a debounced refetch. The
  // timer lives in a ref so handler invocations and unmount share cleanup.
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(debounceRef.current);
    },
    [],
  );
  useRealtime("thread:changed", (payload) => {
    const event = payload as { entity?: string; id?: string; metadata?: { eventTypes?: string[] } };
    if (event.entity !== "thread") return;
    if (event.id !== undefined && event.id !== focusThreadId) return;
    const types = event.metadata?.eventTypes;
    const relevant =
      types === undefined ||
      types.some(
        (type) =>
          type.startsWith("thread/tokenUsage") ||
          type.startsWith("thread/contextWindowUsage") ||
          type === "turn/completed",
      );
    if (!relevant) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
  });

  // Slow poll as a backstop (realtime can drop while disconnected).
  useEffect(() => {
    if (focusThreadId === null) return;
    const timer = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [focusThreadId, refetch, pluginId]);

  return { threadId: focusThreadId, usage, error };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatCost(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}


// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function Metric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  /** Tooltip override; defaults to the label. */
  title?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums" title={title ?? label}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium", tone)}>{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function UsageHud() {
  const { threadId, usage, error } = useThreadUsage();
  if (threadId === null || error !== null) return null;

  const omp = usage?.omp ?? null;
  const native = usage?.tokenUsage ?? null;
  const last =
    native?.last ?? omp?.lastUsage ?? null;
  const perf = omp?.perf ?? null;
  const codexPerf = usage?.codexPerf ?? null;
  // Cost display: omp/local models are the user's own endpoints — FREE. The
  // native cost field (omp's own estimate) wins when present; otherwise a
  // catalog-priced estimate for metered providers; "~" marks estimates.
  const isFree = omp !== null;
  const estimate = usage?.costEstimate ?? null;

  if (usage === null || (last === null && !isFree && estimate === null)) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-9 left-2 z-40 max-md:bottom-8 max-md:left-1"
      data-plugin-usage-hud=""
    >
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs text-popover-foreground shadow-md backdrop-blur">
        {isFree ? (
          <span
            className="inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
            title="Running on your own omp endpoint / local model"
          >
            FREE
          </span>
        ) : null}
        {!isFree && estimate !== null ? (
          <span
            className="inline-flex items-center font-medium tabular-nums text-warning-text"
            title={`Estimated cost of the last turn on ${estimate.model} (list price)`}
          >
            ~{formatCost(estimate.lastTurnUsd)}
          </span>
        ) : null}
        {last !== null ? (
          <>
            <Metric label="in" value={formatTokens(last.inputTokens)} />
            {last.cacheReadInputTokens !== undefined && last.cacheReadInputTokens > 0 ? (
              <Metric label="cache" value={formatTokens(last.cacheReadInputTokens)} />
            ) : null}
            <Metric label="out" value={formatTokens(last.outputTokens)} />
            {last.reasoningOutputTokens > 0 ? (
              <Metric label="think" value={formatTokens(last.reasoningOutputTokens)} />
            ) : null}
          </>
        ) : null}
        {perf?.decodeTokensPerSec !== null && perf?.decodeTokensPerSec !== undefined ? (
          <Metric
            label="tok/s"
            value={formatTokens(Math.round(perf.decodeTokensPerSec))}
            title="omp model_perf rolling decode throughput"
          />
        ) : null}
        {perf?.decodeTokensPerSec == null && codexPerf?.decodeTokensPerSec != null ? (
          <Metric
            label="tok/s"
            value={formatTokens(Math.round(codexPerf.decodeTokensPerSec))}
            title={`Measured over this thread's last ${codexPerf.samples} codex responses`}
          />
        ) : null}
        {perf?.ttftMs !== null && perf?.ttftMs !== undefined ? (
          <Metric
            label="TTFT"
            value={perf.ttftMs >= 1000 ? `${(perf.ttftMs / 1000).toFixed(1)}s` : `${Math.round(perf.ttftMs)}ms`}
          />
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "usage-hud",
    component: UsageHud,
  });
});
