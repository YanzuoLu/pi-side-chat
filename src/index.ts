/**
 * Codex's `/side` for Pi: a side conversation forked from the current one.
 *
 * `/side` (or `/btw`) forks the conversation into a separate Pi process with the same model, thinking
 * level and extensions, and shows it in place of the parent's conversation. Codex's hidden
 * side instructions follow the inherited history, so the model answers questions without continuing
 * the parent's work. Each `/side` opens another one. Ctrl+/ switches between the main thread and the
 * side conversation shown last, Shift+Left and Shift+Right through all of them, without closing any.
 * Ctrl+C on an empty editor closes the side conversation shown. Ctrl+S closes it too, after it writes a handoff of what happened
 * in it, which is steered into the main thread. A side conversation the user asked something in is
 * saved as a session of its own, which `pi --session <id>` resumes like any other.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { type SideEvent, SideProcess } from "./child.ts";
import {
	SIDE_NO_STARTED_CONVERSATION_MESSAGE,
	SIDE_SLASH_COMMAND_UNAVAILABLE_HINT,
	SIDE_STARTING_CONTEXT_LABEL,
} from "./codex.ts";
import { forkSide, hasStarted, sideOrigin } from "./fork.ts";
import { HANDOFF_PROMPT, handoffMessage, readHandoffConfig } from "./handoff.ts";
import { findInteractiveMode, SideView } from "./view.ts";

const KEY = "side-chat";
const TOGGLE_LABEL = "ctrl + /";
const SWITCH_LABEL = "shift + ←/→";
const CLOSE_LABEL = "ctrl + c";
const HANDOFF_LABEL = "ctrl + s";
const HANDING_OFF_LABEL = "Side summarizing...";
const CONFIG_FILE = "pi-side-chat.json";
const COMMANDS = ["side", "btw"];

type Side = {
	id: string;
	view: SideView;
	process?: SideProcess;
	/** The side session's file, which stays once the user has asked something in it. */
	sessionFile: string;
	sessionDir: string;
	/** A directory that holds the session of a parent that is not saved itself, removed on close. */
	temporary?: string;
	/** Commands the side session runs itself, such as extension commands, prompt templates and skills. */
	commands: Set<string>;
	streaming: boolean;
	/** The model and thinking level the side conversation runs with. */
	model: { provider: string; id: string; thinking: string };
	/** When the side conversation was forked from the main thread. */
	forkedAt: string;
	/** Whether the user has said anything in the side conversation. */
	asked: boolean;
	/** Whether the side conversation is writing its handoff. */
	handingOff: boolean;
	/** How the parent's turn ended while the side conversation was open, as Codex labels it. */
	parentStatus?: string;
};

