/**
 * The side conversation's view, drawn by Pi's own interactive mode.
 *
 * Like switching threads in Codex, showing a side conversation swaps everything that belongs to a
 * conversation: the transcript, the working and compaction indicators, the footer and the editor's
 * draft. Any number of side conversations can be open, one of them or the parent's shown at a time. Pi has no extension API for a second conversation view, so this module reaches into its
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
import type { Model } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, type Component, Container } from "@earendil-works/pi-tui";
import type { SideEvent, SideState } from "./child.ts";
import { SIDE_MESSAGE_TYPE } from "./fork.ts";
import { StreamingMessage } from "./stream.ts";

type Editor = Component & {
	setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
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
	pendingMessagesContainer: Container;
	statusContainer: Container;
	footerContainer: Container;
	footer: Component;
	footerDataProvider: FooterData;
	editor: Editor;
	keybindings: { matches(data: string, action: string): boolean };
	autocompleteProvider?: AutocompleteProvider;
	settingsManager: { setDefaultModelAndProvider(provider: string, modelId: string): void };
	activeStatusIndicator?: Indicator;
	handleEvent(event: unknown): Promise<void>;
	showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void;
	renderSessionEntries(entries: SessionEntry[]): void;
	setEditorWorkingStatusIndicator(indicator: Indicator | undefined): boolean;
	updateEditorBorderColor(): void;
	showStatus(message: string): void;
	cycleModel(direction: "forward" | "backward"): Promise<void>;
	showModelSelector(initialSearchInput?: string): void;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	flushPendingBashComponents(): void;
};

/** What a side view asks of the side session it shows. */
export interface SideSource {
	entries(since: string): Promise<SessionEntry[]>;
	state(): Promise<SideState>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	cycleThinkingLevel(): Promise<string | undefined>;
	bash(command: string, excludeFromContext: boolean, onOutput: (delta: string) => void): Promise<BashResult>;
	abortBash(): Promise<void>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

type ScopedModel = { model: Model<any>; thinkingLevel?: string };

type SetIndicator = Interactive["setEditorWorkingStatusIndicator"];

const prototype = InteractiveMode.prototype as unknown as Interactive;

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
	"queue_update",
]);

/** Events drawn from the side session's stored entries, which must include the new entry first. */
const DRAWN_FROM_ENTRIES = new Set(["entry_appended", "compaction_end"]);

/** Events after which the side session has stored new entries or changed what the footer shows. */
const CHANGING_EVENTS = new Set(["message_end", "agent_end", "compaction_end", "entry_appended"]);

const setIndicator: SetIndicator = prototype.setEditorWorkingStatusIndicator;

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
		// While a side conversation is shown, its chat stands where the parent's does.
		!(Stage.has(mode as Interactive) || mode.documentContainer?.children.includes(mode.chatContainer)) ||
		!(mode.statusContainer instanceof Container) ||
		!(mode.footerContainer instanceof Container) ||
		!(mode.pendingMessagesContainer instanceof Container) ||
		!writable("pendingMessagesContainer") ||
		!writable("statusContainer") ||
		typeof mode.keybindings?.matches !== "function" ||
		typeof mode.settingsManager?.setDefaultModelAndProvider !== "function" ||
		typeof mode.editor?.setAutocompleteProvider !== "function" ||
		!["updateEditorBorderColor", "showStatus", "cycleModel", "showModelSelector", "handleBashCommand", "flushPendingBashComponents"]
			.every((method) => typeof (prototype as unknown as Record<string, unknown>)[method] === "function") ||
		!writable("footerContainer") ||
		typeof mode.footer?.render !== "function" ||
		typeof mode.footerDataProvider?.getExtensionStatuses !== "function" ||
		typeof mode.handleEvent !== "function" ||
		typeof mode.showExtensionNotify !== "function" ||
		typeof mode.renderSessionEntries !== "function" ||
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

