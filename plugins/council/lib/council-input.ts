import { z } from "zod";

export const HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const handleSchema = z.string().regex(HANDLE_RE,
  "Use 1–24 lowercase letters, digits, or dashes, starting with a letter.");
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MAX_TURNS = 40;
export const turnsSchema = z.number().int().min(2).max(MAX_TURNS);
export const seatInputSchema = z.object({
  handle: handleSchema,
  providerId: z.string().min(1, "Choose a provider."),
  model: z.string().min(1).nullable().optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable().optional(),
  canEdit: z.boolean().optional(),
});

export const createCouncilInputSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120, "Keep the title to 120 characters or fewer."),
  projectId: z.string().min(1, "Choose a project."),
  seats: z.array(seatInputSchema).min(2, "Add at least two seats.").max(8, "Use at most eight seats."),
  chief: handleSchema,
  defaultTurns: turnsSchema.optional(),
}).superRefine((input, context) => {
  const handles = new Set<string>();
  input.seats.forEach((seat, index) => {
    if (handles.has(seat.handle)) context.addIssue({
      code: "custom", path: ["seats", index, "handle"], message: `@${seat.handle} is already used. Give each seat a different handle.`,
    });
    handles.add(seat.handle);
  });
  if (!handles.has(input.chief)) context.addIssue({
    code: "custom", path: ["chief"], message: "Choose one of the current seats to write the verdict.",
  });
});

export function describeInputIssues(error: { issues: readonly { path?: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => {
    const [field, index, seatField] = issue.path ?? [];
    const label = field === "seats" && typeof index === "number"
      ? `Seat ${index + 1}${seatField ? ` ${String(seatField)}` : ""}`
      : ({ title: "Title", projectId: "Project", seats: "Seats", chief: "Chief", defaultTurns: "Turn budget" }[String(field)] ?? String(field));
    return `${label}: ${issue.message}`;
  }).join("\n");
}
