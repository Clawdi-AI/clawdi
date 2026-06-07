# Discord capture fixtures

Ground-truth JSONL captures of real Discord REST + WS gateway traffic used by
the Discord parity tests. Each directory is one scenario.

## Scenarios

| Slug | What it captures |
|---|---|
| 01-startup | Gateway handshake: HELLO → IDENTIFY → READY → GUILD_CREATE |
| 02-heartbeat | Idle heartbeat cycle (op=1 client → op=11 server ACK) |
| 03-receive-channel-message | User sends message; bot observes MESSAGE_CREATE |
| 04-send-channel-message | Bot POSTs a channel message |
| 07-reaction-add | User adds 👍 to a bot message |
| 08-bot-reacts | Bot PUTs a 👀 reaction via `/reactions/:emoji/@me` |
| 09-register-global-commands | PUT `/applications/:id/commands` |
| 10-register-guild-commands | PUT `/applications/:id/guilds/:id/commands` |
| 11-slash-command-invocation | INTERACTION_CREATE + POST `/interactions/:id/:token/callback` (type=4) |
| 12-edit-message | PATCH `/channels/:id/messages/:id` |
| 13-delete-message | DELETE `/channels/:id/messages/:id` |
| 17-button-component | Button click + UPDATE_MESSAGE (type=7) |
| 18-select-menu | String select menu pick + CHANNEL_MESSAGE_WITH_SOURCE (type=4) |
| 19-modal | MODAL (type=9) open + MODAL_SUBMIT (interaction type=5) |
| 20-deferred-followup | DEFERRED (type=5 callback) + webhook-token followup |
| 21-bot-send-single-image | Bot POSTs multipart with one image (red.png) |
| 22-user-send-single-image | User uploads red.png; bot observes MESSAGE_CREATE with attachments[1] |
| 23-bot-send-multiple-images | Bot POSTs multipart with two images (red + blue) |
| 24-user-send-multiple-images | User uploads red + blue together; attachments[2] |
| 25-bot-send-data-file | Bot POSTs multipart with a `.txt` attachment |
| 26-user-send-data-file | User uploads notes.txt; observes `content_type: text/plain; charset=utf-8` |
| 27-user-voice-message | User records and sends a voice message; `flags: 8192` + `duration_secs` + `waveform` |
| 28-thread-create-and-post | Create thread under seed message + post in it (THREAD_CREATE, THREAD_MEMBER_UPDATE) |
| 29-multi-channel | Same session posts into two different channels; both MESSAGE_CREATE echoes carry distinct `channel_id`s |

## Deliberately Absent Scenarios

- **05-receive-dm / 06-send-dm** — same wire shape as 03/04 with `guild_id`
  absent. Add later if the emulator's DM path needs a dedicated fixture.
- **14-reconnect-resume** — optional in the spec; deferred.
- **15-rate-limit** — optional; Discord's 5/5s per-channel cap is easy
  to hit but hides 429s behind library-level retry in most clients.
- **16-message-content-intent** — the MESSAGE_CONTENT privileged intent
  is already enabled on the test bot; scenario 03 implicitly verifies it
  (the captured `d.content` is non-empty for a non-mentioning message).

## How To Read

Each scenario directory has:

- `manifest.json` — application/guild/channel IDs, intents, duration, counts
- `capture.jsonl` — one frame per line, in the order they occurred

Each line carries `ts` (millis since scenario start) plus:

- `kind: "rest"` — REST request or response pair. `direction=c2s` carries
  `method`, `path`, `headers`, `body`. `direction=s2c` carries `status`,
  `headers`, `body`.
- `kind: "ws"` — gateway frame. `direction=c2s` for bot→Discord,
  `s2c` otherwise. `op` is the gateway opcode; `t` is the dispatch type
  (only on op=0 DISPATCH events); `s` is the sequence number; `d` is the
  payload, already inflated from zlib-stream if the client requested
  compression.

## Security Caveat

The captured REST `Authorization` header, Gateway `IDENTIFY.d.token`, and
interaction/webhook tokens are replaced with fixture placeholders. Keep future
fixture captures redacted before committing them.
