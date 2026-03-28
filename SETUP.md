# CC Swarm — Setup Guide

## Quick Start (3 steps)

### Step 1: Start the Hub (on one machine)

```bash
cd cc-swarm/server
npm install
node index.js
# Hub running on port 7777
```

### Step 2: Add to Claude Code Settings (on each machine)

Add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cc-swarm": {
      "command": "node",
      "args": ["/path/to/cc-swarm/mcp-server/index.js"],
      "env": {
        "SWARM_HUB": "http://192.168.1.95:7777",
        "SWARM_NODE_ID": "cc2",
        "SWARM_NAME": "CC2 — Mac Studio",
        "SWARM_ROLE": "render-farm"
      }
    }
  }
}
```

### Step 3: Use It

Claude Code now has these tools available:

| Tool | What it does |
|------|-------------|
| `swarm_status` | See all nodes, tasks, messages |
| `swarm_nodes` | List all connected CCs |
| `swarm_assign_task` | Give work to another CC |
| `swarm_claim_task` | Pick up work from the queue |
| `swarm_complete_task` | Mark work as done |
| `swarm_broadcast` | Message all CCs |
| `swarm_message` | DM a specific CC |
| `swarm_set_state` | Share data across all CCs |
| `swarm_get_state` | Read shared data |
| `swarm_share_file` | Announce a file is ready |

### Example Conversation

```
You: "Check the swarm status"
CC: [uses swarm_status] "3 nodes online, 2 pending tasks..."

You: "Assign the audiobook upload to CC1"
CC: [uses swarm_assign_task] "Task assigned to CC1 — Mac Mini 1"

You: "Tell all CCs the campaign is live"
CC: [uses swarm_broadcast] "Broadcast sent to 3 nodes"
```

## Architecture

```
Machine 1 (Hub)          Machine 2              Machine 3
┌──────────────┐         ┌──────────┐          ┌──────────┐
│ Swarm Hub    │◄───────►│ CC + MCP │◄────────►│ CC + MCP │
│ (port 7777)  │  HTTP   │ Server   │  HTTP    │ Server   │
│ + Dashboard  │         └──────────┘          └──────────┘
│ + SQLite     │
│ + WebSocket  │
└──────────────┘
```
