#!/usr/bin/env node
/**
 * CC Swarm MCP Server
 * ==================
 * Gives Claude Code native tools for multi-machine orchestration.
 * Connects to the CC Swarm Hub (REST API) and exposes MCP tools.
 *
 * Usage in Claude Code settings.json:
 *   "mcpServers": {
 *     "cc-swarm": {
 *       "command": "node",
 *       "args": ["/path/to/cc-swarm/mcp-server/index.js"],
 *       "env": { "SWARM_HUB": "http://192.168.1.95:7777", "SWARM_NODE_ID": "cc2" }
 *     }
 *   }
 *
 * Environment:
 *   SWARM_HUB     — URL of the CC Swarm Hub (default: http://localhost:7777)
 *   SWARM_NODE_ID — This node's ID (default: auto-generated)
 *   SWARM_NAME    — This node's display name (default: hostname)
 *   SWARM_ROLE    — This node's role (default: "general")
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { hostname } from 'os';

const HUB_URL = process.env.SWARM_HUB || 'http://localhost:7777';
const NODE_ID = process.env.SWARM_NODE_ID || `node-${Math.random().toString(36).slice(2, 8)}`;
const NODE_NAME = process.env.SWARM_NAME || `CC @ ${hostname()}`;
const NODE_ROLE = process.env.SWARM_ROLE || 'general';

// ── HTTP Helper ─────────────────────────────────────────────
async function api(method, path, body = null) {
  const url = `${HUB_URL}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, options);
    return await resp.json();
  } catch (e) {
    return { error: `Hub unreachable: ${e.message}` };
  }
}

// ── Heartbeat ───────────────────────────────────────────────
async function registerAndHeartbeat() {
  await api('POST', '/api/nodes/register', {
    id: NODE_ID,
    name: NODE_NAME,
    role: NODE_ROLE,
    hostname: hostname(),
  });

  setInterval(async () => {
    await api('POST', `/api/nodes/${NODE_ID}/heartbeat`, { status: 'online' });
  }, 60000);
}

// ── MCP Server ──────────────────────────────────────────────
const server = new Server(
  { name: 'cc-swarm', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ── TOOLS ───────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'swarm_status',
      description: 'Get the status of all CC nodes in the swarm — who is online, what role they have, and overall task/message counts.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'swarm_nodes',
      description: 'List all registered CC nodes with their roles, capabilities, and online/offline status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'swarm_assign_task',
      description: 'Create and assign a task to a specific CC node. If assigned_to is omitted, the swarm will AUTO-ROUTE to the best machine based on capabilities (e.g., render tasks → Mac Studio GPU, social posting → posting machine, backend work → engine). The target node will be notified.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Detailed task description' },
          assigned_to: { type: 'string', description: 'Node ID to assign to (e.g., cc1, cc2, cc3). OMIT to auto-route based on task content.' },
          priority: { type: 'number', description: 'Priority 1-10 (10=highest)', default: 5 },
        },
        required: ['title'],
      },
    },
    {
      name: 'swarm_claim_task',
      description: 'Claim the next available unassigned task from the queue for this CC to work on.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'swarm_complete_task',
      description: 'Mark a task as completed with a result summary.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to complete' },
          result: { type: 'string', description: 'Result/summary of the completed task' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'swarm_get_tasks',
      description: 'Get tasks from the swarm queue, optionally filtered by status or assignee.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Filter by status' },
          assigned_to: { type: 'string', description: 'Filter by assigned node ID' },
        },
        required: [],
      },
    },
    {
      name: 'swarm_broadcast',
      description: 'Send a message to ALL CC nodes in the swarm.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
          channel: { type: 'string', description: 'Channel name (default: general)', default: 'general' },
        },
        required: ['content'],
      },
    },
    {
      name: 'swarm_message',
      description: 'Send a direct message to a specific CC node.',
      inputSchema: {
        type: 'object',
        properties: {
          to_node: { type: 'string', description: 'Target node ID' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['to_node', 'content'],
      },
    },
    {
      name: 'swarm_get_messages',
      description: 'Get messages sent to this CC node.',
      inputSchema: {
        type: 'object',
        properties: {
          unread_only: { type: 'boolean', description: 'Only show unread messages', default: true },
        },
        required: [],
      },
    },
    {
      name: 'swarm_set_state',
      description: 'Set a shared state key-value pair visible to all CC nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'State key' },
          value: { type: 'string', description: 'State value (string or JSON)' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'swarm_get_state',
      description: 'Get all shared state or a specific key.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Specific key to get (omit for all state)' },
        },
        required: [],
      },
    },
    {
      name: 'swarm_share_file',
      description: 'Notify the swarm that a file is ready for other CCs to access.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename' },
          path: { type: 'string', description: 'Full path to the file' },
          description: { type: 'string', description: 'What the file is / what to do with it' },
          size: { type: 'number', description: 'File size in bytes' },
          type: { type: 'string', description: 'MIME type' },
        },
        required: ['filename', 'path'],
      },
    },
    {
      name: 'swarm_get_files',
      description: 'List all files shared across the swarm.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}));

// ── TOOL EXECUTION ──────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'swarm_status':
        result = await api('GET', '/api/status');
        break;

      case 'swarm_nodes':
        result = await api('GET', '/api/nodes');
        break;

      case 'swarm_assign_task':
        result = await api('POST', '/api/tasks', {
          ...args,
          created_by: NODE_ID,
        });
        break;

      case 'swarm_claim_task':
        result = await api('POST', '/api/tasks/claim', { node_id: NODE_ID });
        break;

      case 'swarm_complete_task':
        result = await api('POST', `/api/tasks/${args.task_id}/complete`, {
          result: args.result,
          node_id: NODE_ID,
        });
        break;

      case 'swarm_get_tasks': {
        const params = new URLSearchParams();
        if (args.status) params.set('status', args.status);
        if (args.assigned_to) params.set('assigned_to', args.assigned_to);
        result = await api('GET', `/api/tasks?${params}`);
        break;
      }

      case 'swarm_broadcast':
        result = await api('POST', '/api/messages/broadcast', {
          from_node: NODE_ID,
          content: args.content,
          channel: args.channel || 'general',
        });
        break;

      case 'swarm_message':
        result = await api('POST', '/api/messages', {
          from_node: NODE_ID,
          to_node: args.to_node,
          content: args.content,
        });
        break;

      case 'swarm_get_messages':
        result = await api('GET', `/api/messages/${NODE_ID}?unread_only=${args.unread_only !== false}`);
        break;

      case 'swarm_set_state':
        result = await api('POST', '/api/state', {
          key: args.key,
          value: args.value,
          node_id: NODE_ID,
        });
        break;

      case 'swarm_get_state':
        result = args.key
          ? await api('GET', `/api/state/${args.key}`)
          : await api('GET', '/api/state');
        break;

      case 'swarm_share_file':
        result = await api('POST', '/api/files/share', {
          ...args,
          shared_by: NODE_ID,
        });
        break;

      case 'swarm_get_files':
        result = await api('GET', '/api/files');
        break;

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

// ── RESOURCES (read-only views) ─────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'swarm://status',
      name: 'Swarm Status',
      description: 'Current status of all CC nodes, tasks, and messages',
      mimeType: 'application/json',
    },
    {
      uri: 'swarm://tasks',
      name: 'Task Queue',
      description: 'All tasks in the swarm queue',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'swarm://status') {
    const status = await api('GET', '/api/status');
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(status, null, 2) }] };
  }

  if (uri === 'swarm://tasks') {
    const tasks = await api('GET', '/api/tasks');
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tasks, null, 2) }] };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ── Start ───────────────────────────────────────────────────
async function main() {
  await registerAndHeartbeat();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`CC Swarm MCP Server started (node: ${NODE_ID}, hub: ${HUB_URL})`);
}

main().catch(console.error);
