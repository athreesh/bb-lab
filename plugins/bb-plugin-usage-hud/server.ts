// bb-plugin-usage-hud — backend.
//
// Serves inference metrics for a bb thread to the frontend HUD:
// 1. Native provider events (`thread/tokenUsage/updated`) — full per-turn
//    token breakdowns on codex/claude-code/pi threads, read via bb.sdk.
// 2. omp (acp-omp) threads — omp emits only a context-window figure over ACP,
//    so the breakdown is read from omp's own session store:
//    ~/.omp/agent/sessions/-<path>/<ts>_<sessionUuid>.jsonl, where the
//    sessionUuid equals bb's `providerThreadId` (verified 1:1 mapping), and
//    ~/.omp/agent/agent.db `model_perf` for TTFT / tok-s aggregates.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const tokenBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;

const ompMetricsSchema = z.object({
  found: z.boolean(),
  sessionFile: z.string().nullable(),
  // Last assistant message's usage record (per-response, cumulative context).
  lastUsage: tokenBreakdownSchema.nullable(),
  costUsd: z.number().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  // Rolling per-model aggregates from omp's model_perf table.
  perf: z
    .object({
      model: z.string(),
      samples: z.number(),
      decodeTokensPerSec: z.number().nullable(),
      ttftMs: z.number().nullable(),
    })
    .nullable(),
});
export type OmpMetrics = z.infer<typeof ompMetricsSchema>;

// Per-turn generation-throughput aggregates for closed providers, measured
// from their local stores. Codex: rollout JSONL `token_usage_record` rows
// (per-response output tokens) joined to ~/.codex/logs_2.sqlite
// `Output item` → `output_item_done` log windows (per-response generation
// time). Claude-code JSONL rows record only final usage — no duration — so
// there is nothing to measure yet; the block stays null there.
const codexPerfSchema = z.object({
  samples: z.number(),
  decodeTokensPerSec: z.number().nullable(),
});
export type CodexPerf = z.infer<typeof codexPerfSchema>;

const threadUsageSchema = z.object({
  // Native cumulative token usage (codex/claude-code/pi). Null when the
  // provider never emitted a tokenUsage event.
  tokenUsage: z
    .object({
      total: tokenBreakdownSchema,
      last: tokenBreakdownSchema,
      modelContextWindow: z.number().nullable(),
    })
    .nullable(),
  // Native context-window figure (all providers; includes omp via ACP).
  contextWindow: z
    .object({
      usedTokens: z.number().nullable(),
      modelContextWindow: z.number().nullable(),
      estimated: z.boolean(),
    })
    .nullable(),
  // omp-only enrichment from omp's local session store.
  omp: ompMetricsSchema.nullable(),
  // Cost estimate for metered providers (codex/claude-code): computed from the
  // last turn's token breakdown and the model's published list pricing (from
  // omp's models.db catalog). Null when pricing is unknown or usage is free.
  costEstimate: z
    .object({
      model: z.string(),
      // USD for the most recent turn.
      lastTurnUsd: z.number(),
      pricingSource: z.literal("omp-catalog"),
    })
    .nullable(),
  // Per-provider throughput aggregates measured from the provider's local
  // store (codex only today; null elsewhere).
  codexPerf: codexPerfSchema.nullable(),
});
export type ThreadUsage = z.infer<typeof threadUsageSchema>;

export const rpcContract = defineRpcContract({
  usage_for_thread: {
    input: z.object({ threadId: z.string().min(1), providerThreadId: z.string().optional() }),
    output: threadUsageSchema,
  },
});

type NativeTokenUsageEvent = {
  type: "thread/tokenUsage/updated";
  data: { tokenUsage: ThreadUsage["tokenUsage"] };
};
type NativeContextEvent = {
  type: "thread/contextWindowUsage/updated";
  data: { contextWindowUsage: ThreadUsage["contextWindow"]; providerThreadId: string };
};
type ThreadEventRow = NativeTokenUsageEvent | NativeContextEvent | { type: string; data: unknown };


// ---------------------------------------------------------------------------
// omp session store readers
// ---------------------------------------------------------------------------

const OMP_AGENT_DIR = join(homedir(), ".omp", "agent");
const OMP_SESSIONS_DIR = join(OMP_AGENT_DIR, "sessions");

interface OmpUsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface OmpAssistantMessage {
  role?: string;
  model?: string;
  provider?: string;
  usage?: OmpUsageRecord;
}

