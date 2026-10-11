import { describe, expect, it } from "vitest";
import { inheritedArgs } from "../src/child.ts";

describe("inheritedArgs", () => {
	it("keeps the flags that shape sessions and drops the rest", () => {
		const argv = [
			"--model", "gpt", "--thinking", "high", "--session", "s.jsonl", "-c", "--mode", "json",
			"-e", "./a.ts", "--extension", "./b.ts", "--tools", "read, bash", "-nc", "--skill", "./s",
			"--append-system-prompt", "extra", "--approve", "--plan", "--level=3", "hello", "@file.md",
		];
		expect(inheritedArgs(argv)).toEqual([
			"--append-system-prompt", "extra", "--tools", "read,bash",
			"--extension", "./a.ts", "--extension", "./b.ts", "--skill", "./s",
			"--no-context-files", "--approve", "--plan", "--level=3",
		]);
	});
});
