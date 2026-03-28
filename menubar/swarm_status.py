#!/usr/bin/env python3.11
"""
CC Swarm Menu Bar App
====================
Tiny menu bar icon that shows swarm status.
- ⚡ Green pulse = all nodes online, swarm active
- ⚠️ Yellow = some nodes offline
- 🔴 Red = hub unreachable
- Click to see full status, tasks, messages
- Almost zero memory (~15MB)
"""

import rumps
import json
import urllib.request
import ssl
import threading
import time

HUB_URL = "http://localhost:7777"
POLL_INTERVAL = 10  # seconds

# Emoji states for the menu bar
ICON_BEAST = "⚡"    # All nodes online — BEAST MODE
ICON_WARN = "⚠️"     # Some nodes offline
ICON_DOWN = "🔴"     # Hub unreachable
ICON_PULSE = ["⚡", "✦", "⚡", "✧"]  # Animation frames


class SwarmStatusApp(rumps.App):
    def __init__(self):
        super().__init__(
            "CC Swarm",
            title=f"{ICON_DOWN} Swarm",
            quit_button="Quit Swarm Monitor"
        )
        self.status = None
        self.pulse_frame = 0
        self.last_activity = 0
        self.communicating = False

        # Menu items
        self.menu_nodes = rumps.MenuItem("Nodes: checking...")
        self.menu_tasks = rumps.MenuItem("Tasks: checking...")
        self.menu_messages = rumps.MenuItem("Messages: checking...")
        self.menu_separator = rumps.separator
        self.menu_dashboard = rumps.MenuItem("Open Dashboard", callback=self.open_dashboard)
        self.menu_refresh = rumps.MenuItem("Refresh Now", callback=self.force_refresh)

        self.menu = [
            self.menu_nodes,
            self.menu_tasks,
            self.menu_messages,
            self.menu_separator,
            self.menu_dashboard,
            self.menu_refresh,
        ]

        # Start background polling
        self.poll_thread = threading.Thread(target=self.poll_loop, daemon=True)
        self.poll_thread.start()

        # Start animation timer
        self.animation_timer = rumps.Timer(self.animate, 0.5)
        self.animation_timer.start()

    def poll_loop(self):
        """Background thread that polls the hub."""
        while True:
            try:
                ctx = ssl.create_default_context()
                req = urllib.request.Request(f"{HUB_URL}/api/status")
                resp = urllib.request.urlopen(req, context=ctx, timeout=5)
                data = json.loads(resp.read().decode())
                self.status = data
                self.update_menu(data)
            except Exception:
                self.status = None
                self.update_offline()
            time.sleep(POLL_INTERVAL)

    def update_menu(self, data):
        """Update menu items with fresh data."""
        swarm = data.get("swarm", {})
        tasks = data.get("tasks", {})
        nodes = data.get("nodes", [])

        online = swarm.get("nodes_online", 0)
        total = swarm.get("nodes_total", 0)

        # Build node list
        node_lines = []
        for n in nodes:
            dot = "🟢" if n["status"] == "online" else "🔴"
            node_lines.append(f"  {dot} {n['name']} [{n['role']}]")

        self.menu_nodes.title = f"Nodes: {online}/{total} online"
        self.menu_tasks.title = f"Tasks: {tasks.get('pending', 0)} pending, {tasks.get('active', 0)} active"
        self.menu_messages.title = f"Messages: {data.get('messages', 0)} | Files: {data.get('files', 0)}"

        # Check if there was recent activity (for animation)
        task_count = tasks.get("pending", 0) + tasks.get("active", 0)
        if task_count > 0:
            self.communicating = True
        else:
            self.communicating = False

        # Set title based on status
        if online == total and total > 0:
            self.title = f"{ICON_BEAST} Swarm [{online}]"
        elif online > 0:
            self.title = f"{ICON_WARN} Swarm [{online}/{total}]"
        else:
            self.title = f"{ICON_DOWN} Swarm [0]"

    def update_offline(self):
        """Hub is unreachable."""
        self.title = f"{ICON_DOWN} Swarm"
        self.menu_nodes.title = "Hub unreachable"
        self.menu_tasks.title = "—"
        self.menu_messages.title = "—"

    def animate(self, sender):
        """Pulse animation when swarm is communicating."""
        if not self.status:
            return

        if self.communicating:
            # Animate the icon
            frame = ICON_PULSE[self.pulse_frame % len(ICON_PULSE)]
            swarm = self.status.get("swarm", {})
            online = swarm.get("nodes_online", 0)
            self.title = f"{frame} Swarm [{online}]"
            self.pulse_frame += 1
        else:
            self.pulse_frame = 0

    def open_dashboard(self, _):
        """Open the web dashboard."""
        import subprocess
        subprocess.Popen(["open", f"{HUB_URL}"])

    def force_refresh(self, _):
        """Force an immediate refresh."""
        threading.Thread(target=self.poll_loop_once, daemon=True).start()

    def poll_loop_once(self):
        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(f"{HUB_URL}/api/status")
            resp = urllib.request.urlopen(req, context=ctx, timeout=5)
            data = json.loads(resp.read().decode())
            self.status = data
            self.update_menu(data)
            rumps.notification(
                "CC Swarm",
                "Status refreshed",
                f"{data['swarm']['nodes_online']} nodes online, {data['tasks']['pending']} tasks pending"
            )
        except Exception as e:
            rumps.notification("CC Swarm", "Hub unreachable", str(e))


if __name__ == "__main__":
    SwarmStatusApp().run()
