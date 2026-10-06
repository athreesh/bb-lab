// bb-plugin-council — server entry.
//
// A council is a shared transcript owned by this plugin. Each seat is an
// ordinary bb thread (one per agent provider) sharing the council's
// environment. Convening posts the question to every seat in parallel; each
// reply is captured on `thread.idle`, parsed for its STANCE / OPEN footer,
// and posted back to the transcript. The debate scheduler picks the next
// speaker — a dissenter first, then round-robin — and delivers only what that
// seat has not seen, labeled by author. The debate ends on consensus, the
// turn cap, or a need-info pause; the chief seat then synthesizes the verdict.
import { defineRpcContract, type BbPluginApi, type PluginCliResult } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { DEFAULT_SEATS, DEFAULT_CHIEF, DEFAULT_TURNS } from "./lib/default-roster";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HANDLE_RE, REASONING_LEVELS, MAX_TURNS, turnsSchema, seatInputSchema, createCouncilInputSchema, describeInputIssues } from "./lib/council-input";

// ---------------------------------------------------------------------------
// Wire schemas (shared with app.tsx through type-only imports)
// ---------------------------------------------------------------------------

export { MAX_TURNS, seatInputSchema } from "./lib/council-input";
type ReasoningLevel = NonNullable<SeatInput["reasoningLevel"]>;

export const STANCES = ["agree", "disagree", "need-info", "pass"] as const;
const stanceSchema = z.enum(STANCES);
export type Stance = z.infer<typeof stanceSchema>;

const briefSchema = z.enum(["full", "summary", "none"]);
export type Brief = z.infer<typeof briefSchema>;

export type SeatInput = z.infer<typeof seatInputSchema>;

export const seatSchema = z.object({
  handle: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  canEdit: z.boolean(),
  isChief: z.boolean(),
  threadId: z.string().nullable(),
  lastSeenSeq: z.number(),
  status: z.string().nullable(),
  lastStance: stanceSchema.nullable(),
  turnsUsed: z.number(),
});
export type Seat = z.infer<typeof seatSchema>;

export const messageSchema = z.object({
  seq: z.number(),
  author: z.string(),
  text: z.string(),
  stance: stanceSchema.nullable(),
  openPoints: z.array(z.string()),
  createdAt: z.number(),
});
export type Message = z.infer<typeof messageSchema>;

export const COUNCIL_STATUSES = ["idle", "convened", "paused", "verdict"] as const;
export const councilSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  chief: z.string(),
  defaultTurns: z.number(),
  status: z.enum(COUNCIL_STATUSES),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Council = z.infer<typeof councilSchema>;
type CouncilStatus = Council["status"];

export const councilSummarySchema = councilSchema.extend({
  handles: z.array(z.string()),
  messageCount: z.number(),
  lastAuthor: z.string().nullable(),
});
export type CouncilSummary = z.infer<typeof councilSummarySchema>;

export const jobSchema = z
  .object({
    question: z.string(),
    totalTurns: z.number(),
    turn: z.number(),
    current: z.string().nullable(),
    paused: z.object({ handle: z.string(), question: z.string() }).nullable(),
    startedAt: z.number(),
  })
  .nullable();
export type Job = z.infer<typeof jobSchema>;

export const councilDetailSchema = z.object({
  council: councilSchema,
  seats: z.array(seatSchema),
  messages: z.array(messageSchema),
  job: jobSchema,
});
export type CouncilDetail = z.infer<typeof councilDetailSchema>;

export const providerOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  models: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  reasoningLevels: z.array(z.string()),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

export const contextOptionsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  providers: z.array(providerOptionSchema),
});
export type ContextOptions = z.infer<typeof contextOptionsSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const councilIdSchema = z.object({ councilId: z.string() });
const textSchema = z.string().trim().min(1).max(20_000);
const launchInputSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  question: textSchema,
  turns: turnsSchema.optional(),
});
const deliveryFailureSchema = z.object({ handle: z.string(), error: z.string() });

export const rpcContract = defineRpcContract({
  councils_list: { input: z.null(), output: z.object({ councils: z.array(councilSummarySchema) }) },
  councils_create: {
    input: createCouncilInputSchema,
    output: z.object({ council: councilSchema }),
  },
  councils_launch: {
    input: launchInputSchema,
    output: z.object({ council: councilSchema, failures: z.array(deliveryFailureSchema) }),
  },
  councils_get: { input: councilIdSchema, output: councilDetailSchema },
  /** Convene: post the question and start the debate under a turn budget. */
  councils_convene: {
    input: z.object({ councilId: z.string(), question: textSchema, turns: turnsSchema.optional() }),
    output: okSchema,
  },
  /** Interject as the moderator; answers a need-info pause and resumes the debate. */
  councils_say: {
    input: z.object({ councilId: z.string(), text: textSchema }),
    output: okSchema,
  },
  councils_resume: { input: councilIdSchema, output: okSchema },
  councils_halt: { input: councilIdSchema, output: z.object({ stopped: z.array(z.string()) }) },
  councils_verdict: { input: councilIdSchema, output: okSchema },
  councils_add_seat: {
    input: z.object({ councilId: z.string(), seat: seatInputSchema, brief: briefSchema.optional() }),
    output: okSchema,
  },
  councils_archive: { input: councilIdSchema, output: okSchema },
  context_options: { input: z.null(), output: contextOptionsSchema },
});

/** Realtime channel app.tsx listens on; payload is `{ councilId }`. */
export const COUNCIL_CHANGED = "council-changed";

const INSTRUCTION_PARALLEL =
  "The moderator put the same question to every seat at once. Answer it independently from your own judgment; do not hedge to blend in. End with your STANCE footer.";
