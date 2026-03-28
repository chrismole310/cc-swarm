/**
 * CC Swarm Smart Router
 * ====================
 * Automatically routes tasks to the best CC based on capabilities.
 * When any CC gets a task, the router decides which machine should handle it.
 *
 * Capability Map:
 *   CC2 (Mac Studio 32GB): LLM, TTS, render, video, audio, image gen, translation
 *   CC1 (Mac Mini 1): PM2, backend, services, social posting, playwright
 *   CC3 (Mac Mini 2): Social posting, content distribution, playwright
 */

// Task keywords → required capabilities mapping
const TASK_ROUTING_RULES = [
  // Render / GPU tasks → Mac Studio (CC2)
  {
    keywords: ['render', 'video', 'ltx', 'flux', 'image', 'generate image', 'thumbnail'],
    capability: 'video-render',
    prefer_role: 'render-farm',
  },
  {
    keywords: ['audiobook', 'tts', 'kokoro', 'voice', 'narrate', 'speech', 'audio generate'],
    capability: 'audio-tts',
    prefer_role: 'render-farm',
  },
  {
    keywords: ['translate', 'translation', 'language', 'spanish', 'french', 'german', 'japanese'],
    capability: 'audio-tts',  // Translation models run on GPU too
    prefer_role: 'render-farm',
  },
  {
    keywords: ['llm', 'ollama', 'inference', 'ai model', 'mirofish', 'simulation', 'swarm ai'],
    capability: 'mirofish',
    prefer_role: 'render-farm',
  },
  {
    keywords: ['music', 'musicgen', 'suno', 'song'],
    capability: 'audio-tts',
    prefer_role: 'render-farm',
  },
  {
    keywords: ['whisper', 'transcribe', 'transcription'],
    capability: 'audio-tts',
    prefer_role: 'render-farm',
  },
  {
    keywords: ['elevenlabs', 'voice clone', 'clone voice'],
    capability: 'audio-tts',
    prefer_role: 'render-farm',
  },

  // Social posting → CC1 or CC3
  {
    keywords: ['post', 'tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'x.com', 'social media', 'upload'],
    capability: 'social-posting',
    prefer_role: 'posting',
  },
  {
    keywords: ['playwright', 'browser', 'chrome', 'automate web'],
    capability: 'playwright',
    prefer_role: 'posting',
  },

  // Backend / services → CC1
  {
    keywords: ['pm2', 'backend', 'server', 'deploy', 'api', 'database', 'service'],
    capability: 'backend',
    prefer_role: 'engine',
  },
  {
    keywords: ['netlify', 'cloudflare', 'dns', 'domain', 'website'],
    capability: 'backend',
    prefer_role: 'engine',
  },

  // Distribution → CC3 or CC1
  {
    keywords: ['distribute', 'kdp', 'amazon', 'audible', 'acx', 'gumroad', 'upload audiobook'],
    capability: 'content-distribution',
    prefer_role: 'posting',
  },
  {
    keywords: ['email', 'outreach', 'campaign', 'newsletter'],
    capability: 'backend',
    prefer_role: 'engine',
  },
];

/**
 * Route a task to the best CC node.
 * @param {string} taskTitle - Task title
 * @param {string} taskDescription - Task description
 * @param {Array} nodes - Available nodes from DB
 * @returns {string|null} Best node ID, or null if no match
 */
export function routeTask(taskTitle, taskDescription, nodes) {
  const text = `${taskTitle} ${taskDescription}`.toLowerCase();
  const onlineNodes = nodes.filter(n => {
    const lastSeen = n.last_heartbeat || 0;
    return (Date.now() / 1000 - lastSeen) < 300; // Online in last 5 min
  });

  if (onlineNodes.length === 0) return null;

  // Score each node based on matching rules
  const scores = {};
  onlineNodes.forEach(n => { scores[n.id] = 0; });

  for (const rule of TASK_ROUTING_RULES) {
    const matches = rule.keywords.some(kw => text.includes(kw));
    if (!matches) continue;

    for (const node of onlineNodes) {
      const caps = JSON.parse(node.capabilities || '[]');
      const hasCapability = caps.includes(rule.capability);
      const hasRole = node.role === rule.prefer_role;

      if (hasCapability) scores[node.id] += 10;
      if (hasRole) scores[node.id] += 5;
    }
  }

  // Find highest scoring node
  let bestNode = null;
  let bestScore = 0;
  for (const [nodeId, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestNode = nodeId;
    }
  }

  // If no rules matched, return null (caller decides)
  return bestScore > 0 ? bestNode : null;
}

/**
 * Get a human-readable explanation of why a task was routed.
 */
export function explainRouting(taskTitle, taskDescription, nodes) {
  const text = `${taskTitle} ${taskDescription}`.toLowerCase();
  const matchedRules = TASK_ROUTING_RULES.filter(rule =>
    rule.keywords.some(kw => text.includes(kw))
  );

  if (matchedRules.length === 0) {
    return 'No specific routing rules matched. Task will go to the general queue.';
  }

  const reasons = matchedRules.map(rule => {
    const matchedKeyword = rule.keywords.find(kw => text.includes(kw));
    return `"${matchedKeyword}" → prefers ${rule.prefer_role} (needs: ${rule.capability})`;
  });

  const bestNode = routeTask(taskTitle, taskDescription, nodes);
  const nodeName = nodes.find(n => n.id === bestNode)?.name || bestNode;

  return `Routed to ${nodeName} because: ${reasons.join(', ')}`;
}
