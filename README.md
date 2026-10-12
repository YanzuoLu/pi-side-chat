# pi-side-chat

Codex's `/side` conversations for [Pi](https://pi.dev).

`/side` forks the current conversation into a side conversation, so you can ask a quick question without disturbing the main thread, even while it is working.

## Usage

| Input | Effect |
|---|---|
| `/side` or `/btw` | Open a new side conversation and wait for your question |
| `/side <question>` | Open a new side conversation and ask the question |
| `ctrl + /` (or `ctrl + 7`) | Switch between the main thread and the side conversation shown last, without closing either |
| `shift + ←` / `shift + →` | Go through the main thread and every open side conversation in order |
| `ctrl + s` | Hand off: close the side conversation shown after it writes a handoff, which is steered into the main thread |
| `ctrl + c` on an empty editor | Close the side conversation shown and return to the main thread |
| `esc` | Stop the side conversation's current turn, putting its queued messages back in the editor as Pi does |

Each `/side` opens another side conversation forked from the main thread, also when typed in a side conversation. Each runs as its own Pi process, so many open ones take memory. Once you ask something in it, it is saved as a session of its own next to the main thread's, and the line above the editor ends with its session id. Closing it shows the id again, and `pi --session <id>` resumes it in any window. A side conversation where you asked nothing is not kept.

Saved side conversations that are still open when you leave the main session, by quitting, `/reload`, `/new` or switching sessions, come back with it: they open again in the background, with their transcript, the next time the main session starts, and `shift + ←/→` or `ctrl + /` switches to them.

## Handoff

`ctrl + s` brings what happened in the side conversation back to the main thread. The main thread shows right away while the side conversation writes a handoff: what you asked and found there, decisions and requests you stated (quoted), and anything it changed. The handoff is steered into the main thread, so a working main thread sees it before its next model request and an idle one starts a turn with it. If writing the handoff fails, the side conversation stays open. A side conversation where you have not asked anything just closes.

By default the side conversation's own model and thinking level write the handoff, which reuses its prompt cache. `~/.pi/agent/pi-side-chat.json` can choose others:

```json
{ "handoff": { "model": "anthropic/claude-opus-5-5", "thinking": "low" } }
```

`model` is `provider/model-id`. `null` or a missing setting keeps the side conversation's own.

## Behavior

- The side conversation starts from the main thread's history so far, with the same model, thinking level, tools and extensions. Its requests share the main thread's prompt cache: for OpenAI models it uses the main thread's session id as its cache key, also when resumed later.
- Codex's side-conversation instructions and boundary prompt follow the inherited history as one hidden message, verbatim. They tell the model to answer questions and avoid continuing or changing the main thread's work. If the main thread is in the middle of a turn, Codex's interrupted-turn marker comes first.
- Extension state recorded in the main session is not inherited, so extensions in the side conversation start fresh instead of resuming the main thread's loops or plans.
- The side conversation runs in its own Pi process. Its extensions cannot interfere with the main thread's, and closing it ends anything it started.
- Like switching threads in Codex, switching swaps everything that belongs to a conversation: the transcript, the working and compaction indicators, the footer and the editor's draft. Pi draws all of it, so the side conversation looks the same as the main thread.
- Extension dialogs, notifications and footer status entries from the side conversation show up in Pi. Its widgets are dropped.
- Slash commands that the side conversation cannot run itself are unavailable there, as in Codex, and the editor only completes the ones it can.
- Pi's keys and input for the conversation shown act on the side conversation while it is shown: `!command` and `!!command` run in its shell, `shift + tab` cycles its thinking level, the model cycling keys and `ctrl + l` change its model, `esc` and `option + up` handle its queued messages, and the editor's border shows its thinking level.

`ctrl + /` needs a terminal that reports it, such as one with the kitty keyboard protocol.

## Install

```sh
pi install git:github.com/YanzuoLu/pi-side-chat
```

## Compatibility

Pi has no extension API for a second conversation view, so `src/view.ts` uses Pi's interactive mode internals. It checks them when a side conversation opens and reports an error if a Pi release changes them.

## License

MIT
