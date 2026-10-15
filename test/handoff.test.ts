import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { firstUserMessage, handoffMessage, handoffPrompt, readHandoffConfig } from "../src/handoff.ts";

const cache = join(import.meta.dirname, "../.cache/test");

const config = (text: string) => {
	mkdirSync(cache, { recursive: true });
	const path = join(mkdtempSync(join(cache, "config-")), "pi-side-chat.json");
	writeFileSync(path, text);
	return readHandoffConfig(path);
};

describe("readHandoffConfig", () => {
	it("keeps the side conversation's own model and thinking level unless set", () => {
		expect(readHandoffConfig("/nonexistent/pi-side-chat.json")).toEqual({});
		expect(config('{ "handoff": { "model": null, "thinking": null } }')).toEqual({});
		expect(config('{ "handoff": { "thinking": "low" } }')).toEqual({ thinking: "low" });
	});

	it("splits the provider from a model id that may contain slashes", () => {
		expect(config('{ "handoff": { "model": "nv/azure/claude" } }')).toEqual({ model: { provider: "nv", id: "azure/claude" } });
		expect(() => config('{ "handoff": { "model": "claude" } }')).toThrow(/provider\/model/);
	});
});

describe("handoffPrompt", () => {
	it("asks for proper-compact's headings, in order", () => {
		const headings = [...handoffPrompt().matchAll(/^## (.+)$/gm)].map((match) => match[1]);
		expect(headings).toEqual([
			"Goal",
			"Constraints & Preferences",
			"Progress",
			"Key Decisions",
			"Next Steps",
			"Critical Context",
			"Artifacts and Evidence",
		]);
	});

	it("quotes the message the side conversation began with, on one line and cut short", () => {
		expect(handoffPrompt()).not.toContain("It began with");
		expect(handoffPrompt('why does "x"\n  fail?')).toContain(`It began with the user's message "why does \\"x\\" fail?".`);
		expect(handoffPrompt("a".repeat(300))).toContain(`message "${"a".repeat(200)}\u2026".`);
	});
});

describe("firstUserMessage", () => {
	it("takes the text of the first user message", () => {
		const session = SessionManager.inMemory("/project");
		session.appendCustomMessageEntry("side-chat", "hidden", false);
		session.appendMessage({
			role: "user",
			content: [
				{ type: "image", data: "", mimeType: "image/png" },
				{ type: "text", text: "what is in this image?" },
			],
			timestamp: Date.now(),
		});
		session.appendMessage({ role: "user", content: "and this one?", timestamp: Date.now() });

		expect(firstUserMessage(session.getEntries())).toBe("what is in this image?");
		expect(firstUserMessage([])).toBeUndefined();
	});
});

describe("handoffMessage", () => {
	it("tells the main thread where the handoff comes from", () => {
		const message = handoffMessage("  Found X.\n", "2026-10-12T10:00:00.000Z");
		expect(message.startsWith("<side_handoff>\n")).toBe(true);
		expect(message).toContain("forked from this thread at 2026-10-12T10:00:00.000Z");
		expect(message.endsWith("\nFound X.\n</side_handoff>")).toBe(true);
	});
});
