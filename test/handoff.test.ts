import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handoffMessage, readHandoffConfig } from "../src/handoff.ts";

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

describe("handoffMessage", () => {
	it("tells the main thread where the handoff comes from", () => {
		const message = handoffMessage("  Found X.\n", "2026-10-12T10:00:00.000Z");
		expect(message.startsWith("<side_handoff>\n")).toBe(true);
		expect(message).toContain("forked from this thread at 2026-10-12T10:00:00.000Z");
		expect(message.endsWith("\nFound X.\n</side_handoff>")).toBe(true);
	});
});
