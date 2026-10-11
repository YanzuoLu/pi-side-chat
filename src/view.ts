/**
 * The side conversation's transcript, drawn by Pi's own interactive mode.
 *
 * Pi has no extension API for a second transcript, so this module reaches into its interactive mode.
 * Everything that depends on those internals stays here: if a Pi release changes them, the checks in
 * `findInteractiveMode` fail loudly instead of drawing something different.
 */
import { type AssistantMessage, type AssistantMessageEvent, parseStreamingJson } from "@earendil-works/pi-ai";
import { InteractiveMode, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { SideEvent } from "./child.ts";

type Editor = {
	onSubmit?: (text: string) => void | Promise<void>;
	addToHistory?: (text: string) => void;
	isShowingAutocomplete?: () => boolean;
};

/** The parts of Pi's interactive mode this module uses. */
type Interactive = {
	ui: { requestRender(force?: boolean): void; focusedComponent: unknown };
	documentContainer: Container;
	chatContainer: Container;
	editor: Editor;
	handleEvent(event: unknown): Promise<void>;
	showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void;
};

/** Session events that change the transcript. The parent keeps the status, footer and editor. */
const TRANSCRIPT_EVENTS = new Set([
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

/** Finds Pi's interactive mode behind `ctx.ui`, which forwards status updates to it. */
export function findInteractiveMode(ctx: ExtensionContext, statusKey: string): Interactive {
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const setStatus = prototype.setExtensionStatus!;
	let found: unknown;
	prototype.setExtensionStatus = function (this: unknown, ...args: unknown[]) {
		found = this;
		return setStatus.apply(this, args);
	};
	try {
		ctx.ui.setStatus(statusKey, undefined);
	} finally {
		prototype.setExtensionStatus = setStatus;
	}
	const mode = found as Partial<Interactive> | undefined;
	if (
		!mode ||
		!(mode.chatContainer instanceof Container) ||
		!mode.documentContainer?.children.includes(mode.chatContainer) ||
		typeof mode.handleEvent !== "function" ||
		typeof mode.showExtensionNotify !== "function" ||
		!mode.editor ||
		!mode.ui
	) {
		throw new Error("pi-side-chat does not support this version of Pi's interactive mode");
	}
	return mode as Interactive;
}

/**
 * A transcript that takes the place of Pi's chat while it is shown.
 *
 * Pi's own event handler draws it, through an object that inherits everything from the interactive
 * mode but keeps its own chat, streaming state and session view. Messages, tool calls and their
 * extension renderers therefore look exactly as they do in the parent.
 */
export class SideTranscript {
	readonly chat = new Container();
	private readonly renderer: Interactive;
	private readonly entries: SessionEntry[];
	private drawing = Promise.resolve();
	private readonly message = new StreamingMessage();
	private parentSubmit: Editor["onSubmit"];
	private shown = false;

	/**
	 * @param entries the side session so far, which notices such as cache misses compare against
	 */
	constructor(private readonly mode: Interactive, entries: readonly SessionEntry[], cwd: string) {
		this.entries = [...entries];
		// Keep whatever an extension changed about drawing the chat, such as grouping tool calls.
		const parentChat = mode.chatContainer as unknown as Record<string, unknown>;
		if (Object.hasOwn(parentChat, "render")) (this.chat as unknown as Record<string, unknown>).render = parentChat.render;
		const session = { getEntries: () => this.entries, getBranch: () => this.entries, getCwd: () => cwd };
		// Own properties, since some of these are getters on the interactive mode.
		const own = (value: unknown) => ({ value, writable: true });
		this.renderer = Object.create(mode, {
			chatContainer: own(this.chat),
			pendingTools: own(new Map()),
			streamingComponent: own(undefined),
			streamingMessage: own(undefined),
			sessionManager: own(session),
		}) as Interactive;
	}

	get visible(): boolean {
		return this.shown;
	}

	/** Whether the editor has focus without a popup, so keys reach the conversation rather than a dialog. */
	get editorFocused(): boolean {
		return this.mode.ui.focusedComponent === this.mode.editor && !this.mode.editor.isShowingAutocomplete?.();
	}

	/** Draws one event from the side session, in order. */
	draw(event: SideEvent): void {
		if (!TRANSCRIPT_EVENTS.has(event.type)) return;
		const drawn = this.message.track(event);
		this.drawing = this.drawing.then(async () => {
			await this.renderer.handleEvent(drawn);
			if (event.type === "message_end") this.record(event.message);
		});
	}

	/** Shows a notification in the side transcript, after the events drawn so far. */
	notify(message: string, type: "info" | "warning" | "error"): void {
		this.drawing = this.drawing.then(() => this.renderer.showExtensionNotify(message, type));
	}

	/** Shows the side transcript in place of the parent's chat, with the editor submitting to `submit`. */
	show(submit: (text: string) => void): void {
		if (this.shown) return;
		this.shown = true;
		this.swap(this.mode.chatContainer, this.chat);
		this.parentSubmit = this.mode.editor.onSubmit;
		this.mode.editor.onSubmit = (text) => {
			if (text.trim()) this.mode.editor.addToHistory?.(text.trim());
			submit(text);
		};
	}

	/** Brings the parent's chat and editor back. */
	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.swap(this.chat, this.mode.chatContainer);
		this.mode.editor.onSubmit = this.parentSubmit;
	}

	private swap(from: Container, to: Container): void {
		const children = this.mode.documentContainer.children;
		children[children.indexOf(from)] = to;
		this.mode.ui.requestRender(true);
	}

	private record(message: unknown): void {
		const previous = this.entries.at(-1);
		this.entries.push({
			type: "message",
			id: `side-${this.entries.length}`,
			parentId: previous?.id ?? null,
			timestamp: new Date().toISOString(),
			message,
		} as SessionEntry);
	}
}

type Delta = Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>;
type WithoutPartial<T> = T extends unknown ? Omit<T, "partial"> : never;
type WireDelta = WithoutPartial<Delta> & { id?: string; toolName?: string };

/**
 * The assistant message being streamed, rebuilt from the deltas that Pi's RPC mode sends instead
 * of the whole message on every update.
 */
class StreamingMessage {
	private message: AssistantMessage | undefined;
	private readonly toolArguments = new Map<number, string>();

	/** The event as Pi's interactive mode receives it in-process. */
	track(event: SideEvent): SideEvent {
		if (event.type === "message_start") {
			const message = event.message as { role: string };
			this.message = message.role === "assistant" ? structuredClone(message as AssistantMessage) : undefined;
			this.toolArguments.clear();
			return event;
		}
		if (event.type === "message_end") {
			this.message = undefined;
			return event;
		}
		if (event.type !== "message_update" || !this.message) return event;
		this.apply(this.message, event.assistantMessageEvent as WireDelta);
		this.message.usage = event.usage as AssistantMessage["usage"];
		return { ...event, message: this.message };
	}

	private apply(message: AssistantMessage, delta: WireDelta): void {
		if (!("contentIndex" in delta)) return;
		const content = message.content as unknown[];
		const index = delta.contentIndex;
		switch (delta.type) {
			case "text_start":
				content[index] = { type: "text", text: "" };
				break;
			case "text_delta":
				(content[index] as { text: string }).text += delta.delta;
				break;
			case "text_end":
				(content[index] as { text: string }).text = delta.content;
				break;
			case "thinking_start":
				content[index] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				(content[index] as { thinking: string }).thinking += delta.delta;
				break;
			case "thinking_end":
				(content[index] as { thinking: string }).thinking = delta.content;
				break;
			case "toolcall_start":
				content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
				this.toolArguments.set(index, "");
				break;
			case "toolcall_delta": {
				const json = (this.toolArguments.get(index) ?? "") + delta.delta;
				this.toolArguments.set(index, json);
				(content[index] as { arguments: unknown }).arguments = parseStreamingJson(json);
				break;
			}
			case "toolcall_end":
				content[index] = delta.toolCall;
				break;
		}
	}
}