export default function sideChat(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	/** The open side conversations, oldest first. */
	const sides: Side[] = [];
	/** The side conversation shown last, which Ctrl+/ returns to. */
	let last: Side | undefined;
	let stopKeys: (() => void) | undefined;

	const shown = () => sides.find((side) => side.view.visible);
	/** The side conversations one can switch to: those running and not writing a handoff. */
	const switchable = () => sides.filter((side) => side.process && !side.handingOff);

	/** Errors about a side conversation go to whichever transcript is shown. */
	const notifyError = (message: string) => {
		const current = shown();
		if (current) current.view.notify(message, "error");
		else ctx?.ui.notify(message, "error");
	};

	/** Codex's labels for one side conversation, numbered and switched with Shift+arrows once there are more. */
	const updateLabel = (label?: string) => {
		if (!ctx) return;
		const open = switchable();
		const current = shown();
		let text = label;
		if (!text && current) {
			const index = open.indexOf(current) + 1;
			const parts = [open.length > 1 ? `${index}/${open.length} from main thread` : "from main thread"];
			if (current.parentStatus) parts.push(current.parentStatus);
			parts.push(
				open.length > 1 ? `${SWITCH_LABEL} to switch` : `${TOGGLE_LABEL} to switch`,
				`${HANDOFF_LABEL} to hand off`,
				`${CLOSE_LABEL} to close`,
			);
			text = `Side ${parts.join(" · ")}`;
		} else if (!text) {
			const parts: string[] = [];
			if (sides.some((side) => side.handingOff)) parts.push(HANDING_OFF_LABEL);
			if (open.length === 1) parts.push(`${TOGGLE_LABEL} for side`);
			if (open.length > 1) parts.push(`${open.length} sides`, `${SWITCH_LABEL} to switch`);
			text = parts.join(" · ") || undefined;
		}
		ctx.ui.setWidget(KEY, text ? [ctx.ui.theme.fg("dim", text)] : undefined);
	};

	const show = (current: Side) => {
		last = current;
		current.view.show((text: string) => submit(current, text));
		updateLabel();
	};

	const hide = (current: Side) => {
		current.view.hide();
		updateLabel();
	};

	const close = async (current: Side) => {
		const index = sides.indexOf(current);
		if (index < 0) return;
		sides.splice(index, 1);
		if (last === current) last = undefined;
		current.view.dispose();
		updateLabel();
		await current.process?.close();
		if (current.temporary) rmSync(current.temporary, { recursive: true, force: true });
		else if (!current.asked) rmSync(current.sessionFile, { force: true });
		else ctx?.ui.notify(`Side conversation saved. Resume it with: pi --session ${current.id}`, "info");
	};

	const submit = (current: Side, text: string) => {
		text = text.trim();
		if (!text || !ctx) return;
		const command = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
		ctx.ui.setEditorText("");
		// Another side conversation forks from the main thread, as if asked there.
		if (command !== undefined && COMMANDS.includes(command)) {
			open(ctx, text.slice(command.length + 1).trim()).catch((error: Error) => notifyError(error.message));
			return;
		}
		if (command !== undefined && !current.commands.has(command)) {
			notifyError(`'/${command}' is unavailable in side conversations. ${SIDE_SLASH_COMMAND_UNAVAILABLE_HINT}`);
			return;
		}
		current.process?.prompt(text, current.streaming).catch((error: Error) => notifyError(error.message));
	};

	const handleEvent = (current: Side, event: SideEvent) => {
		if (event.type === "agent_start") current.streaming = true;
		if (event.type === "agent_end") current.streaming = false;
		if (event.type === "message_start" && (event.message as { role?: string }).role === "user") current.asked = true;
		current.view.draw(event);
	};

	/** Opens a new side conversation forked from the main thread, and asks `message` there if given. */
	const open = async (context: ExtensionContext, message: string) => {
		ctx = context;
		const branch = context.sessionManager.getBranch();
		const header = context.sessionManager.getHeader();
		const model = context.model;
		if (!hasStarted(branch) || !header) {
			notifyError(SIDE_NO_STARTED_CONVERSATION_MESSAGE);
			if (message) context.ui.setEditorText(message);
			return;
		}
		if (!model) {
			notifyError("Failed to start side conversation: no model is selected");
			if (message) context.ui.setEditorText(message);
			return;
		}

		// The side session sits next to the parent's, or in a temporary directory if the parent is not saved.
		const parentFile = context.sessionManager.getSessionFile();
		const temporary = parentFile ? undefined : mkdtempSync(join(tmpdir(), "pi-side-chat-"));
		const sessionDir = temporary ?? context.sessionManager.getSessionDir();
		const sideSession = SessionManager.create(context.cwd, sessionDir, { parentSession: parentFile });
		const sessionFile = sideSession.getSessionFile()!;
		const entries = forkSide(sideSession.getHeader()!, branch, !context.isIdle(), { parentSessionId: header.id });
		const view = new SideView(findInteractiveMode(context, KEY), entries, {
			model,
			thinkingLevel: pi.getThinkingLevel(),
		});
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const current: Side = {
			id: sideSession.getSessionId(),
			view,
			sessionFile,
			sessionDir,
			temporary,
			commands: new Set(),
			streaming: false,
			model: { provider: model.provider, id: model.id, thinking: pi.getThinkingLevel() },
			forkedAt: new Date().toISOString(),
			asked: false,
			handingOff: false,
		};
		sides.push(current);
		updateLabel(SIDE_STARTING_CONTEXT_LABEL);
		try {
			current.process = await SideProcess.start({
				cwd: context.cwd,
				sessionFile,
				sessionDir,
				provider: model.provider,
				model: model.id,
				thinking: pi.getThinkingLevel(),
				ui: () => context.ui,
				notify: (text, type) => view.notify(text, type),
				setStatus: (key, text) => view.setStatus(key, text),
				onEvent: (event) => handleEvent(current, event),
				onExit: (reason) => {
					if (!sides.includes(current)) return;
					notifyError(`Side conversation ended: ${reason}`);
					void close(current);
				},
			});
		} catch (error) {
			await close(current);
			notifyError(`Failed to start side conversation: ${(error as Error).message}`);
			if (message) context.ui.setEditorText(message);
			return;
		}
		if (!sides.includes(current)) {
			await current.process.close();
			return;
		}
		// The footer shows the session name, so the side's id is in view for resuming it later.
		await current.process.setSessionName(`Side ${current.id}`);
		for (const info of await current.process.commands()) {
			if (!COMMANDS.includes(info)) current.commands.add(info);
		}
		view.attach(current.process);
		show(current);
		if (message) submit(current, message);
	};

	/**
	 * Closes the side conversation after it writes a handoff, which is steered into the main thread.
	 * The main thread shows meanwhile. If the handoff fails, the side conversation stays open as it was.
	 */
	const handOff = async (current: Side) => {
		const child = current.process!;
		if (!current.asked) return close(current);
		current.handingOff = true;
		hide(current);
		let switched = false;
		try {
			if (current.streaming) await child.abort();
			const config = readHandoffConfig(join(getAgentDir(), CONFIG_FILE));
			if (config.model || config.thinking) {
				switched = true;
				if (config.model) await child.setModel(config.model.provider, config.model.id);
				await child.setThinkingLevel(config.thinking ?? current.model.thinking);
			}
			const handoff = await child.reply(HANDOFF_PROMPT);
			if (!sides.includes(current)) return;
			pi.sendMessage(
				{ customType: "side-handoff", content: handoffMessage(handoff, current.forkedAt), display: true },
				{ deliverAs: "steer", triggerTurn: true },
			);
			await close(current);
		} catch (error) {
			if (!sides.includes(current)) return;
			current.handingOff = false;
			updateLabel();
			notifyError(`Failed to hand off side conversation: ${(error as Error).message}`);
			if (switched) {
				await child.setModel(current.model.provider, current.model.id).catch(() => {});
				await child.setThinkingLevel(current.model.thinking).catch(() => {});
			}
		}
	};

	/**
	 * Ctrl+/ switches between the main thread and the side conversation shown last, Shift+Left and
	 * Shift+Right go through the main thread and every side conversation in order. In a side view
	 * Ctrl+S hands it off, Ctrl+C on an empty editor closes it and Esc stops it.
	 */
	const handleKey = (data: string): { consume: true } | undefined => {
		const open = switchable();
		// Terminals with the kitty keyboard protocol also report releases, which would act a second time.
		if (open.length === 0 || !ctx || isKeyRelease(data)) return undefined;
		const current = shown();
		if (matchesKey(data, "ctrl+/") || matchesKey(data, "ctrl+7")) {
			if (current) hide(current);
			else show(last && open.includes(last) ? last : open.at(-1)!);
			return { consume: true };
		}
		if (!open[0]!.view.editorFocused) return undefined;
		const step = matchesKey(data, "shift+right") ? 1 : matchesKey(data, "shift+left") ? -1 : 0;
		if (step !== 0) {
			// Position 0 is the main thread, then the side conversations in the order they opened.
			const at = current ? open.indexOf(current) + 1 : 0;
			const next = (at + step + open.length + 1) % (open.length + 1);
			if (next === 0) hide(current!);
			else show(open[next - 1]!);
			return { consume: true };
		}
		if (!current) return undefined;
		if (matchesKey(data, "ctrl+s")) {
			void handOff(current);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c") && ctx.ui.getEditorText() === "") {
			void close(current);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// Esc belongs to the side conversation here, never to the hidden parent.
			current.process!.abort().catch(() => {});
			return { consume: true };
		}
		return undefined;
	};

	for (const name of COMMANDS) {
		pi.registerCommand(name, {
			description: "start a side conversation in a fork of this one",
			handler: async (args, context) => {
				if (context.mode !== "tui") {
					context.ui.notify(`'/${name}' needs Pi's interactive mode`, "error");
					return;
				}
				await open(context, args.trim());
			},
		});
	}

	/** The parent's session id, when this session is a side conversation. */
	let parentSessionId: string | undefined;

	// OpenAI routes prompt caching by this key, which Pi sets to the session id. A side conversation,
	// open or resumed later, keeps the parent's, whose cache already holds the history they share.
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { prompt_cache_key?: unknown };
		if (parentSessionId && typeof payload.prompt_cache_key === "string") {
			return { ...payload, prompt_cache_key: parentSessionId };
		}
	});

	pi.on("session_start", (_event, context) => {
		ctx = context;
		parentSessionId = sideOrigin(context.sessionManager.getEntries())?.parentSessionId;
		if (context.mode === "tui") stopKeys = context.ui.onTerminalInput(handleKey);
	});

	pi.on("session_shutdown", async () => {
		stopKeys?.();
		stopKeys = undefined;
		await Promise.all([...sides].map(close));
		ctx?.ui.setWidget(KEY, undefined);
		ctx = undefined;
	});

	pi.on("agent_start", () => {
		if (sides.length === 0) return;
		for (const side of sides) side.parentStatus = undefined;
		updateLabel();
	});

	pi.on("agent_end", (event: AgentEndEvent) => {
		if (sides.length === 0) return;
		const final = event.messages.findLast((message) => message.role === "assistant");
		const reason = final && "stopReason" in final ? final.stopReason : undefined;
		const status = reason === "aborted" ? "main interrupted" : reason === "error" ? "main failed" : "main finished";
		for (const side of sides) side.parentStatus = status;
		updateLabel();
	});
}
