/**
 * Codex's `/side` for Pi: an ephemeral side conversation forked from the current one.
 *
 * `/side` (or `/btw`) forks the conversation into a separate Pi process with the same model, thinking
 * level, extensions and session id, and shows it in place of the parent's conversation. Codex's hidden
 * side instructions follow the inherited history, so the model answers questions without continuing
 * the parent's work. Ctrl+/ switches between the two without closing either, and Ctrl+C on an empty
 * editor closes the side conversation. Nothing of it is saved.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { type SideEvent, SideProcess } from "./child.ts";
import {
	SIDE_NO_STARTED_CONVERSATION_MESSAGE,
	SIDE_SLASH_COMMAND_UNAVAILABLE_HINT,
	SIDE_STARTING_CONTEXT_LABEL,
} from "./codex.ts";
import { forkSide, hasStarted } from "./fork.ts";
import { findInteractiveMode, SideView } from "./view.ts";

const KEY = "side-chat";
const TOGGLE_LABEL = "ctrl + /";
const CLOSE_LABEL = "ctrl + c";
const COMMANDS = ["side", "btw"];

type Side = {
	view: SideView;
	process?: SideProcess;
	directory: string;
	/** Commands the side session runs itself, such as extension commands, prompt templates and skills. */
	commands: Set<string>;
	streaming: boolean;
	/** How the parent's turn ended while the side conversation was open, as Codex labels it. */
	parentStatus?: string;
};

export default function sideChat(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let side: Side | undefined;
	let stopKeys: (() => void) | undefined;

	/** Errors about the side conversation go to whichever transcript is shown. */
	const notifyError = (message: string) => {
		if (side?.view.visible) side.view.notify(message, "error");
		else ctx?.ui.notify(message, "error");
	};

	const updateLabel = (label?: string) => {
		if (!ctx) return;
		let text = label;
		if (!text && side?.view.visible) {
			const parts = ["from main thread"];
			if (side.parentStatus) parts.push(side.parentStatus);
			parts.push(`${TOGGLE_LABEL} to switch`, `${CLOSE_LABEL} to close`);
			text = `Side ${parts.join(" · ")}`;
		} else if (!text && side) {
			text = `${TOGGLE_LABEL} for side`;
		}
		ctx.ui.setWidget(KEY, text ? [ctx.ui.theme.fg("dim", text)] : undefined);
	};

	const show = (current: Side) => {
		current.view.show((text: string) => submit(current, text));
		updateLabel();
	};

	const hide = (current: Side) => {
		current.view.hide();
		updateLabel();
	};

	const close = async () => {
		const current = side;
		if (!current) return;
		side = undefined;
		current.view.dispose();
		updateLabel();
		await current.process?.close();
		rmSync(current.directory, { recursive: true, force: true });
	};

	const submit = (current: Side, text: string) => {
		text = text.trim();
		if (!text || !ctx) return;
		const command = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
		ctx.ui.setEditorText("");
		if (command !== undefined && !current.commands.has(command)) {
			notifyError(`'/${command}' is unavailable in side conversations. ${SIDE_SLASH_COMMAND_UNAVAILABLE_HINT}`);
			return;
		}
		current.process?.prompt(text, current.streaming).catch((error: Error) => notifyError(error.message));
	};

	const handleEvent = (current: Side, event: SideEvent) => {
		if (event.type === "agent_start") current.streaming = true;
		if (event.type === "agent_end") current.streaming = false;
		current.view.draw(event);
	};

	const open = async (context: ExtensionContext, message: string) => {
		ctx = context;
		if (side) {
			if (!side.view.visible) show(side);
			if (message) submit(side, message);
			return;
		}
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

		const entries = forkSide({ ...header }, branch, !context.isIdle());
		const view = new SideView(findInteractiveMode(context, KEY), entries, {
			model,
			thinkingLevel: pi.getThinkingLevel(),
		});
		const directory = mkdtempSync(join(tmpdir(), "pi-side-chat-"));
		const sessionFile = join(directory, "side.jsonl");
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const current: Side = { view, directory, commands: new Set(), streaming: false };
		side = current;
		updateLabel(SIDE_STARTING_CONTEXT_LABEL);
		try {
			current.process = await SideProcess.start({
				cwd: context.cwd,
				sessionFile,
				sessionDir: directory,
				provider: model.provider,
				model: model.id,
				thinking: pi.getThinkingLevel(),
				ui: () => context.ui,
				notify: (text, type) => view.notify(text, type),
				setStatus: (key, text) => view.setStatus(key, text),
				onEvent: (event) => handleEvent(current, event),
				onExit: (reason) => {
					if (side !== current) return;
					notifyError(`Side conversation ended: ${reason}`);
					void close();
				},
			});
		} catch (error) {
			if (side === current) await close();
			notifyError(`Failed to start side conversation: ${(error as Error).message}`);
			if (message) context.ui.setEditorText(message);
			return;
		}
		if (side !== current) {
			await current.process.close();
			return;
		}
		for (const info of await current.process.commands()) {
			if (!COMMANDS.includes(info)) current.commands.add(info);
		}
		view.attach(current.process);
		show(current);
		if (message) submit(current, message);
	};

	/** Ctrl+/ switches views, and in the side view Ctrl+C on an empty editor closes it and Esc stops it. */
	const handleKey = (data: string): { consume: true } | undefined => {
		const current = side;
		// Terminals with the kitty keyboard protocol also report releases, which would act a second time.
		if (!current?.process || !ctx || isKeyRelease(data)) return undefined;
		if (matchesKey(data, "ctrl+/") || matchesKey(data, "ctrl+7")) {
			if (current.view.visible) hide(current);
			else show(current);
			return { consume: true };
		}
		if (!current.view.visible || !current.view.editorFocused) return undefined;
		if (matchesKey(data, "ctrl+c") && ctx.ui.getEditorText() === "") {
			void close();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// Esc belongs to the side conversation here, never to the hidden parent.
			current.process.abort().catch(() => {});
			return { consume: true };
		}
		return undefined;
	};

	for (const name of COMMANDS) {
		pi.registerCommand(name, {
			description: "start a side conversation in an ephemeral fork",
			handler: async (args, context) => {
				if (context.mode !== "tui") {
					context.ui.notify(`'/${name}' needs Pi's interactive mode`, "error");
					return;
				}
				await open(context, args.trim());
			},
		});
	}

	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (context.mode === "tui") stopKeys = context.ui.onTerminalInput(handleKey);
	});

	pi.on("session_shutdown", async () => {
		stopKeys?.();
		stopKeys = undefined;
		await close();
		ctx?.ui.setWidget(KEY, undefined);
		ctx = undefined;
	});

	pi.on("agent_start", () => {
		if (!side) return;
		side.parentStatus = undefined;
		updateLabel();
	});

	pi.on("agent_end", (event: AgentEndEvent) => {
		if (!side) return;
		const last = event.messages.findLast((message) => message.role === "assistant");
		const reason = last && "stopReason" in last ? last.stopReason : undefined;
		side.parentStatus = reason === "aborted" ? "main interrupted" : reason === "error" ? "main failed" : "main finished";
		updateLabel();
	});
}
