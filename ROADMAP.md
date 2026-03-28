# CC Swarm — Roadmap

## v0.2.0 — Auto-Setup & Visual Network Map

### Auto-Setup (one command does everything)
- [ ] Scan network for all machines
- [ ] Auto-detect SSH access
- [ ] Auto-install Node.js (portable, no sudo)
- [ ] Auto-install Claude Code
- [ ] Auto-install lightning bolt menu bar app
- [ ] Auto-install Python + rumps (via miniconda if needed)
- [ ] Run connectivity tests between all machines
- [ ] Confirm all connections
- [ ] Generate status report
- [ ] One command: `npx @atlas/cc-swarm --setup`

### Lightning Bolt Dashboard (visual network map)
- [ ] Graphic representation of all connected machines
- [ ] Node system visualization (circles connected by lines)
- [ ] Animated pulses between nodes when communicating
- [ ] Real-time task flow visualization (which node is working on what)
- [ ] Color-coded status (green=active, yellow=busy, red=offline)
- [ ] Click a node to see its details/tasks/messages
- [ ] Show data flow direction (arrows between nodes)
- [ ] Display in both menu bar dropdown AND web dashboard

## v0.3.0 — Intelligence
- [ ] Auto-detect machine capabilities (GPU, RAM, installed tools)
- [ ] Learning router (tracks which machine handles which tasks fastest)
- [ ] Load balancing (don't overload one machine)
- [ ] Task dependencies (Task B waits for Task A to complete)
- [ ] Retry failed tasks on different nodes

## v1.0.0 — Launch
- [ ] npm package: `npx @atlas/cc-swarm`
- [ ] Claude Code skill marketplace listing
- [ ] Product Hunt launch
- [ ] Course/playbook for setup
- [ ] B2B sales page
