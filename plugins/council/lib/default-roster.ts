// Shared by the create form and the /council launcher.
export const DEFAULT_CHIEF = "glm";
export const DEFAULT_TURNS = 8;
export const DEFAULT_SEATS = [
  { handle: "glm", providerId: "acp-omp", model: "webster/glm-5.3-flash", canEdit: true },
  { handle: "codex", providerId: "codex", model: "", canEdit: false },
  { handle: "claude", providerId: "claude-code", model: "", canEdit: false },
  { handle: "dsv4", providerId: "acp-omp", model: "webster/deepseek-v4-flash", canEdit: true },
] as const;
