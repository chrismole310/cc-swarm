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

// Create task
app.post('/api/tasks', (req, res) => {
  const { title, description, assigned_to, created_by, priority, metadata } = req.body;
  const id = uuidv4().slice(0, 12);

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

// Simple dashboard HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>CC Swarm Hub</title>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
    h1 { color: #00ff88; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 20px; }
    .card h2 { color: #00ff88; font-size: 14px; text-transform: uppercase; margin-bottom: 15px; }
    .stat { font-size: 36px; font-weight: bold; color: white; }
    .node { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #222; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.online { background: #00ff88; }
    .dot.offline { background: #ff4444; }
    .role { color: #888; font-size: 12px; }
    .task { padding: 8px 0; border-bottom: 1px solid #222; }
    .task .title { color: #fff; }
    .task .status { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
    .status.pending { background: #444; color: #aaa; }
    .status.in_progress { background: #1a3a1a; color: #00ff88; }
    .status.completed { background: #1a1a3a; color: #4488ff; }
    #log { background: #111; border: 1px solid #333; border-radius: 8px; padding: 15px; font-family: monospace; font-size: 12px; max-height: 300px; overflow-y: auto; }
    .log-entry { padding: 2px 0; color: #888; }
    .log-entry .time { color: #555; }
    .log-entry .event { color: #00ff88; }
  </style>
</head>
<body>
  <h1>⚡ CC Swarm Hub</h1>
  <div class="grid">
    <div class="card"><h2>Nodes</h2><div id="nodes">Loading...</div></div>
    <div class="card"><h2>Tasks</h2><div id="tasks">Loading...</div></div>
    <div class="card"><h2>Stats</h2><div id="stats">Loading...</div></div>
  </div>
  <div class="card"><h2>Live Feed</h2><div id="log"></div></div>
  <script>
    async function refresh() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('nodes').innerHTML = data.nodes.map(n =>
        '<div class="node"><span class="dot ' + n.status + '"></span><strong>' + n.name + '</strong><span class="role">' + n.role + '</span></div>'
      ).join('') || '<div style="color:#666">No nodes registered</div>';
      document.getElementById('stats').innerHTML =
        '<div>Pending: <span class="stat">' + data.tasks.pending + '</span></div>' +
        '<div>Active: <span class="stat">' + data.tasks.active + '</span></div>' +
        '<div>Complete: <span class="stat">' + data.tasks.completed + '</span></div>' +
        '<div style="margin-top:10px">Messages: ' + data.messages + ' | Files: ' + data.files + '</div>';
      const tasksRes = await fetch('/api/tasks?status=pending&status=in_progress');
      const tasksData = await tasksRes.json();
      document.getElementById('tasks').innerHTML = tasksData.slice(0, 10).map(t =>
        '<div class="task"><span class="title">' + t.title + '</span> <span class="status ' + t.status + '">' + t.status + '</span></div>'
      ).join('') || '<div style="color:#666">No active tasks</div>';
    }
    refresh(); setInterval(refresh, 5000);
    const ws = new WebSocket('ws://' + location.host + '?node_id=dashboard');
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const log = document.getElementById('log');
      const time = new Date().toLocaleTimeString();
      log.innerHTML = '<div class="log-entry"><span class="time">' + time + '</span> <span class="event">' + data.event + '</span> ' + JSON.stringify(data.data).substring(0, 100) + '</div>' + log.innerHTML;
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
