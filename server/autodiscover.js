/**
 * CC Swarm Auto-Discovery
 * =======================
 * Automatically finds all machines on the local network,
 * detects which ones can run Claude Code, connects them,
 * installs the swarm components, and reports status.
 *
 * Uses mDNS/Bonjour (built into macOS) + SSH for setup.
 *
 * Usage:
 *   node autodiscover.js              — Scan and report
 *   node autodiscover.js --install    — Scan, install, and connect
 */

import { execSync, exec } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname, networkInterfaces } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_MODE = process.argv.includes('--install');
const HUB_PORT = process.env.SWARM_PORT || 7777;

// Get this machine's IP
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
const HUB_URL = `http://${LOCAL_IP}:${HUB_PORT}`;

console.log(`\n⚡ CC Swarm Auto-Discovery`);
console.log(`  Hub: ${HUB_URL}`);
console.log(`  Mode: ${INSTALL_MODE ? 'INSTALL' : 'SCAN ONLY'}\n`);

// Step 1: Scan the network for machines
console.log(`[1/4] Scanning network for machines...`);

function scanNetwork() {
  const machines = [];

  try {
    // Use arp to find all devices on LAN
    const arpOutput = execSync('arp -a', { encoding: 'utf8', timeout: 10000 });
    const lines = arpOutput.split('\n');

    for (const line of lines) {
      // Parse: hostname (IP) at MAC on interface
      const match = line.match(/^([^\s]+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
      if (match) {
        const [, name, ip, mac] = match;
        if (ip !== '255.255.255.255' && !ip.endsWith('.255')) {
          machines.push({ name: name.replace('.lan', ''), ip, mac });
        }
      }
    }
  } catch (e) {
    console.log(`  Warning: arp scan failed: ${e.message}`);
  }

  // Also try dns-sd for Bonjour/mDNS discovery (macOS)
  try {
    const mdnsOutput = execSync('dns-sd -B _ssh._tcp local 2>/dev/null & sleep 3 && kill $! 2>/dev/null',
      { encoding: 'utf8', timeout: 5000, shell: true });
  } catch (e) {
    // dns-sd times out, that's fine
  }

  return machines;
}

const machines = scanNetwork();
console.log(`  Found ${machines.length} devices on network\n`);

// Step 2: Check which machines have SSH access and could run CC
console.log(`[2/4] Checking SSH access and capabilities...\n`);

async function checkMachine(machine) {
  const { ip, name } = machine;

  // Skip broadcast/gateway
  if (ip === LOCAL_IP) {
    machine.isLocal = true;
    machine.sshAccess = true;
    machine.hasNode = !!execSync('which node 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
    machine.hasPython = true;
    machine.hasClaude = !!execSync('which claude 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
    machine.os = 'macOS';
    machine.hostname = hostname();
    machine.ram = execSync("sysctl -n hw.memsize", { encoding: 'utf8' }).trim();
    machine.ramGB = Math.round(parseInt(machine.ram) / (1024 * 1024 * 1024));
    return machine;
  }

  // Try SSH with common usernames
  const users = ['atlas', 'chrismole', process.env.USER];

  for (const user of users) {
    try {
      const result = execSync(
        `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${user}@${ip} "echo OK" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      if (result.trim() === 'OK') {
        machine.sshAccess = true;
        machine.sshUser = user;

        // Get machine info
        try {
          machine.hostname = execSync(`ssh ${user}@${ip} "hostname" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          machine.os = execSync(`ssh ${user}@${ip} "uname" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          machine.hasNode = !!execSync(`ssh ${user}@${ip} "which node 2>/dev/null || ls /opt/homebrew/bin/node 2>/dev/null" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          machine.hasPython = !!execSync(`ssh ${user}@${ip} "which python3 2>/dev/null || which python3.11 2>/dev/null" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          machine.hasClaude = !!execSync(`ssh ${user}@${ip} "which claude 2>/dev/null" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          const ram = execSync(`ssh ${user}@${ip} "sysctl -n hw.memsize 2>/dev/null" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
          machine.ramGB = Math.round(parseInt(ram) / (1024 * 1024 * 1024));
        } catch (e) { /* ignore info gathering errors */ }

        console.log(`  🟢 ${ip} (${machine.hostname || name}) — SSH: ${user}@, Node: ${machine.hasNode ? '✓' : '✗'}, Claude: ${machine.hasClaude ? '✓' : '✗'}, RAM: ${machine.ramGB || '?'}GB`);
        return machine;
      }
    } catch (e) {
      // SSH failed for this user, try next
    }
  }

  machine.sshAccess = false;
  return machine;
}

// Check machines sequentially (SSH is sequential anyway)
const checkedMachines = [];
for (const m of machines) {
  const checked = await checkMachine(m);
  checkedMachines.push(checked);
}

const sshMachines = checkedMachines.filter(m => m.sshAccess);
console.log(`\n  ${sshMachines.length} machines accessible via SSH\n`);

// Step 3: Install CC Swarm on accessible machines
if (INSTALL_MODE) {
  console.log(`[3/4] Installing CC Swarm on ${sshMachines.length} machines...\n`);

  for (const machine of sshMachines) {
    if (machine.isLocal) {
      console.log(`  ⚡ ${machine.hostname} (local) — Already running hub`);
      continue;
    }

    if (!machine.hasNode) {
      console.log(`  ⚠️  ${machine.hostname} — No Node.js, skipping`);
      continue;
    }

    const user = machine.sshUser;
    const ip = machine.ip;
    const nodeId = `cc-${machine.hostname}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);

    console.log(`  Installing on ${machine.hostname} (${ip})...`);

    try {
      // Create directory
      execSync(`ssh ${user}@${ip} "mkdir -p ~/cc-swarm/mcp-server ~/cc-swarm/menubar"`, { timeout: 5000 });

      // Copy files
      execSync(`scp ${join(__dirname, '../mcp-server/package.json')} ${join(__dirname, '../mcp-server/index.js')} ${user}@${ip}:~/cc-swarm/mcp-server/`, { timeout: 10000 });
      execSync(`scp ${join(__dirname, '../menubar/swarm_status.py')} ${user}@${ip}:~/cc-swarm/menubar/`, { timeout: 10000 });

      // Install npm deps
      execSync(`ssh ${user}@${ip} "export PATH=/opt/homebrew/bin:/usr/local/bin:\\$PATH && cd ~/cc-swarm/mcp-server && npm install" 2>/dev/null`, { timeout: 30000 });

      // Update hub URL in menu bar
      execSync(`ssh ${user}@${ip} "sed -i '' 's|http://localhost:7777|${HUB_URL}|g' ~/cc-swarm/menubar/swarm_status.py 2>/dev/null || true"`, { timeout: 5000 });

      // Create Claude Code settings
      const settings = JSON.stringify({
        mcpServers: {
          "cc-swarm": {
            command: "node",
            args: [`/Users/${user}/cc-swarm/mcp-server/index.js`],
            env: {
              SWARM_HUB: HUB_URL,
              SWARM_NODE_ID: nodeId,
              SWARM_NAME: machine.hostname,
              SWARM_ROLE: "general"
            }
          }
        }
      }, null, 2);

      execSync(`ssh ${user}@${ip} 'mkdir -p ~/.claude && echo ${JSON.stringify(settings)} > ~/.claude/settings.local.json'`, { timeout: 5000 });

      // Register with hub
      const regData = JSON.stringify({
        id: nodeId,
        name: machine.hostname,
        role: 'general',
        hostname: machine.hostname,
        ip: ip,
        capabilities: [],
        metadata: { ram: `${machine.ramGB}GB`, os: machine.os }
      });

      execSync(`curl -s -X POST ${HUB_URL}/api/nodes/register -H "Content-Type: application/json" -d '${regData}'`, { timeout: 5000 });

      // Start heartbeat
      execSync(`ssh ${user}@${ip} "nohup bash -c 'while true; do curl -s -X POST ${HUB_URL}/api/nodes/${nodeId}/heartbeat -H \\\"Content-Type: application/json\\\" -d \\\"{\\\\\\\"status\\\\\\\":\\\\\\\"online\\\\\\\"}\\\" > /dev/null 2>&1; sleep 60; done' > /dev/null 2>&1 &"`, { timeout: 5000 });

      // Start menu bar
      if (machine.hasPython) {
        execSync(`ssh ${user}@${ip} "export PATH=/opt/homebrew/bin:/usr/local/bin:\\$PATH && pip3 install rumps 2>/dev/null && nohup python3 ~/cc-swarm/menubar/swarm_status.py > /tmp/swarm-menubar.log 2>&1 &" 2>/dev/null`, { timeout: 30000 });
      }

      console.log(`  ✓ ${machine.hostname} — Installed and connected as ${nodeId}`);
    } catch (e) {
      console.log(`  ✗ ${machine.hostname} — Install failed: ${e.message}`);
    }
  }
} else {
  console.log(`[3/4] Skipping install (run with --install to set up all machines)\n`);
}

// Step 4: Status report
console.log(`\n[4/4] Swarm Status Report\n`);

try {
  const statusResp = execSync(`curl -s ${HUB_URL}/api/status`, { encoding: 'utf8', timeout: 5000 });
  const status = JSON.parse(statusResp);

  console.log(`  ⚡ ${status.swarm.name} v${status.swarm.version}`);
  console.log(`  Nodes: ${status.swarm.nodes_online}/${status.swarm.nodes_total} online\n`);

  for (const node of status.nodes) {
    const dot = node.status === 'online' ? '🟢' : '🔴';
    console.log(`  ${dot} ${node.name.padEnd(25)} [${node.role}]`);
  }

  if (status.swarm.nodes_online === status.swarm.nodes_total && status.swarm.nodes_total > 1) {
    console.log(`\n  ⚡⚡⚡ BEAST MODE — All ${status.swarm.nodes_total} nodes connected! ⚡⚡⚡\n`);
  } else if (status.swarm.nodes_online > 0) {
    console.log(`\n  ⚡ Swarm active — ${status.swarm.nodes_total - status.swarm.nodes_online} node(s) still offline\n`);
  }
} catch (e) {
  console.log(`  Hub not reachable at ${HUB_URL}`);
}
