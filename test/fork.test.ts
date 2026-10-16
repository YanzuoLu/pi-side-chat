import { buildSessionContext, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { TURN_ABORTED_MARKER } from "../src/codex.ts";
import { forkSide, hasStarted, SIDE_OPENING, sideOpening, sideOrigin } from "../src/fork.ts";

/** A parent session with extension state between messages and a compaction that kept history from such state. */
function parent() {
	const session = SessionManager.inMemory("/project", { id: "parent-id" });
	const at = (role: "user" | "assistant", text: string) =>
		role === "user"
			? session.appendMessage({ role, content: text, timestamp: Date.now() })
			: session.appendMessage({
					role,
					content: [{ type: "text", text }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				});
	at("user", "first question");
	session.appendCustomEntry("loop", { intervalMs: 60_000 });
	at("assistant", "first answer");
	const keptState = session.appendCustomEntry("plan", { steps: [] });
	at("user", "second question");
	at("assistant", "second answer");
	session.appendCompaction("summary of the first exchange", keptState, 1000);
	session.appendCustomEntry("plan", { steps: ["x"] });
	at("user", "third question");
	return session;
}

const sideHeader = { type: "session" as const, version: 3, id: "side-id", timestamp: "", cwd: "/project" };
const fork = (session: SessionManager, midTurn = false) =>
	forkSide(sideHeader, session.getBranch(), midTurn, { parentSessionId: session.getSessionId() });

const llmView = (entries: SessionEntry[]) =>
	buildSessionContext(entries).messages.map((message) => JSON.stringify(message));

describe("forkSide", () => {
	it("has its own header and keeps everything the model sees, without extension state", () => {
		const session = parent();
		const [header, ...entries] = fork(session) as [{ id: string }, ...SessionEntry[]];

		expect(header.id).toBe("side-id");
		expect(sideOrigin(entries)).toEqual({ parentSessionId: "parent-id" });
		expect(sideOrigin(session.getBranch())).toBeUndefined();
		expect(entries.some((entry) => entry.type === "custom")).toBe(false);
		entries.forEach((entry, index) => expect(entry.parentId).toBe(entries[index - 1]?.id ?? null));
		expect(llmView(entries).slice(0, -1)).toEqual(llmView(session.getBranch()));
	});

	it("is named by its own session id instead of the parent's name", () => {
		const session = parent();
		session.appendSessionInfo("main thread");
		const entries = fork(session).slice(1) as SessionEntry[];
		const names = entries.flatMap((entry) => (entry.type === "session_info" ? [entry.name] : []));

		expect(names).toEqual(["side-id"]);
		entries.forEach((entry, index) => expect(entry.parentId).toBe(entries[index - 1]?.id ?? null));
	});

	it("keeps compacted history from the entry after a dropped one", () => {
		const session = parent();
		const entries = fork(session).slice(1) as SessionEntry[];
		const compaction = entries.find((entry) => entry.type === "compaction")!;
		const kept = entries.find((entry) => entry.id === compaction.firstKeptEntryId);

		expect(kept?.type === "message" && kept.message.role).toBe("user");
		expect(llmView(entries)).toHaveLength(llmView(session.getBranch()).length + 1);
	});

	it("ends with the hidden side instructions, after an interrupted marker when the parent is mid-turn", () => {
		const session = parent();
		const hidden = (midTurn: boolean) =>
			(fork(session, midTurn).slice(1) as SessionEntry[])
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.type === "custom_message" && !entry.display && entry.content);

		expect(hidden(false)).toEqual([SIDE_OPENING]);
		expect(hidden(true)).toEqual([TURN_ABORTED_MARKER, SIDE_OPENING]);
	});
});

describe("sideOpening", () => {
	it("is the last side opening, which a side conversation of a side conversation adds", () => {
		const side = fork(parent()).slice(1) as SessionEntry[];
		const nested = forkSide({ ...sideHeader, id: "nested-id" }, side, false, { parentSessionId: "side-id" }).slice(1) as SessionEntry[];

		expect(sideOpening(side)).toBe(side.at(-1));
		expect(sideOpening(nested)?.id).toBe(nested.at(-1)!.id);
		expect(sideOrigin(nested)).toEqual({ parentSessionId: "side-id" });
		expect(sideOpening(parent().getBranch())).toBeUndefined();
	});
});

describe("hasStarted", () => {
	it("needs a user message", () => {
		expect(hasStarted(parent().getBranch())).toBe(true);
		expect(hasStarted(SessionManager.inMemory("/project").getBranch())).toBe(false);
	});
});
