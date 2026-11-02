// Smoke-project reset (side-effect free — imported by smoke.ts and its test).
// The smoke project is fixed-name and reset on every run: any previous
// project with the same name is hard-deleted (DELETE cascades to every
// row the project owns) before a fresh one is created.
export const SMOKE_PROJECT_NAME = 'Test - Twelve Data';
/** The run exercises every connector target, including Meta Muse (v1). */
export const SMOKE_TARGETS = ['mcp', 'openai', 'muse'];

/** Ids of existing projects carrying the smoke name — deleted at startup. */
export function smokeResetIds(projects: Array<{ id: string; name: string }>): string[] {
  return projects.filter((p) => p?.name === SMOKE_PROJECT_NAME).map((p) => p.id);
}
