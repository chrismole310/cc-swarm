# CC Swarm

**Connect multiple Claude Code instances into a coordinated production swarm.**

Turn 3-10 machines running Claude Code into a unified AI workforce. Shared state, task queues, real-time messaging, file coordination — all through native CC tools.

---

## The Problem

Claude Code is powerful on one machine. But production work happens across many:
- A render farm for video/audio generation
- A server for backend services and deployments
- A posting machine for social media automation
- A dev box for coding and testing

Each CC works in isolation. No shared context. No task coordination. No way to say "CC1, render this — CC3, post it when done."

## The Solution

CC Swarm adds 13 native tools to every Claude Code instance:

```
You: "Check the swarm"
CC:  ⚡ 3 nodes online — CC1 (engine), CC2 (render), CC3 (posting)
     📋 2 tasks pending, 1 in progress
     💬 5 unread messages

You: "Assign the video render to CC2 and tell CC3 to post it when done"
CC:  ✅ Task assigned to CC2 — Mac Studio
     💬 Message sent to CC3 — "Post video when CC2 completes render"
```

## Quick Start

### 1. Start the Hub (any machine)

```bash
npx @atlas/cc-swarm-hub
# ⚡ CC Swarm Hub running on port 7777
# Dashboard: http://localhost:7777
```

### 2. Connect Each CC

Add to `~/.claude/settings.json` on each machine:

```json
{
  "mcpServers": {
    "cc-swarm": {
      "command": "npx",
      "args": ["@atlas/cc-swarm-mcp"],
      "env": {
        "SWARM_HUB": "http://192.168.1.100:7777",
        "SWARM_NODE_ID": "my-machine",
        "SWARM_ROLE": "render-farm"
      }
    }
  }
}
```

### 3. Done

Every CC now has swarm tools. Ask it to check status, assign tasks, message other nodes, share files, or coordinate workflows.

## Tools

| Tool | Description |
|------|-------------|
| `swarm_status` | Dashboard view — nodes, tasks, messages |
| `swarm_nodes` | List all connected CCs with roles |
| `swarm_assign_task` | Create and assign work to a specific CC |
| `swarm_claim_task` | Pick up the next available task |
| `swarm_complete_task` | Mark a task done with results |
| `swarm_get_tasks` | View task queue (filter by status/assignee) |
| `swarm_broadcast` | Message all CCs at once |
| `swarm_message` | Direct message a specific CC |
| `swarm_get_messages` | Read messages sent to this CC |
| `swarm_set_state` | Set shared key-value state |
| `swarm_get_state` | Read shared state |
| `swarm_share_file` | Announce a file is ready for other CCs |
| `swarm_get_files` | List all shared files |

## Dashboard

The hub includes a live web dashboard at `http://hub-ip:7777`:

- Real-time node status (online/offline)
- Task queue with priorities
- Live WebSocket event feed
- Message history

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   CC1        │     │   CC2        │     │   CC3        │
│   Engine     │     │   Render     │     │   Posting    │
│   + MCP      │     │   + MCP      │     │   + MCP      │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │     HTTP/WS        │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  CC Swarm Hub  │
                    │  Port 7777     │
                    │  SQLite + WS   │
                    └───────────────┘
```

- **Hub**: Express + WebSocket + SQLite. Zero-config, portable, single process.
- **MCP Server**: Runs alongside each CC. Translates swarm tools → Hub API calls.
- **Transport**: HTTP REST for operations, WebSocket for real-time events.

## Use Cases

### Production Studio
- **CC1** (Mac Mini): Runs PM2 services, handles deployments
- **CC2** (Mac Studio): Renders video, generates audio, processes images
- **CC3** (Mac Mini): Posts to social media, manages distribution

### Development Team
- **CC1** (Dev Server): Runs tests, CI/CD
- **CC2** (Local): Writes code, reviews PRs
- **CC3** (Staging): Deploys and monitors

### Content Factory
- **CC1**: Writes content, generates scripts
- **CC2**: Creates visuals, renders video
- **CC3**: Posts to all platforms, tracks engagement

## What We Built With It

In 3 days with a 3-machine CC Swarm, one person produced:
- 20 audiobooks (200+ hours of content)
- 40 AI-generated music tracks
- 20 video spots for social media
- Multi-platform social campaign (TikTok, YouTube, X)
- Voice cloning + custom VO generation
- 9,000+ videos downloaded and organized
- 8,600+ photos exported and cataloged

That's what happens when AI agents work together.

## License

MIT

## Built by

[Backbone Logic](https://backbonelogic.com) — AI-powered production infrastructure.