/** A container in Pi's layout that shows either the parent's content or a side conversation's. */
class Slot {
	private readonly layout: Container;
	private readonly parent = new Container();

	/** From now on the parent draws into its own container, which this slot shows until told otherwise. */
	constructor(
		private readonly mode: Interactive,
		private readonly key: "pendingMessagesContainer" | "statusContainer" | "footerContainer",
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
 * What one interactive mode shows: the parent's conversation or one of its open side conversations.
 * It holds what they share, the layout, the editor and the working indicator in its border, and
 * gives each back what belongs to it when it shows again.
 */
class Stage {
	private static readonly stages = new WeakMap<Interactive, Stage>();
	current: SideView | undefined;
	private readonly views = new Set<SideView>();
	private readonly slots: Slot[];
	private parentIndicator: Indicator | undefined;
	private parentDraft = "";
	private parentSubmit: Editor["onSubmit"];

	static has(mode: Interactive): boolean {
		return Stage.stages.has(mode);
	}

	static for(mode: Interactive): Stage {
		let stage = Stage.stages.get(mode);
		if (!stage) {
			stage = new Stage(mode);
			Stage.stages.set(mode, stage);
		}
		return stage;
	}

	private constructor(readonly mode: Interactive) {
		// The parent's indicators keep going to the parent while a side conversation is shown.
		this.parentIndicator = mode.editor.workingStatusIndicator;
		(mode as unknown as Record<string, unknown>).setEditorWorkingStatusIndicator = (indicator: Indicator | undefined) => {
			this.parentIndicator = indicator;
			return this.current ? this.embedsIndicator() : setIndicator.call(mode, indicator);
		};
		// The editor's border shows the thinking level of the conversation shown, whoever asks to redraw it.
		(mode as unknown as Record<string, unknown>).updateEditorBorderColor = () => {
			if (this.current) this.current.updateBorder();
			else prototype.updateEditorBorderColor.call(mode);
		};
		this.slots = [
			new Slot(mode, "pendingMessagesContainer"),
			new Slot(mode, "statusContainer"),
			new Slot(mode, "footerContainer"),
		];
	}

	add(view: SideView): void {
		this.views.add(view);
	}

	/** Shows `view`, with the editor submitting to `submit`, in place of what is shown now. */
	show(view: SideView, submit: (text: string) => void): void {
		if (this.current === view) return;
		const editor = this.mode.editor;
		if (this.current) {
			this.current.leave(editor.getText());
		} else {
			this.parentDraft = editor.getText();
			this.parentSubmit = editor.onSubmit;
		}
		this.swapChat(this.current?.chat ?? this.mode.chatContainer, view.chat);
		this.current = view;
		this.slots[0]!.show(view.pending);
		this.slots[1]!.show(view.status);
		this.slots[2]!.show(view.footer);
		setIndicator.call(this.mode, view.indicator);
		editor.setText(view.draft);
		if (this.mode.autocompleteProvider) editor.setAutocompleteProvider!(view.autocomplete(this.mode.autocompleteProvider));
		view.updateBorder();
		editor.onSubmit = (text) => {
			if (text.trim()) editor.addToHistory?.(text.trim());
			submit(text);
		};
		this.mode.ui.requestRender(true);
	}

	/** Brings the parent's conversation back. */
	showParent(): void {
		const view = this.current;
		if (!view) return;
		const editor = this.mode.editor;
		view.leave(editor.getText());
		this.current = undefined;
		this.swapChat(view.chat, this.mode.chatContainer);
		for (const slot of this.slots) slot.show(undefined);
		setIndicator.call(this.mode, this.parentIndicator);
		editor.setText(this.parentDraft);
		editor.onSubmit = this.parentSubmit;
		if (this.mode.autocompleteProvider) editor.setAutocompleteProvider!(this.mode.autocompleteProvider);
		prototype.updateEditorBorderColor.call(this.mode);
		this.mode.ui.requestRender(true);
	}

	/** Forgets `view`, and gives the layout back to the parent once no side conversation is left. */
	remove(view: SideView): void {
		if (this.current === view) this.showParent();
		this.views.delete(view);
		if (this.views.size > 0) return;
		for (const slot of this.slots) slot.restore();
		delete (this.mode as unknown as Record<string, unknown>).setEditorWorkingStatusIndicator;
		delete (this.mode as unknown as Record<string, unknown>).updateEditorBorderColor;
		Stage.stages.delete(this.mode);
		this.mode.ui.requestRender(true);
	}

	/** Whether Pi shows working indicators inside the editor's border, as `setEditorWorkingStatusIndicator` reports. */
	embedsIndicator(): boolean {
		const editor = this.mode.editor;
		return editor.embedWorkingStatus === true && typeof editor.setWorkingStatusIndicator === "function";
	}

	private swapChat(from: Container, to: Container): void {
		const children = this.mode.documentContainer.children;
		children[children.indexOf(from)] = to;
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
	readonly chat = new Container();
	readonly status = new Container();
	/** The side's queued steering and follow-up messages, drawn above its editor like the parent's. */
	readonly pending = new Container();
	queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	readonly footer: Component;
	/** The side's working indicator, and its editor draft while it is not shown. */
	indicator: Indicator | undefined;
	draft = "";
	private readonly statuses = new Map<string, string>();
	private readonly renderer: Interactive;
	private readonly message = new StreamingMessage();
	private readonly stage: Stage;
	private readonly header: SessionHeader;
	private entries: SessionEntry[];
	private session: SessionManager;
	private state: SideState;
	private retryAttempt = 0;
	private streaming = false;
	private bashRunning = false;
	/** The slash commands the side runs, which its editor completes. */
	private commandNames = new Set<string>();
	private source: SideSource | undefined;
	private drawing = Promise.resolve();
	private disposed = false;

	/**
	 * @param fork the side session as forked, header first
	 */
	constructor(
		private readonly mode: Interactive,
		fork: readonly FileEntry[],
		state: Omit<SideState, "autoCompactionEnabled">,
	) {
		this.stage = Stage.for(mode);
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
			getSteeringMessages: own(() => view.queue.steering),
			getFollowUpMessages: own(() => view.queue.followUp),
			isStreaming: { get: () => view.streaming },
			isBashRunning: { get: () => view.bashRunning },
			// The side process runs its own extensions' user_bash handlers.
			extensionRunner: own(Object.create((mode.session as unknown as { extensionRunner: object }).extensionRunner, {
				emitUserBash: own(async () => undefined),
			})),
			executeBash: own(async (command: string, onChunk: (delta: string) => void, options?: { excludeFromContext?: boolean }) => {
				view.bashRunning = true;
				try {
					return await view.source!.bash(command, options?.excludeFromContext ?? false, onChunk);
				} finally {
					view.bashRunning = false;
				}
			}),
			setModel: own(async (model: Model<any>, options: { persist?: boolean } = {}) => {
				await view.source!.setModel(model.provider, model.id);
				if (options.persist) mode.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
				await view.refreshState();
			}),
			cycleModel: own((direction: "forward" | "backward") => view.nextModel(direction)),
		});
		this.renderer = Object.create(mode, {
			session: own(session),
			sessionManager: { get: () => view.session },
			chatContainer: own(this.chat),
			statusContainer: own(this.status),
			pendingMessagesContainer: own(this.pending),
			pendingTools: own(new Map()),
			pendingBashComponents: own([]),
			bashComponent: own(undefined),
			// Only the conversation shown colors the editor's border.
			updateEditorBorderColor: own(() => {
				if (view.visible) prototype.updateEditorBorderColor.call(view.renderer);
			}),
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
				view.indicator = indicator;
				return view.visible ? setIndicator.call(mode, indicator) : view.stage.embedsIndicator();
			}),
			// The terminal's progress and the pending message list belong to the parent.
			settingsManager: own(Object.create((mode as unknown as { settingsManager: object }).settingsManager, {
				getShowTerminalProgress: own(() => false),
			})),
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
		this.stage.add(this);
	}

	/** Connects the view to the side session it shows, whose editor completes `commands`. */
	attach(source: SideSource, commands: Iterable<string>): void {
		this.source = source;
		this.commandNames = new Set(commands);
		this.drawing = this.drawing.then(() => this.sync());
	}

	get visible(): boolean {
		return this.stage.current === this;
	}

	/** Whether `data` is a key bound to one of Pi's actions, such as `app.message.dequeue`. */
	matches(data: string, action: string): boolean {
		return this.mode.keybindings.matches(data, action);
	}

	/** Whether the editor has focus without a popup, so keys reach the conversation rather than a dialog. */
	get editorFocused(): boolean {
		return this.mode.ui.focusedComponent === this.mode.editor && !this.mode.editor.isShowingAutocomplete?.();
	}

	/** Draws one event from the side session, in order. */
	draw(event: SideEvent): void {
		if (event.type === "auto_retry_start") this.retryAttempt = event.attempt as number;
		if (event.type === "agent_start") this.streaming = true;
		if (event.type === "agent_end") this.streaming = false;
		if (event.type === "thinking_level_changed") {
			this.state = { ...this.state, thinkingLevel: event.level as string };
			this.updateBorder();
		}
		if (!DRAWN_EVENTS.has(event.type) && !CHANGING_EVENTS.has(event.type)) return;
		const drawn = this.message.track(event);
		this.drawing = this.drawing.then(async () => {
			if (this.disposed) return;
			// Pi persists a message after drawing it, and compares it against the entries before it.
			const until = event.type === "message_end" ? (event.message as { timestamp: number }).timestamp : undefined;
			if (event.type === "queue_update") this.queue = { steering: event.steering as string[], followUp: event.followUp as string[] };
			if (DRAWN_FROM_ENTRIES.has(event.type)) await this.sync();
			if (DRAWN_EVENTS.has(event.type)) await this.renderer.handleEvent(drawn);
			if (event.type === "auto_retry_end" || event.type === "agent_end") this.retryAttempt = 0;
			if (CHANGING_EVENTS.has(event.type) && !DRAWN_FROM_ENTRIES.has(event.type)) await this.sync(until);
		});
	}

	/** Whether a `!` command of the side's is running. */
	get runningBash(): boolean {
		return this.bashRunning;
	}

	/** Colors the editor's border for the side's thinking level, or for bash mode, while it is shown. */
	updateBorder(): void {
		this.renderer.updateEditorBorderColor();
	}

	/** The editor's completion for the side: `base`, with only the slash commands the side runs. */
	autocomplete(base: AutocompleteProvider): AutocompleteProvider {
		return {
			triggerCharacters: base.triggerCharacters,
			shouldTriggerFileCompletion: base.shouldTriggerFileCompletion?.bind(base),
			applyCompletion: (...args) => base.applyCompletion(...args),
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				const suggestions = await base.getSuggestions(lines, cursorLine, cursorCol, options);
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (!suggestions || !before.startsWith("/") || before.includes(" ")) return suggestions;
				const items = suggestions.items.filter((item) => this.commandNames.has(item.value));
				return items.length > 0 ? { ...suggestions, items } : null;
			},
		};
	}

