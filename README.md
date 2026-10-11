# pi-side-chat

Codex's `/side` conversations for [Pi](https://pi.dev).

`/side` forks the current conversation into an ephemeral side conversation, so you can ask a quick question without disturbing the main thread, even while it is working.

## Usage

| Input | Effect |
|---|---|
| `/side` or `/btw` | Open a side conversation and wait for your question |
| `/side <question>` | Open a side conversation and ask the question |
| `ctrl + /` (or `ctrl + 7`) | Switch between the side conversation and the main thread without closing either |
| `ctrl + c` on an empty editor | Close the side conversation and return to the main thread |
| `esc` | Stop the side conversation's current turn |

Only one side conversation is open at a time. It is never saved.

## Behavior

- The side conversation starts from the main thread's history so far, with the same model, thinking level, tools, extensions and session id. Requests share the main thread's prompt cache.
- Codex's side-conversation instructions and boundary prompt follow the inherited history as one hidden message, verbatim. They tell the model to answer questions and avoid continuing or changing the main thread's work. If the main thread is in the middle of a turn, Codex's interrupted-turn marker comes first.
- Extension state recorded in the main session is not inherited, so extensions in the side conversation start fresh instead of resuming the main thread's loops or plans.
- The side conversation runs in its own Pi process. Its extensions cannot interfere with the main thread's, and closing it ends anything it started.
- Like switching threads in Codex, switching swaps everything that belongs to a conversation: the transcript, the working and compaction indicators, the footer and the editor's draft. Pi draws all of it, so the side conversation looks the same as the main thread.
- Extension dialogs, notifications and footer status entries from the side conversation show up in Pi. Its widgets are dropped.
- Slash commands that the side conversation cannot run itself are unavailable there, as in Codex.

`ctrl + /` needs a terminal that reports it, such as one with the kitty keyboard protocol.

## Install

```sh
pi install git:github.com/YanzuoLu/pi-side-chat
```

## Compatibility

Pi has no extension API for a second conversation view, so `src/view.ts` uses Pi's interactive mode internals. It checks them when a side conversation opens and reports an error if a Pi release changes them.

## License

MIT
