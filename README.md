# WhatsApp Transcription

WhatsApp bot that transcribes voice messages using OpenAI Whisper. It runs as a linked WhatsApp device via [@open-wa/wa-automate](https://github.com/open-wa/wa-automate-nodejs).

You can find more information about OpenAI here: https://platform.openai.com/overview

# How it works

React to an audio message with the trigger emoji (default 🗣️) and the bot replies to that audio with its transcription.

* Only audio messages are transcribed.
* Private chats are always allowed; group chats must be listed in `GROUPS`.
* Each audio is transcribed only once, even if it receives several reactions (if transcription fails, reacting again retries it).

# Running locally

Requirements: NodeJS >= 16 and [ffmpeg](https://ffmpeg.org).

Create a `.env` file with your settings (see [Configuration](#configuration)), then:

```shell
npm install
node index.js
```

The console will show the QR code that you need to read using WhatsApp's option to link a device.
When you link your device, you need to wait for the application to sync with WhatsApp. This may take a while.
It will be ready when you see this message in the console:

```
🚀 @OPEN-WA ready for account: XXXX
```

Use `DEBUG=1 node index.js` to log every reaction and message received.

# Configuration

| Variable           | Default | Description |
|--------------------|---------|-------------|
| `OPENAI_API_KEY`   | —       | OpenAI API key (required). |
| `GROUPS`           | —       | Comma-separated group IDs (`...@g.us`) allowed to be transcribed. |
| `TRIGGER_REACTION` | `🗣️`    | Emoji reaction that triggers the transcription. |
| `PATH_MP3`         | `.`     | Directory where the audio files are saved. |
| `PATH_SESSION`     | `./`    | Directory for the WhatsApp session data. Persist it to avoid scanning the QR code again. |
| `DEBUG`            | —       | Enables verbose logging. |

# Docker

The image is based on `openwa/wa-automate`, which already bundles Chrome.

```shell
docker build . -t whats
```

# Docker Compose

Put the secrets and settings in `.env` (it is ignored by git and by the Docker build):

```shell
OPENAI_API_KEY=sk-xxxxxxx
GROUPS=aaaaaaaa-bbbbbbb@g.us,yyyyyyyyy-xxxxxxxx@g.us
```

```yaml
version: "3.5"
services:
  speech2text:
    build: .
    env_file: .env
    environment:
       - PATH_MP3=/mp3
       - PATH_SESSION=/session
    volumes:
       - session:/session
       - mp3:/mp3
volumes:
  session:
  mp3:
```

```shell
docker compose up -d
docker compose logs -f   # scan the QR code shown in the logs
```
