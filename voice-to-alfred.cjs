#!/usr/bin/env node
/**
 * voice-to-alfred.cjs
 * ----------------------------------------------------------------------------
 * Local Whisper voice → Alfred pipeline.
 *
 * Input:   audio file (m4a, mp3, wav, ogg, webm, aiff, caf, flac, opus, ...)
 * Process: 1. Convert to wav 16kHz mono via ffmpeg (if needed)
 *          2. Transcribe via local OpenAI Whisper large-v3-turbo (no cloud)
 *          3. Light filler-word strip ("um", "uh") on high-confidence segments
 *          4. Forward transcript to Alfred via `openclaw agent`
 *
 * Usage:   node voice-to-alfred.cjs <audio-file> [--no-send] [--source=cli]
 *          --no-send  : print transcript only, do not call Alfred
 *          --source=X : tag the metadata source (default: "cli")
 *
 * Exit:    0 on success, 1 on transcription failure, 2 on send failure.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------- config
const WHISPER_BIN  = '/opt/homebrew/bin/whisper';
const WHISPER_MODEL = 'large-v3-turbo';
const WHISPER_DIR  = path.join(os.homedir(), '.cache', 'whisper');
const FFMPEG_BIN   = '/opt/homebrew/bin/ffmpeg';
const OC_BIN       = process.env.OC_BIN || 'openclaw';
const ALFRED_AGENT = process.env.ALFRED_AGENT_ID || 'main'; // Alfred's OC agent id is "main"

const FILLERS = /\b(um|uh|er|erm|mhm|hmm)\b[,.\s]*/gi;

// ---------------------------------------------------------------- utils
function die(code, msg) {
  console.error(`[voice-to-alfred] ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { file: null, send: true, source: 'cli' };
  for (const a of argv.slice(2)) {
    if (a === '--no-send') out.send = false;
    else if (a.startsWith('--source=')) out.source = a.slice(9);
    else if (!a.startsWith('--')) out.file = a;
  }
  return out;
}

function ensureWav(input) {
  const ext = path.extname(input).toLowerCase();
  if (ext === '.wav') {
    // Verify it's already 16kHz mono — if not, normalize anyway for whisper speed
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', input],
      { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '16000,1') return input;
  }
  const wav = path.join(os.tmpdir(), `voice-${Date.now()}.wav`);
  const r = spawnSync(FFMPEG_BIN, ['-y', '-i', input, '-ar', '16000', '-ac', '1', wav],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) die(1, `ffmpeg failed: ${r.stderr?.toString() || 'unknown'}`);
  return wav;
}

function transcribe(wav) {
  const outDir = path.join(os.tmpdir(), `whisper-out-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(WHISPER_BIN, [
    wav,
    '--model', WHISPER_MODEL,
    '--model_dir', WHISPER_DIR,
    '--output_dir', outDir,
    '--output_format', 'txt',
    '--language', 'en',
    '--fp16', 'False',
    '--verbose', 'False',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    die(1, `whisper failed: ${r.stderr?.slice(0, 400) || 'unknown'}`);
  }
  const base = path.basename(wav, path.extname(wav));
  const txtPath = path.join(outDir, `${base}.txt`);
  if (!fs.existsSync(txtPath)) die(1, `no transcript file at ${txtPath}`);
  const transcript = fs.readFileSync(txtPath, 'utf8').trim();
  // cleanup
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  return transcript;
}

function stripFillers(text) {
  return text.replace(FILLERS, '').replace(/\s{2,}/g, ' ').trim();
}

function durationSec(wav) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', wav], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return Math.round(parseFloat(r.stdout.trim()) * 10) / 10;
}

function sendToAlfred(transcript, meta) {
  // openclaw agent --agent alfred --message "<text>" --json
  // Note: --metadata is not a CLI flag; we prefix the message instead.
  const tag = `[voice · ${meta.source} · ${meta.duration_s}s]`;
  const body = `${tag}\n\n${transcript}`;
  const r = spawnSync(OC_BIN, [
    'agent',
    '--agent', ALFRED_AGENT,
    '--message', body,
    '--json',
    '--thinking', 'medium',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    die(2, `openclaw agent failed: ${r.stderr?.slice(0, 400) || r.stdout?.slice(0, 400) || 'unknown'}`);
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv);
  if (!args.file) die(1, 'usage: voice-to-alfred.cjs <audio-file> [--no-send] [--source=cli]');
  if (!fs.existsSync(args.file)) die(1, `file not found: ${args.file}`);

  const t0 = Date.now();
  const wav = ensureWav(args.file);
  const dur = durationSec(wav);
  process.stderr.write(`[voice-to-alfred] transcribing ${path.basename(args.file)} (${dur}s) ...\n`);

  const raw = transcribe(wav);
  const cleaned = stripFillers(raw);
  const t1 = Date.now();
  process.stderr.write(`[voice-to-alfred] transcribed in ${((t1 - t0) / 1000).toFixed(1)}s\n`);
  process.stderr.write(`[voice-to-alfred] transcript: ${cleaned}\n`);

  if (!args.send) {
    process.stdout.write(cleaned + '\n');
    return;
  }
  const reply = sendToAlfred(cleaned, { source: args.source, duration_s: dur });
  process.stdout.write(reply + '\n');
}

if (require.main === module) main();

module.exports = { ensureWav, transcribe, stripFillers, sendToAlfred };
