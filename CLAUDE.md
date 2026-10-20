# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A WhatsApp bot that transcribes voice messages using OpenAI Whisper. It runs as a linked WhatsApp device via `@open-wa/wa-automate` (headless Chrome). All logic lives in `index.js`; the session is not persisted, so the QR code must be scanned again on every restart; there is no build step, linter, or test suite.

## Commands

```bash
npm install
node index.js          # prints a QR code; scan it via WhatsApp "Link a device".
                       # Ready when console shows: 🚀 @OPEN-WA ready for account: XXXX
DEBUG=1 node index.js  # logs every reaction and message object

docker build . -t whats   # image is based on openwa/wa-automate (bundles Chrome)
```

Requires Node >= 16 and `ffmpeg` when running outside Docker.

## Configuration (env vars, loaded via dotenv from `.env`)

- `OPENAI_API_KEY` — required.
- `GROUPS` — comma-separated group chat IDs (`...@g.us`) allowed to be transcribed. Private (non-group) chats are always allowed.
- `PATH_MP3` — where decrypted audio files are written (default `.`). Files are not deleted after transcription (the `unlink` is commented out).
- `TRIGGER_WORD` — text that triggers transcription when sent as a reply to an audio (default `ler`, case-insensitive, must be the whole message).
- `TRANSLATE_MODEL` — chat model used for flag translations (default `gpt-4o-mini`).
- `DEBUG` — verbose logging.

## Flow

At startup `checkOpenAI` runs before `wa.create` and exits with code 1 on failure: `retrieveModel('whisper-1')` validates the key, then a 1s silent WAV is transcribed (~US$0.0001) to detect `insufficient_quota` — OpenAI has no API endpoint for the credit balance.


The trigger is replying to an audio message with `TRIGGER_WORD` or a country flag: `client.onAnyMessage` → `processMessage` → `transcribe`. `onAnyMessage` (not `onMessage`) so the host account's own `ler` also counts.

1. `parseTrigger`: the message body (trimmed, lowercased) must equal `TRIGGER_WORD`, **or** be a single country flag emoji (two regional indicator symbols → ISO code, e.g. 🇫🇷 → `FR`). The chat must be allowed.
2. The quoted message ID comes from `quotedMsgObj.id` / `quotedMsg.id` and is re-fetched with `getMessageById`.
3. Ignored unless it's audio. An in-memory `Set` keyed by `msgId|country` dedupes so multiple identical triggers don't re-transcribe (cleared on failure to allow retry; lost on restart).
4. `decryptAudio` (own download + HKDF/AES-256-CBC decrypt; `@open-wa/decrypt` 5.6.6 fails with `wrong final block length` because it doesn't strip WhatsApp's trailing 10-byte MAC) → write file → `openai.createTranscription(..., "whisper-1")` → reply to the audio with the text in a code block. For a flag trigger, the transcription is first translated by `translate` (`createChatCompletion` with `TRANSLATE_MODEL`, into the main language of the country named via `Intl.DisplayNames`) and the reply is prefixed with the flag. Whisper's own translation endpoint only outputs English, hence the chat model.

Uses open-wa **5.x**: it has no `onReaction` (nor any star/favorite event), and 4.x no longer authenticates against current WhatsApp, so reactions are not an option.

Notes:
- Uses the **v3** `openai` SDK API (`Configuration` / `OpenAIApi` / `createTranscription`, response in `resp.data.text`) — not the v4+ client.
- `index.js` requires `mime-types`, which is not declared in `package.json` (only `mime` is); it currently resolves as a transitive dependency.
- The README's `SECRET_WORD` (`!ler`) is outdated; the trigger is now `TRIGGER_WORD` (`ler`) as a reply to the audio.
- Code comments and log messages are in Portuguese.

## CI/CD

- `.github/workflows/docker-image.yml`: on push to `main`, builds and pushes `$DOCKER_USER/whatsapptranscription:latest` to Docker Hub.
- `.gitlab-ci.yml`: builds/pushes to the GitLab registry, then calls `WEBHOOK_PORTAINER` URL(s) to redeploy in Portainer.
