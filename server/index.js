/**
 * CC Swarm Hub — MCP-compatible server for multi-machine Claude Code orchestration
 *
 * Provides: registration, task queue, messaging, shared state, file notifications
 * Protocol: REST API + WebSocket for real-time updates
 * Storage: SQLite (zero-config, portable)
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SWARM_PORT || 7777;

// ── Database Setup ──────────────────────────────────────────
const db = new Database(join(__dirname, 'swarm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'general',
    hostname TEXT,
    ip TEXT,
    capabilities TEXT DEFAULT '[]',
    status TEXT DEFAULT 'online',
    last_heartbeat INTEGER DEFAULT (unixepoch()),
    registered_at INTEGER DEFAULT (unixepoch()),
    metadata TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    assigned_to TEXT,
    created_by TEXT,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 5,
    result TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    started_at INTEGER,
    completed_at INTEGER,
    metadata TEXT DEFAULT '{}',
    FOREIGN KEY (assigned_to) REFERENCES nodes(id),
    FOREIGN KEY (created_by) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_node TEXT,
    to_node TEXT,
    channel TEXT DEFAULT 'general',
    content TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (from_node) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_by TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    type TEXT,
    shared_by TEXT,
    description TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (shared_by) REFERENCES nodes(id)
  );
`);

// ── Express + WebSocket ─────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track connected WebSocket clients by node ID
const wsClients = new Map();

wss.on('connection', (ws, req) => {
  const nodeId = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('node_id');
  if (nodeId) {
    wsClients.set(nodeId, ws);
    console.log(`[WS] Node connected: ${nodeId}`);
    ws.on('close', () => {
      wsClients.delete(nodeId);
      console.log(`[WS] Node disconnected: ${nodeId}`);
    });
  }
});

function broadcast(event, data, excludeNode = null) {
  const msg = JSON.stringify({ event, data, timestamp: Date.now() });
  wsClients.forEach((ws, nodeId) => {
    if (nodeId !== excludeNode && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function notifyNode(nodeId, event, data) {
  const ws = wsClients.get(nodeId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ event, data, timestamp: Date.now() }));
  }
}

// ── API: Node Registration ──────────────────────────────────

// Register a new CC node
app.post('/api/nodes/register', (req, res) => {
  const { name, role, hostname, ip, capabilities, metadata } = req.body;
  const id = req.body.id || uuidv4().slice(0, 8);

  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, name, role, hostname, ip, capabilities, status, last_heartbeat, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 'online', unixepoch(), ?)
  `).run(id, name, role || 'general', hostname, ip,
         JSON.stringify(capabilities || []), JSON.stringify(metadata || {}));

  broadcast('node_registered', { id, name, role }, id);
  console.log(`[REG] ${name} (${id}) registered as ${role}`);
  res.json({ success: true, node_id: id });
});

// Heartbeat
app.post('/api/nodes/:id/heartbeat', (req, res) => {
  db.prepare('UPDATE nodes SET last_heartbeat = unixepoch(), status = ? WHERE id = ?')
    .run(req.body.status || 'online', req.params.id);
  res.json({ success: true });
});

// Get all nodes
app.get('/api/nodes', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY registered_at').all();
  nodes.forEach(n => {
    n.capabilities = JSON.parse(n.capabilities || '[]');
    n.metadata = JSON.parse(n.metadata || '{}');
    // Mark as offline if no heartbeat in 5 minutes
    if (Date.now() / 1000 - n.last_heartbeat > 300) {
      n.status = 'offline';
    }
  });
  res.json(nodes);
});

// Get single node
app.get('/api/nodes/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  node.capabilities = JSON.parse(node.capabilities || '[]');
  node.metadata = JSON.parse(node.metadata || '{}');
  res.json(node);
});

// ── API: Task Queue ─────────────────────────────────────────

// Import smart router
import { routeTask, explainRouting } from './router.js';

// Create task (with auto-routing if assigned_to is omitted)
app.post('/api/tasks', (req, res) => {
  let { title, description, assigned_to, created_by, priority, metadata } = req.body;
  const id = uuidv4().slice(0, 12);

  // AUTO-ROUTE: if no assigned_to, find the best node
  let routing_reason = null;
  if (!assigned_to) {
    const nodes = db.prepare('SELECT * FROM nodes').all();
    assigned_to = routeTask(title, description || '', nodes);
    if (assigned_to) {
      routing_reason = explainRouting(title, description || '', nodes);
      console.log(`[ROUTE] Auto-routed "${title}" → ${assigned_to}: ${routing_reason}`);
    }
  }

  db.prepare(`
    INSERT INTO tasks (id, title, description, assigned_to, created_by, priority, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, assigned_to, created_by, priority || 5,
         JSON.stringify(metadata || {}));

  const task = { id, title, description, assigned_to, created_by, status: 'pending', priority };

  if (assigned_to) {
    notifyNode(assigned_to, 'task_assigned', task);
  }
  broadcast('task_created', task);

  console.log(`[TASK] Created: ${title} → ${assigned_to || 'unassigned'}`);
  res.json({ success: true, task_id: id, task });
});

// Claim next available task
app.post('/api/tasks/claim', (req, res) => {
  const { node_id, role } = req.body;

  // Find highest priority unassigned task, optionally filtered by metadata
  const task = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending' AND assigned_to IS NULL
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `).get();

  if (!task) return res.json({ success: false, message: 'No tasks available' });

  db.prepare(`
    UPDATE tasks SET assigned_to = ?, status = 'in_progress', started_at = unixepoch()
    WHERE id = ?
  `).run(node_id, task.id);

  task.assigned_to = node_id;
  task.status = 'in_progress';
  broadcast('task_claimed', { task_id: task.id, node_id });

  console.log(`[TASK] Claimed: ${task.title} by ${node_id}`);
  res.json({ success: true, task });
});

// Complete task
app.post('/api/tasks/:id/complete', (req, res) => {
  const { result, node_id } = req.body;

  db.prepare(`
    UPDATE tasks SET status = 'completed', result = ?, completed_at = unixepoch()
    WHERE id = ?
  `).run(result, req.params.id);

  broadcast('task_completed', { task_id: req.params.id, node_id, result });
  console.log(`[TASK] Completed: ${req.params.id}`);
  res.json({ success: true });
});

// Get tasks
app.get('/api/tasks', (req, res) => {
  const { status, assigned_to } = req.query;
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (status) { query += ' AND status = ?'; params.push(status); }
  if (assigned_to) { query += ' AND assigned_to = ?'; params.push(assigned_to); }

  query += ' ORDER BY priority DESC, created_at DESC';
  const tasks = db.prepare(query).all(...params);
  tasks.forEach(t => t.metadata = JSON.parse(t.metadata || '{}'));
  res.json(tasks);
});

// ── API: Messaging ──────────────────────────────────────────

// Send message
app.post('/api/messages', (req, res) => {
  const { from_node, to_node, channel, content } = req.body;
  const id = uuidv4().slice(0, 12);

  db.prepare(`
    INSERT INTO messages (id, from_node, to_node, channel, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, from_node, to_node, channel || 'general', content);

  const msg = { id, from_node, to_node, channel, content };

  if (to_node) {
    notifyNode(to_node, 'message', msg);
  } else {
    broadcast('message', msg, from_node);
  }

  res.json({ success: true, message_id: id });
});

// Get messages for a node
app.get('/api/messages/:node_id', (req, res) => {
  const { unread_only, channel } = req.query;
  let query = 'SELECT * FROM messages WHERE (to_node = ? OR to_node IS NULL)';
  const params = [req.params.node_id];

  if (unread_only === 'true') { query += ' AND read = 0'; }
  if (channel) { query += ' AND channel = ?'; params.push(channel); }

  query += ' ORDER BY created_at DESC LIMIT 50';
  const messages = db.prepare(query).all(...params);

  // Mark as read
  if (messages.length > 0) {
    const ids = messages.map(m => m.id);
    db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
  }

  res.json(messages);
});

// Broadcast message
app.post('/api/messages/broadcast', (req, res) => {
  const { from_node, content, channel } = req.body;
  const id = uuidv4().slice(0, 12);

  db.prepare(`
    INSERT INTO messages (id, from_node, to_node, channel, content)
    VALUES (?, ?, NULL, ?, ?)
  `).run(id, from_node, channel || 'general', content);

  broadcast('broadcast', { from_node, content, channel }, from_node);
  console.log(`[MSG] Broadcast from ${from_node}: ${content.substring(0, 50)}`);
  res.json({ success: true, message_id: id });
});

// ── API: Shared State ───────────────────────────────────────

// Get state
app.get('/api/state', (req, res) => {
  const rows = db.prepare('SELECT * FROM state ORDER BY key').all();
  const state = {};
  rows.forEach(r => {
    try { state[r.key] = JSON.parse(r.value); }
    catch { state[r.key] = r.value; }
  });
  res.json(state);
});

// Get single key
app.get('/api/state/:key', (req, res) => {
  const row = db.prepare('SELECT * FROM state WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Key not found' });
  try { row.value = JSON.parse(row.value); } catch {}
  res.json(row);
});

// Set state
app.post('/api/state', (req, res) => {
  const { key, value, node_id } = req.body;
  const val = typeof value === 'string' ? value : JSON.stringify(value);

  db.prepare(`
    INSERT OR REPLACE INTO state (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, unixepoch())
  `).run(key, val, node_id);

  broadcast('state_updated', { key, value, updated_by: node_id });
  res.json({ success: true });
});

// ── API: File Sharing ───────────────────────────────────────

// Share file notification
app.post('/api/files/share', (req, res) => {
  const { filename, path, size, type, shared_by, description } = req.body;
  const id = uuidv4().slice(0, 12);

  db.prepare(`
    INSERT INTO files (id, filename, path, size, type, shared_by, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, filename, path, size, type, shared_by, description);

  broadcast('file_shared', { id, filename, path, shared_by, description });
  console.log(`[FILE] Shared: ${filename} by ${shared_by}`);
  res.json({ success: true, file_id: id });
});

// List shared files
app.get('/api/files', (req, res) => {
  const files = db.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT 100').all();
  res.json(files);
});

// ── API: Dashboard / Status ─────────────────────────────────

app.get('/api/status', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const pendingTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get();
  const activeTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'").get();
  const completedTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get();
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const sharedFiles = db.prepare('SELECT COUNT(*) as count FROM files').get();

  res.json({
    swarm: {
      name: 'Atlas CC Swarm',
      version: '0.1.0',
      uptime: process.uptime(),
      nodes_online: nodes.filter(n => Date.now() / 1000 - n.last_heartbeat < 300).length,
      nodes_total: nodes.length,
    },
    tasks: {
      pending: pendingTasks.count,
      active: activeTasks.count,
      completed: completedTasks.count,
    },
    messages: totalMessages.count,
    files: sharedFiles.count,
    nodes: nodes.map(n => ({
      id: n.id,
      name: n.name,
      role: n.role,
      status: Date.now() / 1000 - n.last_heartbeat < 300 ? 'online' : 'offline',
      last_seen: n.last_heartbeat,
    })),
  });
});

// Visual Network Dashboard with animated node connections
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>⚡ CC Swarm</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #050510; color: #e0e0e0; overflow: hidden; height: 100vh; }

    /* Network visualization canvas */
    #network { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }

    /* Header overlay */
    .header { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); text-align: center; z-index: 10; }
    .header h1 { font-size: 28px; color: #00ff88; letter-spacing: 3px; text-shadow: 0 0 30px rgba(0,255,136,0.3); }
    .header .subtitle { font-size: 12px; color: #555; margin-top: 5px; letter-spacing: 2px; }

    /* Stats bar */
    .stats-bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 30px; z-index: 10; background: rgba(10,10,20,0.8); padding: 12px 30px; border-radius: 30px; border: 1px solid #222; backdrop-filter: blur(10px); }
    .stat-item { text-align: center; }
    .stat-item .value { font-size: 24px; font-weight: bold; color: #00ff88; }
    .stat-item .label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px; }

    /* Live feed */
    .feed { position: fixed; right: 20px; top: 80px; width: 300px; max-height: calc(100vh - 140px); overflow-y: auto; z-index: 10; background: rgba(10,10,20,0.7); border-radius: 12px; border: 1px solid #1a1a2a; padding: 15px; backdrop-filter: blur(10px); }
    .feed h3 { font-size: 11px; color: #00ff88; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
    .feed-item { font-size: 11px; padding: 4px 0; color: #666; border-bottom: 1px solid #111; }
    .feed-item .event { color: #00ff88; }
    .feed-item .time { color: #333; }

    /* Task list */
    .tasks { position: fixed; left: 20px; top: 80px; width: 280px; z-index: 10; background: rgba(10,10,20,0.7); border-radius: 12px; border: 1px solid #1a1a2a; padding: 15px; backdrop-filter: blur(10px); }
    .tasks h3 { font-size: 11px; color: #00ff88; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
    .task-item { font-size: 11px; padding: 6px 0; border-bottom: 1px solid #111; }
    .task-item .title { color: #ccc; }
    .task-item .assigned { color: #00ff88; font-size: 10px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚡ CC SWARM</h1>
    <div class="subtitle" id="mode">INITIALIZING...</div>
  </div>

  <canvas id="network"></canvas>

  <div class="tasks">
    <h3>Task Queue</h3>
    <div id="task-list"></div>
  </div>

  <div class="feed">
    <h3>Live Feed</h3>
    <div id="feed"></div>
  </div>

  <div class="stats-bar">
    <div class="stat-item"><div class="value" id="nodes-count">-</div><div class="label">Nodes</div></div>
    <div class="stat-item"><div class="value" id="tasks-count">-</div><div class="label">Tasks</div></div>
    <div class="stat-item"><div class="value" id="msgs-count">-</div><div class="label">Messages</div></div>
    <div class="stat-item"><div class="value" id="files-count">-</div><div class="label">Files</div></div>
    <div class="stat-item"><div class="value" id="uptime">-</div><div class="label">Uptime</div></div>
  </div>

  <script>
    const canvas = document.getElementById('network');
    const ctx = canvas.getContext('2d');
    let nodes = [];
    let pulses = [];
    let particles = [];
    let frame = 0;

    // Machine icons (emoji representations)
    const ICONS = {
      'render-farm': '🖥️',
      'engine': '⚙️',
      'posting': '📱',
      'general': '💻',
    };

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Position nodes in a circle
    function layoutNodes(nodeData) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const radius = Math.min(canvas.width, canvas.height) * 0.25;

      nodes = nodeData.map((n, i) => {
        const angle = (i / nodeData.length) * Math.PI * 2 - Math.PI / 2;
        return {
          ...n,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          targetX: cx + Math.cos(angle) * radius,
          targetY: cy + Math.sin(angle) * radius,
          radius: 40,
          pulseRadius: 40,
          icon: ICONS[n.role] || '💻',
          glowIntensity: n.status === 'online' ? 1 : 0.2,
        };
      });
    }

    // Create a pulse between two nodes
    function createPulse(fromIdx, toIdx) {
      if (fromIdx >= nodes.length || toIdx >= nodes.length) return;
      pulses.push({
        from: fromIdx,
        to: toIdx,
        progress: 0,
        speed: 0.008 + Math.random() * 0.005,
        color: \`hsl(\${120 + Math.random() * 40}, 100%, 60%)\`,
        size: 3 + Math.random() * 3,
      });
    }

    // Create ambient particles
    function createParticle() {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        life: 1,
        decay: 0.002 + Math.random() * 0.003,
        size: Math.random() * 2,
      });
    }

    function draw() {
      frame++;
      ctx.fillStyle = 'rgba(5, 5, 16, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw grid (subtle)
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 60) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw connections between ALL nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const bothOnline = a.status === 'online' && b.status === 'online';

          // Connection line
          const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          const alpha = bothOnline ? 0.15 + Math.sin(frame * 0.02 + i) * 0.05 : 0.05;
          gradient.addColorStop(0, \`rgba(0, 255, 136, \${alpha})\`);
          gradient.addColorStop(0.5, \`rgba(0, 200, 255, \${alpha * 0.7})\`);
          gradient.addColorStop(1, \`rgba(0, 255, 136, \${alpha})\`);

          ctx.strokeStyle = gradient;
          ctx.lineWidth = bothOnline ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();

          // Animated dashes on active connections
          if (bothOnline) {
            ctx.strokeStyle = \`rgba(0, 255, 136, \${0.3 + Math.sin(frame * 0.05) * 0.1})\`;
            ctx.setLineDash([5, 15]);
            ctx.lineDashOffset = -frame * 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Draw pulses (data flowing between nodes)
      pulses = pulses.filter(p => {
        p.progress += p.speed;
        if (p.progress >= 1) return false;

        const a = nodes[p.from];
        const b = nodes[p.to];
        const x = a.x + (b.x - a.x) * p.progress;
        const y = a.y + (b.y - a.y) * p.progress;

        // Glow
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();

        // Trail
        ctx.shadowBlur = 0;
        ctx.fillStyle = \`rgba(0, 255, 136, 0.3)\`;
        for (let t = 0; t < 5; t++) {
          const tp = p.progress - t * 0.02;
          if (tp < 0) break;
          const tx = a.x + (b.x - a.x) * tp;
          const ty = a.y + (b.y - a.y) * tp;
          ctx.beginPath();
          ctx.arc(tx, ty, p.size * (1 - t * 0.15), 0, Math.PI * 2);
          ctx.fill();
        }

        return true;
      });

      // Draw particles
      if (Math.random() < 0.3) createParticle();
      particles = particles.filter(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) return false;

        ctx.fillStyle = \`rgba(0, 255, 136, \${p.life * 0.2})\`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });

      // Draw nodes
      for (const node of nodes) {
        const isOnline = node.status === 'online';
        const pulse = Math.sin(frame * 0.05) * 5;

        // Outer glow ring
        if (isOnline) {
          ctx.shadowColor = '#00ff88';
          ctx.shadowBlur = 20 + pulse;
          ctx.strokeStyle = \`rgba(0, 255, 136, \${0.2 + Math.sin(frame * 0.03) * 0.1})\`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 10 + pulse, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Node circle
        ctx.shadowBlur = isOnline ? 15 : 0;
        ctx.shadowColor = isOnline ? '#00ff88' : 'transparent';
        const grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius);
        grad.addColorStop(0, isOnline ? '#0a2a1a' : '#1a1a1a');
        grad.addColorStop(1, isOnline ? '#051510' : '#0a0a0a');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = isOnline ? '#00ff88' : '#333';
        ctx.lineWidth = isOnline ? 2 : 1;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Icon
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.icon, node.x, node.y - 2);

        // Name
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.fillStyle = isOnline ? '#00ff88' : '#555';
        ctx.fillText(node.name.replace('CC', '').replace(' — ', ''), node.x, node.y + node.radius + 18);

        // Role
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillStyle = '#666';
        ctx.fillText(node.role, node.x, node.y + node.radius + 32);

        // Status dot
        ctx.fillStyle = isOnline ? '#00ff88' : '#ff4444';
        ctx.shadowColor = isOnline ? '#00ff88' : '#ff4444';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(node.x + node.radius - 5, node.y - node.radius + 5, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Hub center indicator
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = \`rgba(0, 255, 136, \${0.3 + Math.sin(frame * 0.02) * 0.1})\`;
      ctx.fillText('⚡', cx, cy);
      ctx.font = '8px -apple-system, sans-serif';
      ctx.fillStyle = '#333';
      ctx.fillText('HUB', cx, cy + 14);

      // Random pulses between nodes
      if (frame % 60 === 0 && nodes.length > 1) {
        const from = Math.floor(Math.random() * nodes.length);
        let to = Math.floor(Math.random() * nodes.length);
        while (to === from) to = Math.floor(Math.random() * nodes.length);
        if (nodes[from].status === 'online' && nodes[to].status === 'online') {
          createPulse(from, to);
        }
      }

      requestAnimationFrame(draw);
    }

    // Fetch data and update
    async function refresh() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        layoutNodes(data.nodes);

        const online = data.swarm.nodes_online;
        const total = data.swarm.nodes_total;
        document.getElementById('nodes-count').textContent = online + '/' + total;
        document.getElementById('tasks-count').textContent = data.tasks.pending + data.tasks.active;
        document.getElementById('msgs-count').textContent = data.messages;
        document.getElementById('files-count').textContent = data.files;
        document.getElementById('uptime').textContent = Math.floor(data.swarm.uptime / 60) + 'm';

        document.getElementById('mode').textContent =
          online === total && total > 1 ? '⚡ BEAST MODE — ' + total + ' NODES CONNECTED' :
          online > 0 ? online + ' / ' + total + ' NODES ONLINE' : 'OFFLINE';

        // Tasks
        const tasksRes = await fetch('/api/tasks');
        const tasks = await tasksRes.json();
        document.getElementById('task-list').innerHTML = tasks.slice(0, 8).map(t =>
          '<div class="task-item"><div class="title">' + t.title + '</div><div class="assigned">→ ' + (t.assigned_to || 'unassigned') + ' · ' + t.status + '</div></div>'
        ).join('') || '<div style="color:#333;font-size:11px">No tasks</div>';

      } catch(e) {
        document.getElementById('mode').textContent = 'HUB UNREACHABLE';
      }
    }

    refresh();
    setInterval(refresh, 5000);
    draw();

    // WebSocket for live events
    const ws = new WebSocket('ws://' + location.host + '?node_id=dashboard');
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const feed = document.getElementById('feed');
      const time = new Date().toLocaleTimeString();
      feed.innerHTML = '<div class="feed-item"><span class="time">' + time + '</span> <span class="event">' + data.event + '</span> ' + JSON.stringify(data.data).substring(0, 60) + '</div>' + feed.innerHTML;

      // Create visual pulse on events
      if (nodes.length > 1) {
        const from = Math.floor(Math.random() * nodes.length);
        let to = Math.floor(Math.random() * nodes.length);
        while (to === from) to = Math.floor(Math.random() * nodes.length);
        createPulse(from, to);
        createPulse(to, from);
      }
    };
  </script>
</body>
</html>
  `);
});

// ── Start Server ────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ CC Swarm Hub running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