	/** Pi's Shift+Tab for the side: the next thinking level, reported in its transcript. */
	async cycleThinkingLevel(): Promise<void> {
		const level = await this.source!.cycleThinkingLevel();
		if (level === undefined) {
			this.renderer.showStatus("Current model does not support thinking");
			return;
		}
		this.state = { ...this.state, thinkingLevel: level };
		this.updateBorder();
		this.renderer.showStatus(`Thinking level: ${level}`);
	}

	/** Pi's model cycling keys for the side. */
	cycleModel(direction: "forward" | "backward"): Promise<void> {
		return this.renderer.cycleModel(direction);
	}

	/** Pi's model selector for the side. */
	selectModel(): void {
		this.renderer.showModelSelector();
	}

	/** Runs a `!` command in the side session and draws it as Pi does. */
	runBash(command: string, excludeFromContext: boolean): Promise<void> {
		return this.renderer.handleBashCommand(command, excludeFromContext);
	}

	/** Moves `!` commands run while the side was working into its transcript, as Pi does before a new prompt. */
	flushBash(): void {
		this.renderer.flushPendingBashComponents();
	}

	/**
	 * Switches the side to the next or previous model the way Pi's cycling does: through the scoped
	 * models with their thinking levels if there are any, otherwise through every available model.
	 */
	private async nextModel(direction: "forward" | "backward") {
		const session = this.mode.session as unknown as {
			scopedModels: ScopedModel[];
			modelRuntime: { getAvailableSnapshot(): Model<any>[] };
		};
		const available = session.modelRuntime.getAvailableSnapshot();
		const ids = new Set(available.map((model) => `${model.provider}\0${model.id}`));
		const scoped = session.scopedModels.length > 0;
		const candidates: ScopedModel[] = scoped
			? session.scopedModels.filter((entry) => ids.has(`${entry.model.provider}\0${entry.model.id}`))
			: available.map((model) => ({ model }));
		if (candidates.length <= 1) return undefined;
		const current = this.state.model;
		const index = Math.max(0, candidates.findIndex((entry) => entry.model.provider === current?.provider && entry.model.id === current?.id));
		const next = candidates[(index + (direction === "forward" ? 1 : -1) + candidates.length) % candidates.length]!;
		await this.source!.setModel(next.model.provider, next.model.id);
		if (next.thinkingLevel) await this.source!.setThinkingLevel(next.thinkingLevel);
		await this.refreshState();
		return { model: next.model, thinkingLevel: this.state.thinkingLevel, isScoped: scoped };
	}

