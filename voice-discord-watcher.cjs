#!/usr/bin/env node
/**
 * voice-discord-watcher.cjs — SCAFFOLD ONLY (do not run without review)
 * ----------------------------------------------------------------------------
 * Watches Kevin's Discord DM channel for incoming audio attachments and pipes
 * each new audio file through `voice-to-alfred.cjs` so Alfred receives the
 * transcript like any other text message.
 *
 * Why a separate watcher?
 *   OpenClaw 2026.5.7 forwards Discord text content but does NOT transcribe
 *   inbound audio attachments (verified — only outbound `audioAsVoice` exists
 *   in dist/). Until OC ships a native voice-attachment hook, this script
 *   runs alongside the gateway and intercepts the audio MIME types.
 *
 * Required env:
 *   DISCORD_BOT_TOKEN      — bot token with `MessageContent` + `Attachments`
 *                            intents enabled. Use a dedicated bot, NOT the
 *                            shared OC Discord bot (avoid token-clash).
 *   DISCORD_KEVIN_USER_ID  — Kevin's Discord user id (only DMs from this id
 *                            are processed).
 *
 * Optional env:
 *   DISCORD_VOICE_CHANNEL_ID — restrict to a specific channel id (instead of DM).
 *
 * Run via PM2 once tested:
 *   pm2 start scripts/voice-discord-watcher.cjs --name voice-discord
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, 'voice-to-alfred.cjs');
const AUDIO_MIMES = new Set([
  'audio/ogg', 'audio/oga', 'audio/mpeg', 'audio/mp3', 'audio/wav',
  'audio/x-wav', 'audio/webm', 'audio/m4a', 'audio/x-m4a', 'audio/mp4',
  'audio/aac', 'audio/flac', 'audio/opus',
]);

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const TOKEN = need('DISCORD_BOT_TOKEN');
const KEVIN = need('DISCORD_KEVIN_USER_ID');
const ONLY_CHANNEL = process.env.DISCORD_VOICE_CHANNEL_ID || null;

// ----------------------------------------------------------------------------
// Minimal Discord gateway client (no SDK dependency to keep this scaffold
// stand-alone). For production, replace with discord.js.
// ----------------------------------------------------------------------------
function downloadAttachment(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

async function handleMessage(msg) {
  if (!msg.author || msg.author.id !== KEVIN) return;
  if (ONLY_CHANNEL && msg.channel_id !== ONLY_CHANNEL) return;
  if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return;
  for (const att of msg.attachments) {
    if (!AUDIO_MIMES.has(att.content_type)) continue;
    const tmp = path.join(os.tmpdir(), `discord-voice-${Date.now()}-${att.filename}`);
    console.log(`[voice-discord] downloading ${att.filename} → ${tmp}`);
    await downloadAttachment(att.url, tmp);
    console.log(`[voice-discord] piping to Alfred...`);
    const r = spawnSync('node', [WRAPPER, tmp, '--source=discord'], { stdio: 'inherit' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) console.error(`[voice-discord] forwarder exit=${r.status}`);
  }
}

// TODO: Implement Discord gateway WebSocket connection here.
//       For initial scaffold, recommend using discord.js:
//         npm i discord.js
//         const { Client, GatewayIntentBits } = require('discord.js');
//         const client = new Client({ intents: [DirectMessages, MessageContent, GuildMessages] });
//         client.on('messageCreate', handleMessage);
//         client.login(TOKEN);
//
//       Or use long-poll on the REST API for a quick MVP (no realtime).
console.error('[voice-discord] SCAFFOLD: implement gateway connection before running.');
console.error('[voice-discord] handleMessage() is wired and ready; only the transport is missing.');
process.exit(0);
