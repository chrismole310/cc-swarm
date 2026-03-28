# CC Swarm — Multi-Machine Claude Code Orchestration

## Product Vision
Connect 3-10 Claude Code instances across separate machines into a coordinated swarm.
Shared state, task distribution, real-time sync, unified command.

## How It Works

### Architecture
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   CC1        │     │   CC2        │     │   CC3        │
│   Mac Mini 1 │     │   Mac Studio │     │   Mac Mini 2 │
│   (Engine)   │     │   (Render)   │     │   (Posting)  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  CC Swarm Hub  │
                    │  (MCP Server)  │
                    │  - State sync  │
                    │  - Task queue  │
                    │  - File share  │
                    │  - Messaging   │
                    └───────────────┘
```

### Components

1. **CC Swarm MCP Server** (runs on one machine, accessible to all)
   - Shared state store (what each CC is working on)
   - Task queue (assign work across machines)
   - File transfer notifications (drop file → notify other CCs)
   - Inter-CC messaging (CC1 tells CC2 "render complete")
   - Health monitoring (which CCs are alive)

2. **CC Swarm Skill** (installed on each CC)
   - Registers this CC with the hub
   - Reads/writes shared state
   - Picks up tasks from the queue
   - Reports completion

3. **CC Swarm Dashboard** (optional web UI)
   - See all CCs and their status
   - View task queue
   - Monitor in real-time

### MCP Server Tools (what each CC gets access to)

| Tool | Description |
|------|-------------|
| `swarm_register` | Register this CC with role/capabilities |
| `swarm_status` | Get status of all connected CCs |
| `swarm_assign_task` | Create a task and assign to a specific CC |
| `swarm_claim_task` | Claim next available task for this CC |
| `swarm_complete_task` | Mark a task as complete with results |
| `swarm_broadcast` | Send message to all CCs |
| `swarm_message` | Send message to specific CC |
| `swarm_get_messages` | Get messages for this CC |
| `swarm_share_file` | Notify swarm about a shared file |
| `swarm_get_state` | Get shared state key/value |
| `swarm_set_state` | Set shared state key/value |

### Network Requirements
- All machines on same LAN (or VPN)
- SSH access between machines (already working for us)
- One machine runs the MCP server (port 7777)

### Distribution
- **Open source** on GitHub
- **npm package**: `@atlas/cc-swarm`
- **Claude Code skill** published to skill marketplace
- **B2B licensing** for enterprise teams

### Revenue Model
- Free: 3 CCs, basic sync
- Pro ($49/mo): 10 CCs, task queue, dashboard
- Enterprise ($199/mo): Unlimited CCs, priority support, custom integrations

## Technical Implementation

### Stack
- MCP Server: Node.js/TypeScript (standard MCP protocol)
- State store: SQLite (portable, zero-config)
- Transport: HTTP + WebSocket for real-time
- File sharing: Shared network drive or SSH/SCP

### Phase 1: MVP (this week)
- MCP server with register, status, messaging
- Shared state store
- Task assignment
- Test with our 3 CCs

### Phase 2: Polish
- Web dashboard
- npm package
- Claude Code skill format
- Documentation

### Phase 3: Launch
- GitHub repo
- npm publish
- Skill marketplace submission
- Product Hunt launch
- B2B outreach