const INSTRUCTION_SYNTHESIS = [
  "The debate has ended. As chief, write the verdict for the Council:",
  "1. The decision, stated plainly.",
  "2. The reasoning that survived the debate (attribute key points to seats by handle).",
  "3. The disagreements that were not resolved and who holds them.",
  "4. Concrete next steps.",
  "This is recorded as the official verdict.",
].join("\n");
const INSTRUCTION_BRIEF = (forHandle: string) =>
  `A new seat, @${forHandle}, is joining the Council. Summarize the problem, the positions so far, and what is still open, addressed to them. End with your STANCE footer.`;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function randomId(): string {
  return randomUUID().slice(0, 8);
}

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Footer parsing
// ---------------------------------------------------------------------------

const STANCE_RE = /^\s*STANCE:\s*(agree|disagree|need-info|pass)\s*$/im;
const OPEN_RE = /^\s*OPEN:\s*$/im;
const OPEN_LINE_RE = /^\s*[-*]\s+(.*)$/;
const BODY_CUT_RE = /^\s*(?:STANCE|OPEN):/im;

export function parseFooter(text: string): { stance: Stance | null; openPoints: string[]; body: string } {
  const stance = (STANCE_RE.exec(text)?.[1] ?? null) as Stance | null;
  const openPoints: string[] = [];
  const openMatch = OPEN_RE.exec(text);
  if (openMatch !== null) {
    const lines = text.slice(openMatch.index + openMatch[0].length).split("\n");
    // The slice starts with the remainder of the OPEN: line itself, so skip
    // leading blanks, then collect bullets until the first non-bullet line.
    let started = false;
    for (const line of lines) {
      const item = OPEN_LINE_RE.exec(line);
      if (item !== null) {
        const point = item[1].trim();
        if (point.length > 0) openPoints.push(point);
        started = true;
        continue;
      }
      if (!started && line.trim() === "") continue;
      break;
    }
  }
  const cut = BODY_CUT_RE.exec(text);
  const body = cut === null ? text.trim() : text.slice(0, cut.index).trim();
  return { stance, openPoints, body: body.length > 0 ? body : text.trim() };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Append-only migrations. Never edit shipped rows.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS councils (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT,
     chief TEXT NOT NULL,
     default_turns INTEGER NOT NULL DEFAULT 8,
     status TEXT NOT NULL DEFAULT 'idle',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     archived_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS seats (
     council_id TEXT NOT NULL,
     handle TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     model TEXT,
     reasoning_level TEXT,
     can_edit INTEGER NOT NULL DEFAULT 0,
     is_chief INTEGER NOT NULL DEFAULT 0,
     thread_id TEXT,
     last_seen_seq INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     last_stance TEXT,
     turns_used INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (council_id, handle)
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     council_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     author TEXT NOT NULL,
     text TEXT NOT NULL,
     stance TEXT,
     open_points TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     PRIMARY KEY (council_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS awaiting (
     council_id TEXT NOT NULL,
     handle TEXT NOT NULL,
     turns_left INTEGER NOT NULL,
     delivered_at INTEGER NOT NULL,
     PRIMARY KEY (council_id, handle)
  )`,
];

interface CouncilRow {
  id: string;
  title: string;
  project_id: string;
  environment_id: string | null;
  chief: string;
  default_turns: number;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface SeatRow {
  council_id: string;
  handle: string;
  provider_id: string;
  model: string | null;
  reasoning_level: string | null;
  can_edit: 0 | 1;
  is_chief: 0 | 1;
  thread_id: string | null;
  last_seen_seq: number;
  status: string | null;
  last_stance: string | null;
  turns_used: number;
  removed: 0 | 1;
}

interface MessageRow {
  council_id: string;
  seq: number;
  author: string;
  text: string;
  stance: string | null;
  open_points: string;
  created_at: number;
}

interface AwaitingRow {
  council_id: string;
  handle: string;
  turns_left: number;
  delivered_at: number;
}

interface MessageMeta {
  stance?: Stance | null;
  openPoints?: string[];
}

interface CouncilQueries {
  insertCouncil: Database.Statement;
  councilById: Database.Statement;
  councilsAll: Database.Statement;
  updateCouncilStatus: Database.Statement;
  updateCouncilEnvironment: Database.Statement;
  archiveCouncil: Database.Statement;
  insertSeat: Database.Statement;
  seatsAll: Database.Statement;
  seat: Database.Statement;
  seatByThread: Database.Statement;
  setSeatThread: Database.Statement;
  setSeatSeen: Database.Statement;
  setSeatStance: Database.Statement;
  setSeatStatus: Database.Statement;
  markChief: Database.Statement;
  insertMessage: Database.Statement;
  maxSeq: Database.Statement;
  messagesAll: Database.Statement;
  awaitingUpsert: Database.Statement;
  awaitingDelete: Database.Statement;
  awaitingAll: Database.Statement;
  awaitingClear: Database.Statement;
}

interface CouncilStore {
  q: CouncilQueries;
  appendMessage(councilId: string, author: string, text: string, meta?: MessageMeta): MessageRow;
}

function createStore(db: Database.Database): CouncilStore {
  const q: CouncilQueries = {
    insertCouncil: db.prepare(
      `INSERT INTO councils (id, title, project_id, environment_id, chief, default_turns, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ),
    councilById: db.prepare(`SELECT * FROM councils WHERE id = ? AND archived_at IS NULL`),
    councilsAll: db.prepare(`SELECT * FROM councils WHERE archived_at IS NULL ORDER BY updated_at DESC`),
    updateCouncilStatus: db.prepare(`UPDATE councils SET status = ?, updated_at = ? WHERE id = ?`),
    updateCouncilEnvironment: db.prepare(`UPDATE councils SET environment_id = ?, updated_at = ? WHERE id = ?`),
    archiveCouncil: db.prepare(`UPDATE councils SET archived_at = ?, updated_at = ? WHERE id = ?`),
    insertSeat: db.prepare(
      `INSERT INTO seats (council_id, handle, provider_id, model, reasoning_level, can_edit, is_chief, last_seen_seq)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    ),
    seatsAll: db.prepare(`SELECT * FROM seats WHERE council_id = ? AND removed = 0 ORDER BY rowid`),
    seat: db.prepare(`SELECT * FROM seats WHERE council_id = ? AND handle = ?`),
    seatByThread: db.prepare(`SELECT * FROM seats WHERE thread_id = ? AND removed = 0`),
    setSeatThread: db.prepare(`UPDATE seats SET thread_id = ?, status = NULL WHERE council_id = ? AND handle = ?`),
    setSeatSeen: db.prepare(`UPDATE seats SET last_seen_seq = ? WHERE council_id = ? AND handle = ?`),
    setSeatStance: db.prepare(`UPDATE seats SET last_stance = ?, turns_used = turns_used + 1 WHERE council_id = ? AND handle = ?`),
    setSeatStatus: db.prepare(`UPDATE seats SET status = ? WHERE council_id = ? AND handle = ?`),
    markChief: db.prepare(`UPDATE seats SET is_chief = 1 WHERE council_id = ? AND handle = ?`),
    insertMessage: db.prepare(
      `INSERT INTO messages (council_id, seq, author, text, stance, open_points, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    maxSeq: db.prepare(`SELECT seq FROM messages WHERE council_id = ? ORDER BY seq DESC LIMIT 1`),
    messagesAll: db.prepare(`SELECT * FROM messages WHERE council_id = ? ORDER BY seq`),
    awaitingUpsert: db.prepare(
      `INSERT INTO awaiting (council_id, handle, turns_left, delivered_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (council_id, handle) DO UPDATE SET turns_left = excluded.turns_left, delivered_at = excluded.delivered_at`,
    ),
    awaitingDelete: db.prepare(`DELETE FROM awaiting WHERE council_id = ? AND handle = ?`),
    awaitingAll: db.prepare(`SELECT * FROM awaiting`),
    awaitingClear: db.prepare(`DELETE FROM awaiting WHERE council_id = ?`),
  };

  const appendMessage = db.transaction(
    (councilId: string, author: string, text: string, meta: MessageMeta = {}): MessageRow => {
      const seq = ((q.maxSeq.get(councilId) as { seq?: number } | undefined)?.seq ?? 0) + 1;
      const row: MessageRow = {
        council_id: councilId,
        seq,
        author,
        text,
        stance: meta.stance ?? null,
        open_points: JSON.stringify(meta.openPoints ?? []),
        created_at: Date.now(),
      };
      q.insertMessage.run(row.council_id, row.seq, row.author, row.text, row.stance, row.open_points, row.created_at);
      return row;
    },
  );

  return { q, appendMessage };
}

interface DebateJob {
  question: string;
  totalTurns: number;
  turn: number;
  current: string | null;
  paused: { handle: string; question: string } | null;
  startedAt: number;
  controller: AbortController;
}

interface Awaiting {
  turnsLeft: number;
  deliveredAt: number;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);
  const { q } = store;

  // In-flight expectations, restored from SQLite so replies survive a reload.
  const awaiting = new Map<string, Awaiting>();
  for (const row of q.awaitingAll.all() as AwaitingRow[]) {
    awaiting.set(`${row.council_id}/${row.handle}`, {
      turnsLeft: row.turns_left,
      deliveredAt: row.delivered_at,
    });
  }
  if (awaiting.size > 0) bb.log.info(`restored ${awaiting.size} in-flight expectation(s)`);

  const jobs = new Map<string, DebateJob>();
  const spawnLocks = new Map<string, Promise<void>>();

  function pendingKey(councilId: string, handle: string): string {
    return `${councilId}/${handle}`;
  }

  function publish(councilId: string): void {
    bb.realtime.publish(COUNCIL_CHANGED, { councilId });
  }

  function postSystem(councilId: string, text: string): void {
    store.appendMessage(councilId, "system", text);
    publish(councilId);
  }

  function setCouncilStatus(councilId: string, status: CouncilStatus): void {
    q.updateCouncilStatus.run(status, Date.now(), councilId);
  }

  function council(councilId: string): CouncilRow | undefined {
    return q.councilById.get(councilId) as CouncilRow | undefined;
  }

  function seats(councilId: string): SeatRow[] {
    return q.seatsAll.all(councilId) as SeatRow[];
  }

  function seat(councilId: string, handle: string): SeatRow | undefined {
    return q.seat.get(councilId, handle) as SeatRow | undefined;
  }

  function currentSeq(councilId: string): number {
    return (q.maxSeq.get(councilId) as { seq?: number } | undefined)?.seq ?? 0;
  }

  function isReasoningLevel(value: string | null | undefined): value is ReasoningLevel {
    return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
  }

  async function providerDirectory(): Promise<Map<string, { available: boolean }>> {
    const map = new Map<string, { available: boolean }>();
    for (const provider of await bb.sdk.providers.list()) {
      map.set(provider.id, { available: provider.available });
    }
    return map;
  }

  // -- Spawning --------------------------------------------------------------

  function seatPrompt(councilRow: CouncilRow, seatRow: SeatRow, prompt: string): string {
    const roster = seats(councilRow.id)
      .map((s) => `@${s.handle} (${s.provider_id}${s.is_chief ? ", chief" : ""})`)
      .join(", ");
    return [
      `You are @${seatRow.handle}, a seat on the Council "${councilRow.title}".`,
      `Other seats: ${roster}.`,
      `The seat @${councilRow.chief} writes the final synthesis.`,
      seatRow.is_chief
        ? "As chief, you will write the final verdict when the debate ends."
        : "Argue honestly; your stance footer decides whether the debate continues.",
      "Follow the council-seat skill protocol: end every reply with STANCE and OPEN lines.",
      "You are already a participant. Do not invoke /council or create another council.",
      seatRow.can_edit
        ? "You may edit files only when the moderator's question calls for changes."
        : "This seat is read-only: inspect the workspace but do not change files.",
      "",
      prompt,
    ].join("\n");
  }

  function permissionModeFor(modes: readonly string[]): "auto" | "accept-edits" | "full" | undefined {
    if (modes.includes("auto")) return "auto";
    if (modes.includes("accept-edits")) return "accept-edits";
    if (modes.includes("full")) return "full";
    return undefined;
  }

  function sendText(threadId: string, text: string) {
    return bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  async function sendOrSpawn(councilRow: CouncilRow, seatRow: SeatRow, text: string): Promise<void> {
    if (seatRow.thread_id !== null) {
      await sendText(seatRow.thread_id, text);
      return;
    }
    // Serialize first spawns per council so every seat lands in the same
    // environment instead of each getting a worktree of its own.
    const prev = spawnLocks.get(councilRow.id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const fresh = seat(councilRow.id, seatRow.handle);
      const freshCouncil = council(councilRow.id);
      if (fresh === undefined || freshCouncil === undefined) return;
      if (fresh.thread_id !== null) {
        await sendText(fresh.thread_id, text);
        return;
      }
      const providers = await providerDirectory();
      if (!providers.has(fresh.provider_id)) throw new Error(`unknown provider ${fresh.provider_id}`);
      const thread = await bb.sdk.threads.spawn({
        projectId: freshCouncil.project_id,
        environment:
          freshCouncil.environment_id === null
            ? { type: "project-default" }
            : { type: "reuse", environmentId: freshCouncil.environment_id },
        providerId: fresh.provider_id,
        ...(fresh.model === null ? {} : { model: fresh.model }),
        ...(isReasoningLevel(fresh.reasoning_level) ? { reasoningLevel: fresh.reasoning_level } : {}),
        title: `Council ${freshCouncil.title}: @${fresh.handle}`,
        visibility: "hidden",
        prompt: seatPrompt(freshCouncil, fresh, text),
      });
      q.setSeatThread.run(thread.id, councilRow.id, fresh.handle);
      if (freshCouncil.environment_id === null) {
        const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
        if (environmentId !== null) q.updateCouncilEnvironment.run(environmentId, Date.now(), councilRow.id);
        else bb.log.warn(`thread ${thread.id} has no environment after waiting; later seats may not share a workspace`);
      }
    });
    spawnLocks.set(councilRow.id, run.catch(() => undefined));
    await run;
  }

  async function waitForEnvironment(threadId: string, timeoutMs = 90_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(1500);
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) return thread.environmentId;
      } catch (cause) {
        bb.log.warn(`waiting for environment of ${threadId}: ${errorMessage(cause)}`);
      }
    }
    return null;
  }

  // -- Delivery --------------------------------------------------------------

  async function deliver(councilId: string, handle: string, instruction: string): Promise<string | null> {
    const councilRow = council(councilId);
    const seatRow = seat(councilId, handle);
    if (councilRow === undefined || seatRow === undefined) return `Seat @${handle} or its council no longer exists.`;
    const unseen = (q.messagesAll.all(councilId) as MessageRow[]).filter(
      (m) => m.seq > seatRow.last_seen_seq && m.author !== handle,
    );
    const transcript = unseen
      .map((m) => {
        const label = m.author === "user" ? "MODERATOR" : `@${m.author}`;
        const footer = m.stance !== null ? ` [STANCE: ${m.stance}]` : "";
        return `${label}: ${m.text}${footer}`;
      })
      .join("\n\n");
    const text = [
      instruction,
      "",
      "---",
      "",
      "New messages since you last spoke:",
      transcript.length > 0 ? transcript : "(the question above)",
    ].join("\n");
    q.setSeatSeen.run(currentSeq(councilId), councilId, handle);
    const deliveredAt = Date.now();
    awaiting.set(pendingKey(councilId, handle), { turnsLeft: 0, deliveredAt });
    q.awaitingUpsert.run(councilId, handle, 0, deliveredAt);
    try {
      await sendOrSpawn(councilRow, seatRow, text);
    } catch (cause) {
      awaiting.delete(pendingKey(councilId, handle));
      q.awaitingDelete.run(councilId, handle);
      const message = errorMessage(cause);
      bb.log.warn(`deliver to @${handle} in ${councilId} failed: ${message}`);
      postSystem(councilId, `Could not reach @${handle}: ${message}`);
      return message;
    }
    return null;
  }

  // -- Debate scheduler ------------------------------------------------------

  function latestOpen(councilId: string): string[] {
    let open: string[] = [];
    for (const m of q.messagesAll.all(councilId) as MessageRow[]) {
      const points = parseJsonStrings(m.open_points);
      if (points.length > 0) open = points;
      else if (m.stance === "agree" || m.stance === "pass") open = [];
    }
    return open;
  }

  function consensus(councilId: string): boolean {
    const rows = seats(councilId);
    return rows.length > 0 && rows.every((s) => s.last_stance === "agree" || s.last_stance === "pass") && latestOpen(councilId).length === 0;
  }

  function nextSpeaker(councilId: string, exclude: string | null): string | null {
    const rows = seats(councilId).filter((s) => s.handle !== exclude);
    if (rows.length === 0) return null;
    return (rows.find((s) => s.last_stance === "disagree") ?? rows.find((s) => s.last_stance === null) ?? rows[0]).handle;
  }

  function startJob(councilId: string, question: string, totalTurns: number): void {
    jobs.set(councilId, {
      question,
      totalTurns,
      turn: 0,
      current: null,
      paused: null,
      startedAt: Date.now(),
      controller: new AbortController(),
    });
    setCouncilStatus(councilId, "convened");
  }

  function jobView(councilId: string): Job {
    const job = jobs.get(councilId);
    if (job === undefined) return null;
    return {
      question: job.question,
      totalTurns: job.totalTurns,
      turn: job.turn,
      current: job.current,
      paused: job.paused,
      startedAt: job.startedAt,
    };
  }

  async function askChiefForVerdict(councilId: string): Promise<void> {
    const councilRow = council(councilId);
    if (councilRow === undefined) return;
    const chief = seat(councilId, councilRow.chief);
    if (chief === undefined || chief.thread_id === null) {
      setCouncilStatus(councilId, "verdict");
      postSystem(councilId, "Chief seat never joined; recording the debate as-is as the verdict.");
      return;
    }
    const job = jobs.get(councilId);
    if (job !== undefined) job.current = councilRow.chief;
    publish(councilId);
    await deliver(councilId, councilRow.chief, INSTRUCTION_SYNTHESIS);
    setCouncilStatus(councilId, "verdict");
  }

  async function finishDebate(councilId: string, reason: string): Promise<void> {
    postSystem(councilId, reason);
    jobs.delete(councilId);
    await askChiefForVerdict(councilId);
    publish(councilId);
  }

  async function stepDebate(councilId: string): Promise<void> {
    const job = jobs.get(councilId);
    if (job === undefined || job.controller.signal.aborted) return;
    if (consensus(councilId)) {
      await finishDebate(councilId, "Consensus reached; the chief writes the verdict.");
      return;
    }
    if (job.turn >= job.totalTurns) {
      await finishDebate(councilId, `Turn budget of ${job.totalTurns} exhausted; the chief writes the verdict.`);
      return;
    }
    const handle = nextSpeaker(councilId, job.current);
    if (handle === null) {
      await finishDebate(councilId, "No seats left to speak; the chief writes the verdict.");
      return;
    }
    job.turn += 1;
    job.current = handle;
    const open = latestOpen(councilId);
    const instruction =
      open.length > 0
        ? `The debate continues. Open points on the floor: ${open.join("; ")}. Respond, concede, or refute; then end with your STANCE footer.`
        : "The debate continues. Respond to the newest points, then end with your STANCE footer.";
    publish(councilId);
    await deliver(councilId, handle, instruction);
  }

  // -- Debate operations (shared by RPC and CLI) -----------------------------

  async function opCreate(input: { title: string; projectId: string; seats: SeatInput[]; chief: string; defaultTurns: number }): Promise<CouncilRow> {
    // The CLI and RPC must enforce the same rules before writing any rows.
    const parsed = createCouncilInputSchema.safeParse(input);
    if (!parsed.success) throw new Error(describeInputIssues(parsed.error));
    input = { ...parsed.data, defaultTurns: parsed.data.defaultTurns ?? 8 };
    const providers = await providerDirectory();
    for (const s of input.seats) {
      if (!providers.has(s.providerId)) throw new Error(`Seat @${s.handle}: unknown provider ${s.providerId}`);
    }
    const id = randomId();
    const now = Date.now();
    db.transaction(() => {
      q.insertCouncil.run(id, input.title, input.projectId, null, input.chief, input.defaultTurns, now, now);
      for (const s of input.seats) {
        q.insertSeat.run(id, s.handle, s.providerId, s.model ?? null, s.reasoningLevel ?? null, s.canEdit ? 1 : 0);
      }
      q.markChief.run(id, input.chief);
    })();
    postSystem(id, `Council "${input.title}" created. Seats: ${input.seats.map((s) => `@${s.handle} (${s.providerId})`).join(", ")}. Chief: @${input.chief}.`);
    const row = council(id);
    if (row === undefined) throw new Error("council vanished after create");
    return row;
  }

  async function opConvene(councilId: string, question: string, turns: number): Promise<z.infer<typeof deliveryFailureSchema>[]> {
    if (council(councilId) === undefined) throw new Error(`council ${councilId} not found`);
    if (jobs.has(councilId)) throw new Error("a debate is already running in this council");
    store.appendMessage(councilId, "user", question);
    postSystem(councilId, `Convened with a ${turns}-turn budget.`);
    startJob(councilId, question, turns);
    publish(councilId);
    // The question goes to every seat at once; the chief answers too, then
    // moderates synthesis at the end.
    const deliveries = await Promise.all(seats(councilId).map(async (s) => {
      const error = await deliver(councilId, s.handle, INSTRUCTION_PARALLEL);
      return error === null ? null : { handle: s.handle, error };
    }));
    return deliveries.filter((failure) => failure !== null);
  }

  async function opLaunch(input: z.infer<typeof launchInputSchema>) {
    // Validate the exact four-seat preset on the caller's host before creating
    // anything. A launch never silently drops or substitutes a requested seat.
    const environment = await bb.sdk.environments.get({ environmentId: input.environmentId });
    if (environment.projectId !== input.projectId) throw new Error("The workspace does not belong to the selected project.");
    if (environment.status !== "ready") throw new Error("The workspace is not ready yet.");
    const providers = await bb.sdk.providers.list({ environmentId: input.environmentId });
    for (const providerId of new Set(DEFAULT_SEATS.map((seat) => seat.providerId))) {
      if (!providers.some((provider) => provider.id === providerId && provider.available)) {
        throw new Error(`The four-seat council requires ${providerId}, which is unavailable in this workspace.`);
      }
    }
    const roster: SeatInput[] = [];
    for (const providerId of new Set(DEFAULT_SEATS.map((seat) => seat.providerId))) {
      const catalog = await bb.sdk.providers.models({ providerId, environmentId: input.environmentId });
      for (const seat of DEFAULT_SEATS.filter((seat) => seat.providerId === providerId)) {
        const model = seat.model || catalog.models.find((model) => model.isDefault)?.model;
        if (!model || !catalog.models.some((entry) => entry.model === model)) {
          throw new Error(`Seat @${seat.handle}: ${seat.model || "the default model"} is unavailable from ${providerId}.`);
        }
        roster.push({ ...seat, model });
      }
    }
    roster.sort((a, b) => DEFAULT_SEATS.findIndex((s) => s.handle === a.handle) - DEFAULT_SEATS.findIndex((s) => s.handle === b.handle));
    const turns = input.turns ?? DEFAULT_TURNS;
    const row = await opCreate({
      projectId: input.projectId, title: input.title ?? input.question.replace(/\s+/g, " ").slice(0, 120),
      seats: roster, chief: DEFAULT_CHIEF, defaultTurns: turns,
    });
    q.updateCouncilEnvironment.run(input.environmentId, Date.now(), row.id);
    const failures = await opConvene(row.id, input.question, turns);
    return { council: councilRowToSchema(council(row.id)!), failures };
  }

  async function opSay(councilId: string, text: string): Promise<void> {
    if (council(councilId) === undefined) throw new Error(`council ${councilId} not found`);
    store.appendMessage(councilId, "user", text);
    publish(councilId);
    const job = jobs.get(councilId);
    if (job === undefined) return;
    if (job.paused !== null) {
      job.paused = null;
      setCouncilStatus(councilId, "convened");
      await stepDebate(councilId);
      return;
    }
    // Relay the interjection to the seat currently speaking so it can react.
    if (job.current !== null) await deliver(councilId, job.current, "The moderator interjected:");
  }

  async function opResume(councilId: string): Promise<void> {
    if (council(councilId) === undefined) throw new Error(`council ${councilId} not found`);
    const job = jobs.get(councilId);
    if (job === undefined || job.paused === null) throw new Error("no paused debate in this council");
    job.paused = null;
    setCouncilStatus(councilId, "convened");
    publish(councilId);
    await stepDebate(councilId);
  }

  async function opHalt(councilId: string): Promise<string[]> {
    if (council(councilId) === undefined) throw new Error(`council ${councilId} not found`);
    jobs.get(councilId)?.controller.abort();
    jobs.delete(councilId);
    const stopped: string[] = [];
    for (const s of seats(councilId)) {
      if (s.thread_id === null) continue;
      try {
        await bb.sdk.threads.stop({ threadId: s.thread_id });
        stopped.push(s.handle);
      } catch (cause) {
        bb.log.warn(`halt @${s.handle} failed: ${errorMessage(cause)}`);
      }
    }
    q.awaitingClear.run(councilId);
    setCouncilStatus(councilId, "idle");
    postSystem(councilId, stopped.length === 0 ? "Nothing was running." : `Halted: ${stopped.map((h) => `@${h}`).join(", ")}.`);
    publish(councilId);
    return stopped;
  }

  async function opVerdict(councilId: string): Promise<void> {
    if (council(councilId) === undefined) throw new Error(`council ${councilId} not found`);
    jobs.delete(councilId);
    await askChiefForVerdict(councilId);
    publish(councilId);
  }

  async function opAddSeat(councilId: string, seatInput: SeatInput, brief: Brief): Promise<void> {
    const councilRow = council(councilId);
    if (councilRow === undefined) throw new Error(`council ${councilId} not found`);
    const providers = await providerDirectory();
    if (!providers.has(seatInput.providerId)) throw new Error(`unknown provider ${seatInput.providerId}`);
    q.insertSeat.run(councilId, seatInput.handle, seatInput.providerId, seatInput.model ?? null, seatInput.reasoningLevel ?? null, seatInput.canEdit ? 1 : 0);
    postSystem(councilId, `@${seatInput.handle} joined (${seatInput.providerId}${seatInput.canEdit ? ", may edit files" : ""}).`);
    if (brief !== "none") {
      await deliver(councilId, councilRow.chief, INSTRUCTION_BRIEF(seatInput.handle));
    }
  }

  // -- Events ----------------------------------------------------------------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const seatRow = q.seatByThread.get(thread.id) as SeatRow | undefined;
    if (seatRow === undefined) return;
    const councilId = seatRow.council_id;
    const key = pendingKey(councilId, seatRow.handle);
    const expectation = awaiting.get(key);
    q.setSeatStatus.run(councilId, seatRow.handle, null);
    if (expectation === undefined) return;
    awaiting.delete(key);
    q.awaitingDelete.run(councilId, seatRow.handle);
    let text = lastAssistantText ?? "";
    if (text === "") {
      try {
        text = (await bb.sdk.threads.output({ threadId: thread.id })).output ?? "";
      } catch (cause) {
        bb.log.warn(`output for ${thread.id} failed: ${errorMessage(cause)}`);
      }
    }
    if (text === "") text = "(no reply text)";
    const parsed = parseFooter(text);
    q.setSeatStance.run(parsed.stance, councilId, seatRow.handle);
    store.appendMessage(councilId, seatRow.handle, parsed.body, { stance: parsed.stance, openPoints: parsed.openPoints });
    publish(councilId);
    if (parsed.stance === "need-info") {
      const job = jobs.get(councilId);
      const question = parsed.openPoints[0] ?? "The seat asked for information; answer in the council.";
      if (job !== undefined) {
        job.paused = { handle: seatRow.handle, question };
        setCouncilStatus(councilId, "paused");
      }
      postSystem(councilId, `@${seatRow.handle} needs info: ${question} The debate is paused; answer with 'bb council say'.`);
      return;
    }
    if (jobs.has(councilId)) {
      await stepDebate(councilId);
    }
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const seatRow = q.seatByThread.get(thread.id) as SeatRow | undefined;
    if (seatRow === undefined) return;
    const councilId = seatRow.council_id;
    const key = pendingKey(councilId, seatRow.handle);
    if (!awaiting.has(key)) return;
    awaiting.delete(key);
    q.awaitingDelete.run(councilId, seatRow.handle);
    postSystem(councilId, `@${seatRow.handle} failed: ${error ?? "unknown error"}`);
    if (jobs.has(councilId)) void stepDebate(councilId);
  });

  bb.events.on("thread.active", ({ thread }) => {
    const seatRow = q.seatByThread.get(thread.id) as SeatRow | undefined;
    if (seatRow === undefined) return;
    q.setSeatStatus.run(seatRow.council_id, seatRow.handle, "working");
    publish(seatRow.council_id);
  });

  // -- Row mappers -----------------------------------------------------------

  function councilRowToSchema(row: CouncilRow): Council {
    return {
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      environmentId: row.environment_id,
      chief: row.chief,
      defaultTurns: row.default_turns,
      status: row.status as CouncilStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function seatRowToSchema(row: SeatRow): Seat {
    return {
      handle: row.handle,
      providerId: row.provider_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
      canEdit: row.can_edit === 1,
      isChief: row.is_chief === 1,
      threadId: row.thread_id,
      lastSeenSeq: row.last_seen_seq,
      status: row.status,
      lastStance: (row.last_stance as Stance | null) ?? null,
      turnsUsed: row.turns_used,
    };
  }

  function councilSummary(row: CouncilRow): CouncilSummary {
    const handles = seats(row.id).map((s) => s.handle);
    const msgs = q.messagesAll.all(row.id) as MessageRow[];
    return {
      ...councilRowToSchema(row),
      handles,
      messageCount: msgs.length,
      lastAuthor: msgs[msgs.length - 1]?.author ?? null,
    };
  }

  function councilDetail(councilId: string): CouncilDetail {
    const row = council(councilId);
    if (row === undefined) throw new Error(`council ${councilId} not found`);
    return {
      council: councilRowToSchema(row),
      seats: seats(councilId).map(seatRowToSchema),
      messages: (q.messagesAll.all(councilId) as MessageRow[]).map((m) => ({
        seq: m.seq,
        author: m.author,
        text: m.text,
        stance: (m.stance as Stance | null) ?? null,
        openPoints: parseJsonStrings(m.open_points),
        createdAt: m.created_at,
      })),
      job: jobView(councilId),
    };
  }

  // -- RPC -------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    councils_list: () => ({ councils: (q.councilsAll.all() as CouncilRow[]).map(councilSummary) }),
    councils_create: async (input) => ({ council: councilRowToSchema(await opCreate({ ...input, defaultTurns: input.defaultTurns ?? 8 })) }),
    councils_launch: opLaunch,
    councils_get: (input) => councilDetail(input.councilId),
    councils_convene: async (input) => {
      const row = council(input.councilId);
      if (row === undefined) throw new Error(`council ${input.councilId} not found`);
      await opConvene(input.councilId, input.question, input.turns ?? row.default_turns);
      return { ok: true as const };
    },
    councils_say: async (input) => {
      await opSay(input.councilId, input.text);
      return { ok: true as const };
    },
    councils_resume: async (input) => {
      await opResume(input.councilId);
      return { ok: true as const };
    },
    councils_halt: async (input) => ({ stopped: await opHalt(input.councilId) }),
    councils_verdict: async (input) => {
      await opVerdict(input.councilId);
      return { ok: true as const };
    },
    councils_add_seat: async (input) => {
      await opAddSeat(input.councilId, input.seat, input.brief ?? "summary");
      return { ok: true as const };
    },
    councils_archive: (input) => {
      if (council(input.councilId) === undefined) throw new Error(`council ${input.councilId} not found`);
      q.archiveCouncil.run(Date.now(), Date.now(), input.councilId);
      publish(input.councilId);
      return { ok: true as const };
    },
    context_options: async () => {
      const providers: ProviderOption[] = [];
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      for (const provider of await bb.sdk.providers.list()) {
        let models: ProviderOption["models"] = [];
        try {
          const result = await bb.sdk.providers.models({ providerId: provider.id });
          models = result.models.map((m) => ({ model: m.model, displayName: m.displayName, isDefault: m.isDefault }));
        } catch (cause) {
          bb.log.warn(`models for ${provider.id} failed: ${errorMessage(cause)}`);
        }
        providers.push({ id: provider.id, displayName: provider.displayName, available: provider.available, models, reasoningLevels: [...REASONING_LEVELS] });
      }
      return {
        projects: projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind })),
        providers,
      };
    },
  });

  // -- CLI -------------------------------------------------------------------

  function parseSeatEntry(entry: string): SeatInput | null {
    const [head, flag] = entry.split(":");
    const [handle, providerId, model] = head.split("=");
    if (!handle || !providerId || !HANDLE_RE.test(handle)) return null;
    if (flag !== undefined && flag !== "edit") return null;
    return { handle, providerId, ...(model ? { model } : {}), canEdit: flag === "edit" };
  }

  function parseSeatList(raw: string): SeatInput[] | null {
    const seats: SeatInput[] = [];
    for (const entry of raw.split(",")) {
      const parsed = parseSeatEntry(entry.trim());
      if (parsed === null) return null;
      seats.push(parsed);
    }
    return seats;
  }

  function clampTurns(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MAX_TURNS, Math.max(2, Math.trunc(parsed)));
  }

  // -- CLI -------------------------------------------------------------------

  const CLI_USAGE = [
    "usage: bb council <command> [args]",
    "",
    "commands:",
    "  list                                  list councils",
    "  show <id> [--since N]                 print the transcript",
    "  create --title T --project ID --seats h=provider[=model][:edit],... [--chief h] [--turns N]",
    "  convene <id> [--turns N] <question>   start the debate",
    "  say <id> <message>                    post as the moderator (answers need-info)",
    "  resume <id>                           resume a paused debate",
    "  halt <id>                             stop every running seat",
    "  verdict <id>                          end the debate; chief synthesizes",
    "  add <id> h=provider[=model][:edit]    add a seat",
    "  archive <id>                          archive a council",
  ].join("\n");

  function cliText(text: string): PluginCliResult {
    return { exitCode: 0, stdout: text };
  }

  function cliFail(text: string): PluginCliResult {
    return { exitCode: 1, stderr: text };
  }

  function parseArgv(argv: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
    const command = argv[0] ?? "";
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 1; i < argv.length; i += 1) {
      const token = argv[i];
      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        if (eq > 0) {
          flags[token.slice(2, eq)] = token.slice(eq + 1);
          continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[token.slice(2)] = next;
          i += 1;
        } else {
          flags[token.slice(2)] = "true";
        }
        continue;
      }
      positional.push(token);
    }
    return { command, positional, flags };
  }

  async function cliRun(councilId: string, action: (id: string) => Promise<unknown>, done: string): Promise<PluginCliResult> {
    if (council(councilId) === undefined) return cliFail(`no council ${councilId}`);
    await action(councilId);
    return cliText(done);
  }

  async function dispatchCli(argv: string[]): Promise<PluginCliResult> {
    const { command, positional, flags } = parseArgv(argv);
    switch (command) {
      case "list": {
        const rows = q.councilsAll.all() as CouncilRow[];
        if (rows.length === 0) return cliText("No councils yet. Create one: bb council create ...");
        return cliText(
          rows
            .map((row) => {
              const handles = seats(row.id)
                .map((s) => `@${s.handle}${s.is_chief ? "*" : ""}`)
                .join(", ");
              return `${row.id}  ${row.title}  [${row.status}]  ${handles}`;
            })
            .join("\n"),
        );
      }
      case "show": {
        const id = positional[0] ?? "";
        if (council(id) === undefined) return cliFail(`no council ${id}`);
        const since = Number(flags.since ?? 0);
        const lines = (q.messagesAll.all(id) as MessageRow[])
          .filter((m) => m.seq > (Number.isFinite(since) ? since : 0))
          .map((m) => {
            const footer = m.stance !== null ? ` [STANCE: ${m.stance}]` : "";
            return `#${m.seq} ${m.author}: ${m.text}${footer}`;
          });
        return cliText(lines.join("\n"));
      }
      case "create": {
        const title = flags.title;
        const projectId = flags.project;
        if (!title || !projectId || !flags.seats) {
          return cliFail("create needs --title, --project, and --seats h=provider[=model][:edit],...");
        }
        const seatInputs = parseSeatList(flags.seats);
        if (seatInputs === null) return cliFail(`bad --seats '${flags.seats}'`);
        const chief = flags.chief ?? seatInputs[0].handle;
        const row = await opCreate({ title, projectId, seats: seatInputs, chief, defaultTurns: clampTurns(flags.turns, 8) });
        return cliText(`Created council ${row.id} ("${row.title}") with chief @${chief}`);
      }
      case "convene": {
        const id = positional[0] ?? "";
        const question = positional.slice(1).join(" ").trim();
        if (question === "") return cliFail("convene needs a question");
        const row = council(id);
        if (row === undefined) return cliFail(`no council ${id}`);
        await opConvene(id, question, clampTurns(flags.turns, row.default_turns));
        return cliText(`Convened ${id}; the debate is running (watch with 'bb council show ${id}').`);
      }
      case "say": {
        const id = positional[0] ?? "";
        const text = positional.slice(1).join(" ").trim();
        if (text === "") return cliFail("say needs a message");
        return cliRun(id, (councilId) => opSay(councilId, text), "Posted; the debate resumes if it was paused.");
      }
      case "resume":
        return cliRun(positional[0] ?? "", (councilId) => opResume(councilId), "Resumed.");
      case "halt": {
        const stopped = await opHalt(positional[0] ?? "").catch(() => []);
        return cliText(`Halted: ${stopped.map((h) => `@${h}`).join(", ") || "nothing was running"}`);
      }
      case "verdict":
        return cliRun(positional[0] ?? "", (councilId) => opVerdict(councilId), "Verdict requested.");
      case "add": {
        const id = positional[0] ?? "";
        const entry = parseSeatEntry(positional[1] ?? "");
        if (entry === null) return cliFail("add needs a seat entry like codex=acp-codex:edit");
        const brief = (flags.brief as Brief | undefined) ?? "summary";
        return cliRun(id, (councilId) => opAddSeat(councilId, entry, brief), `Added @${entry.handle}.`);
      }
      case "archive": {
        const id = positional[0] ?? "";
        if (council(id) === undefined) return cliFail(`no council ${id}`);
        jobs.delete(id);
        q.archiveCouncil.run(Date.now(), Date.now(), id);
        publish(id);
        return cliText("Archived.");
      }
      default:
        return cliFail(CLI_USAGE);
    }
  }

  bb.cli.register({
    name: "council",
    summary: "Councils of several agents debating one problem to a verdict",
    commands: [
      { name: "list", summary: "List councils", usage: "bb council list" },
      { name: "show", summary: "Print the transcript", usage: "bb council show <id> [--since N]" },
      { name: "create", summary: "Create a council", usage: "bb council create --title T --project ID --seats h=provider[=model][:edit],... [--chief h] [--turns N]" },
      { name: "convene", summary: "Start the debate", usage: "bb council convene <id> [--turns N] <question...>" },
      { name: "say", summary: "Post as the moderator", usage: "bb council say <id> <message...>" },
      { name: "resume", summary: "Resume a paused debate", usage: "bb council resume <id>" },
      { name: "halt", summary: "Stop every running seat", usage: "bb council halt <id>" },
      { name: "verdict", summary: "End the debate; chief synthesizes", usage: "bb council verdict <id>" },
      { name: "add", summary: "Add a seat", usage: "bb council add <id> h=provider[=model][:edit]" },
      { name: "archive", summary: "Archive a council", usage: "bb council archive <id>" },
    ],
    run(argv, ctx) {
      void ctx;
      return dispatchCli(argv);
    },
  });

  bb.log.info("loaded");
}
