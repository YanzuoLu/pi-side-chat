import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Model } from "@earendil-works/pi-ai";
import { type ContextUsage, type ExtensionUIContext, parseArgs, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** A session event from the side process, as Pi's RPC mode prints it. */
export type SideEvent = { type: string; [key: string]: unknown };

export interface SideProcessOptions {
	cwd: string;
	sessionFile: string;
	sessionDir: string;
	/** The model and thinking level to start with, or the session's own when resuming one. */
	model?: { provider: string; id: string; thinking: string };
	/** Where the side's extension dialogs show up. */
	ui: () => ExtensionUIContext;
	/** Shows a notification from the side's extensions. */
	notify: (message: string, type: NotifyType) => void;
	/** Sets or clears a status entry from the side's extensions. */
	setStatus: (key: string, text: string | undefined) => void;
	onEvent: (event: SideEvent) => void;
	/** Called when the process ends without being closed. */
	onExit: (reason: string) => void;
}

export type NotifyType = "info" | "warning" | "error";

/** What the footer shows about the side session. */
export interface SideState {
	model?: Model<any>;
	thinkingLevel: string;
	autoCompactionEnabled: boolean;
	contextUsage?: ContextUsage;
}

type Response = { id?: string; success: boolean; data?: unknown; error?: string };

/**
 * A Pi session in its own process, driven over Pi's RPC mode.
 *
 * A separate process gives the side conversation its own copy of every extension, so nothing it
 * loads or runs touches the parent's module state, and closing it ends whatever it started. It runs
 * the same Pi as this process, with the same extensions and settings, outside herdr.
 */
export class SideProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, (response: Response) => void>();
	private nextId = 0;
	/** Followers of the session's events, told with undefined when the process ends. */
	private readonly watchers = new Set<(event: SideEvent | undefined) => void>();
	private stderr = "";
	private closing = false;
	private readonly exited: Promise<void>;

	private constructor(private readonly options: SideProcessOptions) {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")));
		const args = [
			...process.execArgv,
			process.argv[1]!,
			"--mode", "rpc",
			"--session", options.sessionFile,
			"--session-dir", options.sessionDir,
			...(options.model
				? ["--provider", options.model.provider, "--model", options.model.id, "--thinking", options.model.thinking]
				: []),
			...inheritedArgs(process.argv.slice(2)),
		];
		this.child = spawn(process.execPath, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-4000);
		});
		this.child.stdin.on("error", () => {});
		createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				const reason = this.stderr.trim() || `exited with ${signal ?? `code ${code}`}`;
				for (const resolvePending of this.pending.values()) resolvePending({ success: false, error: reason });
				this.pending.clear();
				for (const watcher of this.watchers) watcher(undefined);
				if (!this.closing) options.onExit(reason);
				resolve();
			});
		});
	}

	/** Starts the process and waits until it accepts commands. */
	static async start(options: SideProcessOptions): Promise<SideProcess> {
		const side = new SideProcess(options);
		await side.request({ type: "get_state" });
		return side;
	}

	/** Sends a user message, steering the current turn if one is running. */
	async prompt(message: string, streaming: boolean): Promise<void> {
		await this.request({ type: "prompt", message, ...(streaming ? { streamingBehavior: "steer" } : {}) });
	}

	/** Names of the commands the side session runs itself: extension commands, prompt templates and skills. */
	async commands(): Promise<string[]> {
		const data = (await this.request({ type: "get_commands" })) as { commands: { name: string }[] };
		return data.commands.map((command) => command.name);
	}

	/** The side session's entries after the one with id `since`. */
	async entries(since: string): Promise<SessionEntry[]> {
		const data = (await this.request({ type: "get_entries", since })) as { entries: SessionEntry[] };
		return data.entries;
	}

	async state(): Promise<SideState> {
		const [state, stats] = (await Promise.all([
			this.request({ type: "get_state" }),
			this.request({ type: "get_session_stats" }),
		])) as [Omit<SideState, "contextUsage">, { contextUsage?: ContextUsage }];
		return { ...state, contextUsage: stats.contextUsage };
	}

	/** Switches the side session to another model. Its thinking level follows Pi's rules for a model switch. */
	async setModel(provider: string, modelId: string): Promise<void> {
		await this.request({ type: "set_model", provider, modelId });
	}

	/** Takes the queued steering and follow-up messages out of the side session and returns their text. */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return (await this.request({ type: "clear_queue" })) as { steering: string[]; followUp: string[] };
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.request({ type: "set_thinking_level", level });
	}

	/**
	 * Sends a message while the side session is idle and returns the text of its last reply once it
	 * settles. A reply that calls a tool is stopped, since only text is wanted.
	 */
	async reply(message: string): Promise<string> {
		let last: { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> } | undefined;
		let calledTool = false;
		let watcher: ((event: SideEvent | undefined) => void) | undefined;
		const settled = new Promise<void>((resolve, reject) => {
			watcher = (event) => {
				if (!event) return reject(new Error("the side conversation ended"));
				if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
					last = event.message as typeof last;
				} else if (event.type === "tool_execution_start" && !calledTool) {
					calledTool = true;
					this.abort().catch(() => {});
				} else if (event.type === "agent_settled") {
					resolve();
				}
			};
			this.watchers.add(watcher);
		});
		// The process can end before the prompt is accepted, with nothing awaiting `settled` yet.
		settled.catch(() => {});
		try {
			await this.prompt(message, false);
			await settled;
		} finally {
			this.watchers.delete(watcher!);
		}
		if (calledTool) throw new Error("the model called a tool instead of replying");
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			throw new Error(last.errorMessage ?? `the reply was ${last.stopReason}`);
		}
		const text = (last?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
		if (!text) throw new Error("the model replied with no text");
		return text;
	}

	/** Stops whatever the side session is doing: its turn, a retry or a compaction. */
	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	/** Shuts the session down the way Pi does on exit, so its extensions clean up, then ends the process. */
	async close(): Promise<void> {
		if (this.closing) return this.exited;
		this.closing = true;
		this.child.stdin.end();
		const killer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		await this.exited;
		clearTimeout(killer);
	}

	private async request(command: Record<string, unknown>): Promise<unknown> {
		const id = `side-${++this.nextId}`;
		const response = await new Promise<Response>((resolve) => {
			this.pending.set(id, resolve);
			this.send({ ...command, id });
		});
		if (!response.success) throw new Error(response.error ?? `${String(command.type)} failed`);
		return response.data;
	}

	private send(message: Record<string, unknown>): void {
		if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		let message: SideEvent;
		try {
			message = JSON.parse(line) as SideEvent;
		} catch {
			return;
		}
		if (message.type === "response") {
			const response = message as unknown as Response;
			const resolve = response.id === undefined ? undefined : this.pending.get(response.id);
			if (resolve && response.id !== undefined) {
				this.pending.delete(response.id);
				resolve(response);
			}
		} else if (message.type === "extension_ui_request") {
			void this.answer(message);
		} else {
			for (const watcher of this.watchers) watcher(message);
			this.options.onEvent(message);
		}
	}

	/** Shows the side's extension dialogs, notifications and status entries. Its widgets and titles are dropped. */
	private async answer(request: SideEvent): Promise<void> {
		const ui = this.options.ui();
		const id = request.id as string;
		const title = request.title as string;
		const opts = typeof request.timeout === "number" ? { timeout: request.timeout } : undefined;
		const reply = (fields: Record<string, unknown>) => this.send({ type: "extension_ui_response", id, ...fields });
		const value = (result: string | undefined) => reply(result === undefined ? { cancelled: true } : { value: result });
		switch (request.method) {
			case "select":
				return value(await ui.select(title, request.options as string[], opts));
			case "confirm":
				return reply({ confirmed: await ui.confirm(title, request.message as string, opts) });
			case "input":
				return value(await ui.input(title, request.placeholder as string | undefined, opts));
			case "editor":
				return value(await ui.editor(title, request.prefill as string | undefined));
			case "setStatus":
				return this.options.setStatus(request.statusKey as string, request.statusText as string | undefined);
			case "notify":
				return this.options.notify(request.message as string, (request.notifyType as NotifyType | undefined) ?? "info");
		}
	}
}

