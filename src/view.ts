/**
 * The side conversation's view, drawn by Pi's own interactive mode.
 *
 * Like switching threads in Codex, showing the side conversation swaps everything that belongs to a
 * conversation: the transcript, the working and compaction indicators, the footer and the editor's
 * draft. Pi has no extension API for a second conversation view, so this module reaches into its
 * interactive mode. Everything that depends on those internals stays here: if a Pi release changes
 * them, the checks in `findInteractiveMode` fail loudly instead of drawing something different.
 */
import {
	type ContextUsage,
	type ExtensionContext,
	type FileEntry,
	InteractiveMode,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { SideEvent, SideState } from "./child.ts";
import { StreamingMessage } from "./stream.ts";

type Editor = Component & {
	onSubmit?: (text: string) => void | Promise<void>;
	addToHistory?: (text: string) => void;
	isShowingAutocomplete?: () => boolean;
	getText(): string;
	setText(text: string): void;
	embedWorkingStatus?: boolean;
	workingStatusIndicator?: Indicator;
	setWorkingStatusIndicator?: (indicator: Indicator | undefined) => void;
};

type Indicator = Component & { dispose(): void };

type FooterData = {
	getGitBranch(): string | null;
	getAvailableProviderCount(): number;
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

/** The parts of Pi's interactive mode this module uses. */
type Interactive = {
	ui: { requestRender(force?: boolean): void; focusedComponent: unknown };
	session: object & { autoCompactionEnabled: boolean };
	documentContainer: Container;
	chatContainer: Container;
	statusContainer: Container;
	footerContainer: Container;
	footer: Component;
	footerDataProvider: FooterData;
	editor: Editor;
	activeStatusIndicator?: Indicator;
	handleEvent(event: unknown): Promise<void>;
	showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void;
	setEditorWorkingStatusIndicator(indicator: Indicator | undefined): boolean;
};

type SetIndicator = Interactive["setEditorWorkingStatusIndicator"];

/** Session events that Pi's interactive mode draws for the side conversation. */
const DRAWN_EVENTS = new Set([
	"agent_start",
	"turn_start",
	"agent_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"entry_appended",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
]);

/** Events drawn from the side session's stored entries, which must include the new entry first. */
const DRAWN_FROM_ENTRIES = new Set(["entry_appended", "compaction_end"]);

/** Events after which the side session has stored new entries or changed what the footer shows. */
const CHANGING_EVENTS = new Set(["message_end", "agent_end", "compaction_end", "entry_appended"]);

const setIndicator = (InteractiveMode.prototype as unknown as { setEditorWorkingStatusIndicator: SetIndicator })
	.setEditorWorkingStatusIndicator;

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
	const writable = (key: string) => Object.getOwnPropertyDescriptor(mode, key)?.writable === true;
	if (
		!mode ||
		!(mode.chatContainer instanceof Container) ||
		!mode.documentContainer?.children.includes(mode.chatContainer) ||
		!(mode.statusContainer instanceof Container) ||
		!(mode.footerContainer instanceof Container) ||
		!writable("statusContainer") ||
		!writable("footerContainer") ||
		typeof mode.footer?.render !== "function" ||
		typeof mode.footerDataProvider?.getExtensionStatuses !== "function" ||
		typeof mode.handleEvent !== "function" ||
		typeof mode.showExtensionNotify !== "function" ||
		typeof setIndicator !== "function" ||
		typeof mode.editor?.getText !== "function" ||
		typeof mode.editor.setText !== "function" ||
		!mode.session ||
		!mode.ui
	) {
		throw new Error("pi-side-chat does not support this version of Pi's interactive mode");
	}
	return mode as Interactive;
}

/** A container in Pi's layout that shows either the parent's content or the side conversation's. */
class Slot {
	private readonly layout: Container;
	private readonly parent = new Container();

	/** From now on the parent draws into its own container, which this slot shows until told otherwise. */
	constructor(
		private readonly mode: Interactive,
		private readonly key: "statusContainer" | "footerContainer",
	) {
		this.layout = mode[key];
		this.parent.children = this.layout.children;
		this.layout.children = [this.parent];
		mode[key] = this.parent;
	}

	show(side: Component | undefined): void {
		this.layout.children = [side ?? this.parent];
	}

	restore(): void {
		this.layout.children = this.parent.children;
		this.mode[this.key] = this.layout;
	}
}

/**
 * The side conversation's view, which takes the place of the parent's while it is shown.
 *
 * Pi's own event handler draws it, through an object that inherits everything from the interactive
 * mode but keeps its own transcript, indicators and session. Pi's own footer shows the side session.
 * Messages, tool calls, notices and their extension renderers therefore look exactly as they do in
 * the parent.
 */
export class SideView {
	private readonly chat = new Container();
	private readonly status = new Container();
	private readonly footer: Component;
	private readonly statuses = new Map<string, string>();
	private readonly renderer: Interactive;
	private readonly message = new StreamingMessage();
	private readonly slots: Slot[];
	private readonly header: SessionHeader;
	private entries: SessionEntry[];
	private session: SessionManager;
	private state: SideState;
	private retryAttempt = 0;
	private source: { entries(since: string): Promise<SessionEntry[]>; state(): Promise<SideState> } | undefined;
	private drawing = Promise.resolve();
	private shown = false;
	private parentIndicator: Indicator | undefined;
	private sideIndicator: Indicator | undefined;
	private parentDraft = "";
	private sideDraft = "";
	private parentSubmit: Editor["onSubmit"];

	/**
	 * @param fork the side session as forked, header first
	 */
	constructor(
		private readonly mode: Interactive,
		fork: readonly FileEntry[],
		state: Omit<SideState, "autoCompactionEnabled">,
	) {
		this.header = fork[0] as SessionHeader;
		this.entries = fork.slice(1) as SessionEntry[];
		this.session = this.mirror();
		this.state = { ...state, autoCompactionEnabled: mode.session.autoCompactionEnabled };

		// Keep whatever an extension changed about drawing the chat, such as grouping tool calls.
		const parentChat = mode.chatContainer as unknown as Record<string, unknown>;
		if (Object.hasOwn(parentChat, "render")) (this.chat as unknown as Record<string, unknown>).render = parentChat.render;

		const own = (value: unknown) => ({ value, writable: true, configurable: true });
		const view = this;
		const session = Object.create(mode.session, {
			sessionManager: { get: () => view.session },
			state: { get: () => view.state },
			model: { get: () => view.state.model },
			thinkingLevel: { get: () => view.state.thinkingLevel },
			autoCompactionEnabled: { get: () => view.state.autoCompactionEnabled },
			retryAttempt: { get: () => view.retryAttempt },
			getContextUsage: own((): ContextUsage | undefined => view.state.contextUsage),
			getSteeringMessages: own(() => []),
			getFollowUpMessages: own(() => []),
		});
		this.renderer = Object.create(mode, {
			session: own(session),
			sessionManager: { get: () => view.session },
			chatContainer: own(this.chat),
			statusContainer: own(this.status),
			pendingTools: own(new Map()),
			streamingComponent: own(undefined),
			streamingMessage: own(undefined),
			activeStatusIndicator: own(undefined),
			activeWorkingIndicatorEmbedded: own(false),
			retryEscapeHandler: own(undefined),
			autoCompactionEscapeHandler: own(undefined),
			compactionQueuedMessages: own([]),
			entriesRenderedByBoundaryCompaction: own(new Set()),
			lastStatusText: own(undefined),
			lastStatusSpacer: own(undefined),
			// Esc is handled by the side conversation itself, which stops whatever it is doing.
			defaultEditor: own({ onEscape: undefined, setWorkingStatusIndicator() {} }),
			setEditorWorkingStatusIndicator: own((indicator: Indicator | undefined) => {
				view.sideIndicator = indicator;
				return view.shown ? setIndicator.call(mode, indicator) : view.embedsIndicator();
			}),
			// The terminal's progress and the pending message list belong to the parent.
			settingsManager: own(Object.create((mode as unknown as { settingsManager: object }).settingsManager, {
				getShowTerminalProgress: own(() => false),
			})),
			updatePendingMessagesDisplay: own(() => {}),
		}) as Interactive;

		const FooterComponent = mode.footer.constructor as new (session: unknown, data: FooterData) => Component & {
			setAutoCompactEnabled(enabled: boolean): void;
		};
		const parentData = mode.footerDataProvider;
		const footer = new FooterComponent(session, {
			getGitBranch: () => parentData.getGitBranch(),
			getAvailableProviderCount: () => parentData.getAvailableProviderCount(),
			getExtensionStatuses: () => this.statuses,
		});
		footer.setAutoCompactEnabled(this.state.autoCompactionEnabled);
		this.footer = footer;

		// The parent's indicators keep going to the parent while the side conversation is shown.
		this.parentIndicator = mode.editor.workingStatusIndicator;
		(mode as unknown as Record<string, unknown>).setEditorWorkingStatusIndicator = (indicator: Indicator | undefined) => {
			view.parentIndicator = indicator;
			return view.shown ? view.embedsIndicator() : setIndicator.call(mode, indicator);
		};
		this.slots = [new Slot(mode, "statusContainer"), new Slot(mode, "footerContainer")];
	}

	/** Connects the view to the side session it shows. */
	attach(source: { entries(since: string): Promise<SessionEntry[]>; state(): Promise<SideState> }): void {
		this.source = source;
		this.drawing = this.drawing.then(() => this.sync());
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
		if (event.type === "auto_retry_start") this.retryAttempt = event.attempt as number;
		if (!DRAWN_EVENTS.has(event.type) && !CHANGING_EVENTS.has(event.type)) return;
		const drawn = this.message.track(event);
		this.drawing = this.drawing.then(async () => {
			// Pi persists a message after drawing it, and compares it against the entries before it.
			const until = event.type === "message_end" ? (event.message as { timestamp: number }).timestamp : undefined;
			if (DRAWN_FROM_ENTRIES.has(event.type)) await this.sync();
			if (DRAWN_EVENTS.has(event.type)) await this.renderer.handleEvent(drawn);
			if (event.type === "auto_retry_end" || event.type === "agent_end") this.retryAttempt = 0;
			if (CHANGING_EVENTS.has(event.type) && !DRAWN_FROM_ENTRIES.has(event.type)) await this.sync(until);
		});
	}

	/** Shows a notification in the side transcript, after the events drawn so far. */
	notify(message: string, type: "info" | "warning" | "error"): void {
		this.drawing = this.drawing.then(() => this.renderer.showExtensionNotify(message, type));
	}

	/** Sets or clears a status entry from the side's extensions in its footer. */
	setStatus(key: string, text: string | undefined): void {
		if (text === undefined) this.statuses.delete(key);
		else this.statuses.set(key, text);
		this.mode.ui.requestRender();
	}

	/** Shows the side conversation in place of the parent's, with the editor submitting to `submit`. */
	show(submit: (text: string) => void): void {
		if (this.shown) return;
		this.shown = true;
		this.swapChat(this.mode.chatContainer, this.chat);
		this.slots[0]!.show(this.status);
		this.slots[1]!.show(this.footer);
		setIndicator.call(this.mode, this.sideIndicator);
		this.parentDraft = this.mode.editor.getText();
		this.mode.editor.setText(this.sideDraft);
		this.parentSubmit = this.mode.editor.onSubmit;
		this.mode.editor.onSubmit = (text) => {
			if (text.trim()) this.mode.editor.addToHistory?.(text.trim());
			submit(text);
		};
		this.mode.ui.requestRender(true);
	}

	/** Brings the parent's conversation back. */
	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.swapChat(this.chat, this.mode.chatContainer);
		for (const slot of this.slots) slot.show(undefined);
		setIndicator.call(this.mode, this.parentIndicator);
		this.sideDraft = this.mode.editor.getText();
		this.mode.editor.setText(this.parentDraft);
		this.mode.editor.onSubmit = this.parentSubmit;
		this.mode.ui.requestRender(true);
	}

	/** Brings the parent's conversation back for good and stops the side's indicators. */
	dispose(): void {
		this.hide();
		for (const slot of this.slots) slot.restore();
		delete (this.mode as unknown as Record<string, unknown>).setEditorWorkingStatusIndicator;
		this.renderer.activeStatusIndicator?.dispose();
		this.mode.ui.requestRender(true);
	}

	/** Whether Pi shows working indicators inside the editor's border, as `setEditorWorkingStatusIndicator` reports. */
	private embedsIndicator(): boolean {
		const editor = this.mode.editor;
		return editor.embedWorkingStatus === true && typeof editor.setWorkingStatusIndicator === "function";
	}

	private swapChat(from: Container, to: Container): void {
		const children = this.mode.documentContainer.children;
		children[children.indexOf(from)] = to;
	}

	/**
	 * Catches up with the side session's stored entries, up to the message stored at `until` if given,
	 * and with what its footer shows.
	 */
	private async sync(until?: number): Promise<void> {
		if (!this.source) return;
		const [added, state] = await Promise.all([this.source.entries(this.entries.at(-1)!.id), this.source.state()]);
		const end = until === undefined
			? added.length
			: added.findIndex((entry) => entry.type === "message" && entry.message.timestamp === until) + 1 || added.length;
		if (end > 0) {
			this.entries = [...this.entries, ...added.slice(0, end)];
			this.session = this.mirror();
		}
		this.state = state;
		this.mode.ui.requestRender();
	}

	private mirror(): SessionManager {
		return SessionManager.inMemory(this.header.cwd, { id: this.header.id }, [this.header, ...this.entries]);
	}
}
