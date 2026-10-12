import { randomUUID } from "node:crypto";
import type { CustomMessageEntry, FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS, TURN_ABORTED_MARKER } from "./codex.ts";

/** Custom type of the hidden messages that the side conversation adds after the inherited history. */
export const SIDE_MESSAGE_TYPE = "side-chat";

/** The hidden message that opens a side conversation: Codex's side instructions followed by its boundary prompt. */
export const SIDE_OPENING = `${SIDE_DEVELOPER_INSTRUCTIONS}\n\n${SIDE_BOUNDARY_PROMPT}`;

/**
 * Whether the conversation on this branch has started, which Codex requires before `/side`.
 */
export function hasStarted(branch: readonly SessionEntry[]): boolean {
	return branch.some((entry) => entry.type === "message" && entry.message.role === "user");
}

/** What the opening message of a side conversation records about where it was forked from. */
export interface SideOrigin {
	parentSessionId: string;
}

/**
 * The parent session a side conversation was forked from, if these entries belong to one. A side
 * conversation of a side conversation also carries its parent's opening, so the last one counts.
 */
export function sideOrigin(entries: readonly SessionEntry[]): SideOrigin | undefined {
	for (const entry of [...entries].reverse()) {
		if (entry.type === "custom_message" && entry.customType === SIDE_MESSAGE_TYPE && entry.details) {
			return entry.details as SideOrigin;
		}
	}
	return undefined;
}

/**
 * The session file of a side conversation forked from `branch`, with its own `header` first.
 *
 * It keeps everything the model sees. Extension state entries (`custom`)
 * are dropped so that extensions in the side conversation start fresh instead of resuming the parent's
 * loops and plans. Compactions that kept history from a dropped entry keep it from the next kept entry,
 * which contributes the same messages. A turn still running in the parent is marked as interrupted, as
 * Codex does, and the side instructions come last, ready for the first side message.
 */
export function forkSide(
	header: SessionHeader,
	branch: readonly SessionEntry[],
	midTurn: boolean,
	origin: SideOrigin,
): FileEntry[] {
	const kept = branch.filter((entry) => entry.type !== "custom");
	const keptAfter = new Map<string, string | undefined>();
	let next: string | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom") next = entry.id;
		keptAfter.set(entry.id, next);
	}

	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	const append = (entry: SessionEntry) => {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	};
	for (const entry of kept) {
		if (entry.type === "compaction") {
			append({ ...entry, firstKeptEntryId: keptAfter.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId });
		} else {
			append(entry);
		}
	}
	if (midTurn) append(hiddenMessage(TURN_ABORTED_MARKER, entries));
	append({ ...hiddenMessage(SIDE_OPENING, entries), details: origin });
	return [header, ...entries];
}

function hiddenMessage(content: string, existing: readonly SessionEntry[]): CustomMessageEntry {
	const ids = new Set(existing.map((entry) => entry.id));
	let id: string;
	do id = randomUUID().slice(0, 8);
	while (ids.has(id));
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: SIDE_MESSAGE_TYPE,
		content,
		display: false,
	};
}
