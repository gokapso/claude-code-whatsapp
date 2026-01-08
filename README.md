# Claude Code on WhatsApp

Run Claude Code via WhatsApp using Kapso and VibeKit.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Install dependencies: `pnpm install`
3. Run in development: `pnpm dev`

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `E2B_API_KEY` | E2B API key for sandboxes |
| `KAPSO_API_KEY` | Kapso API key |
| `PHONE_NUMBER_ID` | WhatsApp phone number ID |
| `GITHUB_REPO` | Repository to clone (e.g., `owner/repo`) |
| `GITHUB_TOKEN` | GitHub token for private repos (optional) |
| `WEBHOOK_SECRET` | Secret for Kapso webhook verification |

## Deployment

### Railway

```bash
railway init
railway up
```

Then configure webhook URL in Kapso dashboard: `https://your-app.railway.app/webhook`

### Docker

```bash
docker build -t claude-code-whatsapp .
docker run -p 3000:3000 --env-file .env claude-code-whatsapp
```

## Kapso setup

1. Go to Settings → Webhooks in Kapso dashboard
2. Add your server URL + `/webhook` as the endpoint
3. Copy the webhook secret to your `.env`
4. Enable `messages` event type
