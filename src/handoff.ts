import { existsSync, readFileSync } from "node:fs";

/** What the side conversation is asked to write when the user hands it off to the main thread. */
export const HANDOFF_PROMPT = `The user is closing this side conversation and returning to the main thread. Write a handoff for the main thread's agent.

The main thread's agent already knows everything before the side conversation boundary. It has seen nothing after it, and the main thread may have moved on since. Report only what it needs from this side conversation:
- What the user asked or explored here, and what was found or concluded, with the evidence that matters: exact file paths, commands, numbers and error messages.
- Decisions, preferences, corrections and requests the user stated here. Quote the user's words when they direct future work.
- What this side conversation changed: files edited, commands with side effects, processes started. Write "No changes." if nothing was changed.
- Questions the user left open.

Leave out what the main thread already knows, how the side conversation worked, and pleasantries. Do not plan work the user did not ask for, and do not call tools. Use short sections and omit empty ones. Write in the language the user used here.`;

/** The message that brings a handoff into the main thread. */
export function handoffMessage(handoff: string, forkedAt: string): string {
	return [
		"<side_handoff>",
		`The user just closed a side conversation forked from this thread at ${forkedAt} and handed its outcome back. It saw this thread only up to the fork. Requests and decisions it attributes to the user come from the user. The rest is its report.`,
		"",
		handoff.trim(),
		"</side_handoff>",
	].join("\n");
}

/** Which model writes the handoff. Anything left out is the side conversation's own. */
export interface HandoffConfig {
	model?: { provider: string; id: string };
	thinking?: string;
}

/**
 * Reads the handoff settings from `path`, a JSON file such as
 * `{ "handoff": { "model": "openai-codex/gpt-6-astra", "thinking": "low" } }`. A missing file,
 * or null for a setting, keeps the side conversation's own.
 */
export function readHandoffConfig(path: string): HandoffConfig {
	if (!existsSync(path)) return {};
	const settings = JSON.parse(readFileSync(path, "utf8")) as {
		handoff?: { model?: string | null; thinking?: string | null };
	};
	const { model, thinking } = settings.handoff ?? {};
	const config: HandoffConfig = {};
	if (model) {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new Error(`handoff.model in ${path} must look like "provider/model", not "${model}"`);
		}
		config.model = { provider: model.slice(0, slash), id: model.slice(slash + 1) };
	}
	if (thinking) config.thinking = thinking;
	return config;
}
