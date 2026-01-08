# Claude Code on WhatsApp

Run Claude Code via WhatsApp. Each user gets an isolated E2B sandbox where Claude Code can read, write, edit files and run commands.

## Architecture

```
WhatsApp → Kapso Webhook → Node.js Server → @dzhng/claude-agent → E2B Sandbox (Claude Agent SDK)
```

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Install dependencies: `npm install`
3. Build E2B template (first time only): `npm run build:e2b`
4. Run: `npm run dev`

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `E2B_API_KEY` | E2B API key for sandboxes |
| `KAPSO_API_KEY` | Kapso API key |
| `PHONE_NUMBER_ID` | WhatsApp phone number ID |
| `GITHUB_REPO` | Repository to clone (e.g., `owner/repo`) |
| `GITHUB_TOKEN` | GitHub token for private repos (optional) |
| `WEBHOOK_SECRET` | Secret for Kapso webhook verification (optional) |
| `E2B_TEMPLATE` | E2B template name (default: `claude-whatsapp-server`) |

## Building the E2B template

The server runs inside an E2B sandbox. You need to build the template first:

```bash
# Push code to GitHub first (build clones from GitHub)
git add . && git commit -m "Initial commit" && git push

# Build the E2B template
npm run build:e2b
```

For private repos, set `E2B_GITHUB_TOKEN`:
```bash
E2B_GITHUB_TOKEN=ghp_xxx npm run build:e2b
```

Custom repo/branch:
```bash
E2B_SOURCE_REPO=gokapso/claude-code-whatsapp E2B_SOURCE_BRANCH=main npm run build:e2b
```

## Project structure

```
├── src/                    # WhatsApp webhook server (Node.js)
│   ├── index.ts            # Express server
│   ├── handler.ts          # Message handler
│   ├── claude.ts           # Claude Agent client
│   ├── kapso.ts            # Kapso API client
│   └── formatter.ts        # WhatsApp message formatting
├── e2b-server/             # Server running inside E2B sandbox (Bun)
│   ├── index.ts            # WebSocket server
│   ├── build.ts            # E2B template build script
│   └── ...
```

## Kapso setup

1. Go to Settings → Webhooks in Kapso dashboard
2. Add your server URL + `/webhook` as the endpoint
3. Copy the webhook secret to your `.env`
4. Enable `messages` event type