	private async refreshState(): Promise<void> {
		this.state = await this.source!.state();
		this.mode.ui.requestRender();
	}

	/** Draws what the side conversation already holds after its opening, as for one opened again. */
	replay(): void {
		const branch = this.session.getBranch();
		const opening = branch.findLastIndex((entry) => entry.type === "custom_message" && entry.customType === SIDE_MESSAGE_TYPE);
		const entries = branch.slice(opening + 1);
		this.drawing = this.drawing.then(() => this.renderer.renderSessionEntries(entries));
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

	/** Shows the side conversation in place of what is shown now, with the editor submitting to `submit`. */
	show(submit: (text: string) => void): void {
		this.stage.show(this, submit);
	}

	/** Brings the parent's conversation back if this side conversation is shown. */
	hide(): void {
		if (this.visible) this.stage.showParent();
	}

	/** Keeps the editor's draft for when this side conversation shows again. */
	leave(draft: string): void {
		this.draft = draft;
	}

	/** Takes the side conversation off the screen for good and stops its indicators. */
	dispose(): void {
		this.disposed = true;
		this.stage.remove(this);
		this.renderer.activeStatusIndicator?.dispose();
		this.mode.ui.requestRender(true);
	}

	/**
	 * Catches up with the side session's stored entries, up to the message stored at `until` if given,
	 * and with what its footer shows.
	 */
	private async sync(until?: number): Promise<void> {
		if (!this.source || this.disposed) return;
		let added: SessionEntry[];
		let state: SideState;
		try {
			[added, state] = await Promise.all([this.source.entries(this.entries.at(-1)!.id), this.source.state()]);
		} catch (error) {
			// Closing the side conversation ends its process, and with it any catching up still on the way.
			if (this.disposed) return;
			throw error;
		}
		if (this.disposed) return;
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