function ompBreakdown(usage: OmpUsageRecord): TokenBreakdown {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.input,
    cachedInputTokens: usage.cacheRead,
    cacheReadInputTokens: usage.cacheRead,
    cacheWriteInputTokens: usage.cacheWrite,
    outputTokens: usage.output,
    reasoningOutputTokens: 0,
  };
}

/** Read the last assistant usage record from an omp session JSONL (tail read; files can be tens of MB). */
async function readLastOmpUsage(sessionFile: string): Promise<{
  usage: OmpUsageRecord | null;
  model: string | null;
  provider: string | null;
}> {
  let handle: FileHandle;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return { usage: null, model: null, provider: null };
  }
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(tailLength);
    await handle.read(buffer, 0, tailLength, size - tailLength);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (line === undefined || line === "" || !line.includes('"usage"')) continue;
      try {
        const record = JSON.parse(line) as { message?: OmpAssistantMessage };
        const message = record.message;
        if (message?.role !== "assistant" || message.usage === undefined) continue;
        return {
          usage: message.usage,
          model: message.model ?? null,
          provider: message.provider ?? null,
        };
      } catch {
        // Torn tail line from an in-flight write; keep scanning backwards.
      }
    }
    return { usage: null, model: null, provider: null };
  } finally {
    await handle.close();
  }
}

interface ModelPerfRow {
  model_key: string;
  samples: number;
  output_tokens: number;
  gen_ms: number;
  ttft_samples: number;
  ttft_ms: number;
}