/**
 * The flags this Pi was started with that shape its sessions: system prompt, tools, extensions,
 * skills, prompt templates, context files, trust and extension flags. The side session gets the
 * same ones, so its requests match the parent's and reuse its prompt cache.
 */
export function inheritedArgs(argv: string[]): string[] {
	const args = parseArgs(argv);
	const result: string[] = [];
	const flag = (name: string, on: boolean | undefined) => {
		if (on) result.push(name);
	};
	const value = (name: string, text: string | undefined) => {
		if (text !== undefined) result.push(name, text);
	};
	const each = (name: string, values: string[] | undefined) => values?.forEach((text) => result.push(name, text));
	value("--api-key", args.apiKey);
	value("--system-prompt", args.systemPrompt);
	each("--append-system-prompt", args.appendSystemPrompt);
	value("--models", args.models?.join(","));
	flag("--no-tools", args.noTools);
	flag("--no-builtin-tools", args.noBuiltinTools);
	value("--tools", args.tools?.join(","));
	value("--exclude-tools", args.excludeTools?.join(","));
	each("--extension", args.extensions);
	flag("--no-extensions", args.noExtensions);
	each("--skill", args.skills);
	flag("--no-skills", args.noSkills);
	each("--prompt-template", args.promptTemplates);
	flag("--no-prompt-templates", args.noPromptTemplates);
	flag("--no-context-files", args.noContextFiles);
	flag("--offline", args.offline);
	if (args.projectTrustOverride !== undefined) result.push(args.projectTrustOverride ? "--approve" : "--no-approve");
	for (const [name, text] of args.unknownFlags) result.push(text === true ? `--${name}` : `--${name}=${text}`);
	return result;
}
