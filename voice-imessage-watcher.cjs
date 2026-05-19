#!/usr/bin/env node
/**
 * voice-imessage-watcher.cjs — SCAFFOLD ONLY (do not run without review)
 * ----------------------------------------------------------------------------
 * Watches BlueBubbles for new iMessage audio attachments (.caf / .m4a) from
 * Kevin and pipes each through `voice-to-alfred.cjs`.
 *
 * Two integration paths:
 *
 *   1. BlueBubbles WebSocket (PREFERRED) — subscribe to `new-message` events
 *      from BlueBubbles server (default :1234), filter for sender=Kevin and
 *      attachments where mime starts with `audio/`. Download via REST.
 *      Endpoint: ws://localhost:1234/?guid=<password>&serverUrl=...
 *
 *   2. Filesystem watch — chokidar on
 *      `~/Library/Messages/Attachments/**\/*.caf` (and *.m4a).
 *      Pros: zero BlueBubbles dependency.
 *      Cons: no sender filter (need to query messages.db sqlite).
 *
 * Required env (path 1):
 *   BLUEBUBBLES_URL           e.g. http://localhost:1234
 *   BLUEBUBBLES_PASSWORD      server password / guid
 *   BLUEBUBBLES_KEVIN_HANDLE  Kevin's iMessage handle (phone or email)
 *
 * Run via PM2 once tested:
 *   pm2 start scripts/voice-imessage-watcher.cjs --name voice-imessage
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, 'voice-to-alfred.cjs');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const BB_URL    = need('BLUEBUBBLES_URL');
const BB_PASS   = need('BLUEBUBBLES_PASSWORD');
const KEVIN_HND = need('BLUEBUBBLES_KEVIN_HANDLE');

function downloadAttachment(attachmentGuid, dest) {
  // BlueBubbles REST: GET /api/v1/attachment/:guid/download?password=...
  const url = `${BB_URL}/api/v1/attachment/${attachmentGuid}/download?password=${encodeURIComponent(BB_PASS)}`;
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    lib.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

async function handleMessage(msg) {
  // msg shape (BlueBubbles): { guid, handle: { address }, attachments: [{ guid, mimeType, transferName }] }
  if (!msg.handle || msg.handle.address !== KEVIN_HND) return;
  if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return;
  for (const att of msg.attachments) {
    if (!att.mimeType || !att.mimeType.startsWith('audio/')) continue;
    const tmp = path.join(os.tmpdir(), `imessage-voice-${Date.now()}-${att.transferName || 'voice'}`);
    console.log(`[voice-imessage] downloading ${att.guid} → ${tmp}`);
    await downloadAttachment(att.guid, tmp);
    console.log(`[voice-imessage] piping to Alfred...`);
    const r = spawnSync('node', [WRAPPER, tmp, '--source=imessage'], { stdio: 'inherit' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) console.error(`[voice-imessage] forwarder exit=${r.status}`);
  }
}

// TODO: Implement WebSocket subscription to BlueBubbles `new-message` topic.
//       Recommend `socket.io-client` (BlueBubbles uses Socket.IO).
//         npm i socket.io-client
//         const io = require('socket.io-client');
//         const sock = io(BB_URL, { query: { guid: BB_PASS } });
//         sock.on('new-message', handleMessage);
//
//       Or polling fallback: hit GET /api/v1/message?after=<lastTs> every 5s.
console.error('[voice-imessage] SCAFFOLD: implement BlueBubbles subscription before running.');
console.error('[voice-imessage] handleMessage() is wired and ready; only the transport is missing.');
process.exit(0);