/** Rolling per-model decode/ttft aggregates from omp's agent.db (read-only). */
function readModelPerf(provider: string, model: string): OmpMetrics["perf"] {
  try {
    const db = new Database(join(OMP_AGENT_DIR, "agent.db"), { readonly: true, fileMustExist: true });
    try {
      // model_perf keys are provider-qualified ("webster/glm-5.3-flash");
      // session messages record provider and model in separate fields.
      const row = db
        .prepare(
          "SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms FROM model_perf WHERE model_key = ? OR model_key = ?",
        )
        .get(model, `${provider}/${model}`) as ModelPerfRow | undefined;
      if (row === undefined || row.samples === 0) return null;
      return {
        model: row.model_key,
        samples: row.samples,
        decodeTokensPerSec: row.gen_ms > 0 ? row.output_tokens / (row.gen_ms / 1000) : null,
        ttftMs: row.ttft_samples > 0 ? row.ttft_ms / row.ttft_samples : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface ModelCatalogEntry {
  id: string;
  cost?: { input: number; output: number; cacheRead?: number };
}

/** USD per million tokens for one model, from omp's models.db catalog (authoritative first-party rows). */
function readModelPricing(providerId: string, modelId: string): { input: number; output: number; cacheRead: number } | null {
  try {
    const db = new Database(join(OMP_AGENT_DIR, "models.db"), { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare("SELECT provider_id, models FROM model_cache").all() as Array<{
        provider_id: string;
        models: string;
      }>;
      // Exact id match on the provider's own catalog first (openai/gpt-6-astra,
      // anthropic/claude-*); skip proxy/aggregator rows whose cost is 0.
      for (const row of rows) {
        if (row.provider_id !== providerId) continue;
        for (const entry of JSON.parse(row.models) as ModelCatalogEntry[]) {
          if (entry.id !== modelId || entry.cost === undefined) continue;
          if (entry.cost.input === 0 && entry.cost.output === 0) return null;
          return {
            input: entry.cost.input,
            output: entry.cost.output,
            cacheRead: entry.cost.cacheRead ?? 0,
          };
        }
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Estimate USD for one turn from its token breakdown and per-million pricing. */
function estimateTurnCostUsd(
  breakdown: TokenBreakdown,
  pricing: { input: number; output: number; cacheRead: number },
): number {
  const uncachedInput = breakdown.inputTokens - breakdown.cachedInputTokens;
  return (
    (uncachedInput / 1_000_000) * pricing.input +
    (breakdown.cachedInputTokens / 1_000_000) * pricing.cacheRead +
    (breakdown.outputTokens / 1_000_000) * pricing.output
  );
}

async function readdirOrNull(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch {
    return null;
  }
}

/** Find the omp session JSONL whose file name contains the provider session UUID. */
async function findOmpSessionFile(providerThreadId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(providerThreadId)) return null;
  const projects = await readdirOrNull(OMP_SESSIONS_DIR);
  if (projects === null) return null;
  for (const project of projects) {
    const entries = await readdirOrNull(join(OMP_SESSIONS_DIR, project));
    if (entries === null) continue;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      // File name: <iso-ts>_<sessionUuid>.jsonl (single session) or
      // <dir>/<iso-ts>_<sessionUuid>/<name>.jsonl (sub-sessions).
      if (entry.includes(providerThreadId)) return join(OMP_SESSIONS_DIR, project, entry);
    }
  }
  return null;
}

async function readOmpMetrics(providerThreadId: string): Promise<OmpMetrics> {
  const sessionFile = await findOmpSessionFile(providerThreadId);
  if (sessionFile === null) {
    return {
      found: false,
      sessionFile: null,
      lastUsage: null,
      costUsd: null,
      model: null,
      provider: null,
      perf: null,
    };
  }
  const { usage, model, provider } = await readLastOmpUsage(sessionFile);
  const perf = model !== null ? readModelPerf(provider ?? "", model) : null;
  return {
    found: true,
    sessionFile,
    lastUsage: usage !== null ? ompBreakdown(usage) : null,
    costUsd: usage?.cost?.total ?? null,
    model,
    provider,
    perf,
  };
}


// ---------------------------------------------------------------------------
// codex per-response throughput (closed-provider tok/s)
// ---------------------------------------------------------------------------

const CODEX_DIR = join(homedir(), ".codex");

interface CodexUsageRecord {
  timestamp?: string;
  payload?: { usage?: { output_tokens?: number } };
}

/**
 * Generation-time windows for one codex thread from codex's own debug log
 * (~/.codex/logs_2.sqlite). One sampling request emits, per streamed item,
 * an "Output item item_type=..." line when its first chunk arrives and an
 * `from="output_item_done"` line when it completes; the first→done span of
 * message/reasoning items is that response's generation window. Rows are
 * pruned after ~30 days, so recent threads always measure.
 */
function readCodexItemWindows(logsDb: string, threadId: string): Array<{ start: number; end: number | null }> {
  try {
    const db = new Database(logsDb, { readonly: true, fileMustExist: true });
    try {
      const itemType =
        "(feedback_log_body LIKE '%item_type=\"message\"%' OR feedback_log_body LIKE '%item_type=\"reasoning\"%')";
      const seen = db
        .prepare(
          `SELECT substr(feedback_log_body, instr(feedback_log_body,'item_id="') + 9, 64), ts + ts_nanos/1e9
           FROM logs
           WHERE thread_id = ? AND feedback_log_body LIKE '%Output item item_type=%'
             AND feedback_log_body NOT LIKE '%from="output_item_done"%' AND ${itemType}
           ORDER BY ts, ts_nanos`,
        )
        .raw(true)
        .all(threadId) as Array<[string, number]>;
      const done = db
        .prepare(
          `SELECT substr(feedback_log_body, instr(feedback_log_body,'item_id="') + 9, 64), ts + ts_nanos/1e9
           FROM logs
           WHERE thread_id = ? AND feedback_log_body LIKE '%from="output_item_done"%' AND ${itemType}
           ORDER BY ts, ts_nanos`,
        )
        .raw(true)
        .all(threadId) as Array<[string, number]>;
      const firstDone: Record<string, number> = {};
      for (const [itemId, time] of done) {
        const known = firstDone[itemId];
        if (known === undefined || time < known) firstDone[itemId] = time;
      }
      return seen
        .map(([itemId, start]) => ({ start, end: firstDone[itemId] ?? null }))
        .sort((a, b) => a.start - b.start);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Tail-read per-response output token counts from the thread's codex rollout
 * JSONL (`token_usage_record` rows). Sessions live under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>_<threadId>.jsonl.
 */
async function findCodexRolloutFile(threadId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null;
  const yearDir = join(CODEX_DIR, "sessions");
  const years = await readdirOrNull(yearDir);
  if (years === null) return null;
  for (const year of [...years].sort().reverse()) {
    if (!/^\d{4}$/.test(year)) continue;
    const months = await readdirOrNull(join(yearDir, year));
    if (months === null) continue;
    for (const month of [...months].sort().reverse()) {
      if (!/^\d{2}$/.test(month)) continue;
      const days = await readdirOrNull(join(yearDir, year, month));
      if (days === null) continue;
      for (const day of [...days].sort().reverse()) {
        if (!/^\d{2}$/.test(day)) continue;
        const entries = await readdirOrNull(join(yearDir, year, month, day));
        if (entries === null) continue;
        for (const entry of entries) {
          if (entry.endsWith(".jsonl") && entry.includes(threadId)) {
            return join(yearDir, year, month, day, entry);
          }
        }
      }
    }
  }
  return null;
}

const CODEX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_WINDOW_MAX_AGE_S = 300;
const CODEX_MIN_WINDOW_S = 0.25;

/**
 * Rolling decode throughput for a codex thread: assign each rollout
 * `token_usage_record` (response completion + output tokens) to the latest
 * item window that opened before it, and divide summed tokens by summed
 * generation time. Unpaired rows (log pruned, torn line) are skipped.
 */
async function readCodexPerf(threadId: string): Promise<CodexPerf | null> {
  const rolloutFile = await findCodexRolloutFile(threadId);
  if (rolloutFile === null) return null;
  const windows = readCodexItemWindows(join(CODEX_DIR, "logs_2.sqlite"), threadId);
  if (windows.length === 0) return null;
  const windowStarts = windows.map((window) => window.start);

  let handle: FileHandle;
  try {
    handle = await open(rolloutFile, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, CODEX_ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(tailLength);
    await handle.read(buffer, 0, tailLength, size - tailLength);
    const lines = buffer.toString("utf8").split("\n");
    let totalTokens = 0;
    let totalSeconds = 0;
    let samples = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (line === undefined || line === "" || !line.includes('"token_usage_record"')) continue;
      try {
        const record = JSON.parse(line) as CodexUsageRecord;
        const outputTokens = record.payload?.usage?.output_tokens;
        if (record.timestamp === undefined || outputTokens === undefined) continue;
        const parsedMs = Date.parse(record.timestamp);
        const completedAt = Number.isNaN(parsedMs) ? NaN : parsedMs / 1000;
        if (Number.isNaN(completedAt)) continue;
        // Desc scan: bisect for the newest window opened before this response.
        let low = 0;
        let high = windowStarts.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (windowStarts[mid] <= completedAt) low = mid + 1;
          else high = mid;
        }
        const index = low - 1;
        if (index < 0) continue;
        const window = windows[index];
        if (completedAt - window.start > CODEX_WINDOW_MAX_AGE_S) continue;
        const duration = Math.max((window.end ?? completedAt) - window.start, CODEX_MIN_WINDOW_S);
        totalTokens += outputTokens;
        totalSeconds += duration;
        samples += 1;
      } catch {
        // Torn tail line from an in-flight write; keep scanning backwards.
      }
    }
    if (samples === 0 || totalSeconds <= 0) return null;
    return { samples, decodeTokensPerSec: totalTokens / totalSeconds };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  async function readOmpMetricsWhenAcp(threadId: string, providerThreadId: string): Promise<OmpMetrics | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.providerId !== "acp-omp") return null;
    } catch (cause) {
      bb.log.warn(`usage-hud: thread ${threadId} lookup failed: ${errorMessage(cause)}`);
      return null;
    }
    try {
      return await readOmpMetrics(providerThreadId);
    } catch (cause) {
      bb.log.warn(`usage-hud: omp metrics for ${providerThreadId} failed: ${errorMessage(cause)}`);
      return null;
    }
  }

  /**
   * Cost estimate for metered providers. omp threads are the user's own
   * local/self-hosted endpoints — reported as free, not estimated. For
   * codex/claude-code the model id from the newest turn request is priced
   * against omp's catalog (openai/anthropic first-party rows).
   */
  async function estimateCostForThread(
    threadId: string,
    executionModel: string | null,
    tokenUsage: ThreadUsage["tokenUsage"],
  ): Promise<ThreadUsage["costEstimate"]> {
    if (executionModel === null || tokenUsage === null) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.providerId !== "codex" && thread.providerId !== "claude-code") return null;
      const catalogProvider = thread.providerId === "codex" ? "openai" : "anthropic";
      // execution.model may be provider-qualified ("webster/glm-5.3-flash");
      // catalog ids are bare ("gpt-6-astra").
      const bareModel = executionModel.includes("/") ? (executionModel.split("/").pop() ?? executionModel) : executionModel;
      const pricing = readModelPricing(catalogProvider, bareModel);
      if (pricing === null) return null;
      return {
        model: executionModel,
        lastTurnUsd: estimateTurnCostUsd(tokenUsage.last, pricing),
        pricingSource: "omp-catalog",
      };
    } catch (cause) {
      bb.log.warn(`usage-hud: cost estimate for ${threadId} failed: ${errorMessage(cause)}`);
      return null;
    }
  }

  bb.rpc.register(rpcContract, {
    usage_for_thread: async ({ threadId, providerThreadId }) => {
      const events = (await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated", "thread/contextWindowUsage/updated", "client/turn/requested"],
        order: "desc",
        limit: "40",
      })) as ThreadEventRow[];

      let contextWindow: ThreadUsage["contextWindow"] = null;
      let tokenUsage: ThreadUsage["tokenUsage"] = null;
      let resolvedProviderThreadId = providerThreadId ?? "";
      let executionModel: string | null = null;
      for (const event of events) {
        // The SDK's event union includes a `{ type: string; data: unknown }`
        // excess member that defeats discriminated-union narrowing; cast to
        // the known native event shape after the literal type check.
        if (event.type === "thread/tokenUsage/updated") {
          const known = event as NativeTokenUsageEvent;
          if (tokenUsage === null) tokenUsage = known.data.tokenUsage;
        } else if (event.type === "thread/contextWindowUsage/updated") {
          const known = event as NativeContextEvent;
          if (contextWindow === null) contextWindow = known.data.contextWindowUsage;
          if (resolvedProviderThreadId === "") resolvedProviderThreadId = known.data.providerThreadId;
        } else if (event.type === "client/turn/requested") {
          // Desc order: the first row is the newest turn's requested model.
          if (executionModel === null) {
            const known = event as { data: { execution?: { model?: string } } };
            executionModel = known.data.execution?.model ?? null;
          }
        } else {
          continue;
        }
        if (tokenUsage !== null && contextWindow !== null && resolvedProviderThreadId !== "" && executionModel !== null) break;
      }
      const omp = await readOmpMetricsWhenAcp(threadId, resolvedProviderThreadId);

      // Throughput for closed providers: measured from codex's local stores
      // on codex threads only (claude-code records no generation durations).
      let codexPerf: CodexPerf | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.providerId === "codex") codexPerf = await readCodexPerf(resolvedProviderThreadId);
      } catch (cause) {
        bb.log.warn(`usage-hud: codex perf for ${threadId} failed: ${errorMessage(cause)}`);
      }

      const costEstimate = await estimateCostForThread(threadId, executionModel, tokenUsage);

      return { tokenUsage, contextWindow, omp, costEstimate, codexPerf };
    },
  });

  bb.cli.register({
    name: "usage-hud",
    summary: "Show inference metrics for a bb thread",
    commands: [
      {
        name: "show",
        summary: "Show metrics for one thread",
        usage: "bb usage-hud show <thread-id> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, threadId] = args;
      if (command !== "show" || threadId === undefined) {
        return { exitCode: 0, stdout: "Usage: bb usage-hud show <thread-id> [--json]" };
      }
      try {
        const events = (await bb.sdk.threads.events.list({
          threadId,
          types: ["thread/tokenUsage/updated", "thread/contextWindowUsage/updated"],
          order: "desc",
          limit: "40",
        })) as ThreadEventRow[];

        let providerThreadId = "";
        let contextWindow: ThreadUsage["contextWindow"] = null;
        let tokenUsage: ThreadUsage["tokenUsage"] = null;
        for (const event of events) {
          if (event.type === "thread/tokenUsage/updated") {
            const known = event as NativeTokenUsageEvent;
            if (tokenUsage === null) tokenUsage = known.data.tokenUsage;
          } else if (event.type === "thread/contextWindowUsage/updated") {
            const known = event as NativeContextEvent;
            if (contextWindow === null) contextWindow = known.data.contextWindowUsage;
            providerThreadId = known.data.providerThreadId;
          } else {
            continue;
          }
          if (tokenUsage !== null && contextWindow !== null) break;
        }
        if (providerThreadId === "") {
          return { exitCode: 1, stderr: "No provider session recorded for this thread yet." };
        }
        const omp = await readOmpMetricsWhenAcp(threadId, providerThreadId);
        let codexPerf: CodexPerf | null = null;
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.providerId === "codex") codexPerf = await readCodexPerf(providerThreadId);
        } catch {
          // CLI prints the rest of the payload; perf is enrichment only.
        }
        const payload = { providerThreadId, native: tokenUsage, contextWindow, omp, codexPerf };
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(payload) : JSON.stringify(payload, null, 2),
        };
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
