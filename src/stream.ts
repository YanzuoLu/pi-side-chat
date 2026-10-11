import { type AssistantMessage, type AssistantMessageEvent, parseStreamingJson } from "@earendil-works/pi-ai";
import type { SideEvent } from "./child.ts";

type Delta = Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>;
type WithoutPartial<T> = T extends unknown ? Omit<T, "partial"> : never;
type WireDelta = WithoutPartial<Delta> & { id?: string; toolName?: string };

/**
 * The assistant message being streamed, rebuilt from the deltas that Pi's RPC mode sends instead
 * of the whole message on every update.
 */
export class StreamingMessage {
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
