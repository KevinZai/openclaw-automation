#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# talk-to-alfred — record N seconds of audio from default mic, transcribe via
# local Whisper, forward the transcript to Alfred via OpenClaw, print reply.
#
# Usage:  talk-to-alfred [seconds]    # default: 10s
#         talk-to-alfred --file <path>  # transcribe an existing audio file
#
# Requires: ffmpeg (avfoundation), node, openclaw, openai-whisper.
# Mic permission: System Settings → Privacy → Microphone → Terminal/iTerm
# ----------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/Users/ai/clawd}"
WRAPPER="$REPO_ROOT/scripts/voice-to-alfred.cjs"
DEFAULT_SECONDS=10

if [[ "${1:-}" == "--file" && -n "${2:-}" ]]; then
  audio="$2"
  exec node "$WRAPPER" "$audio" --source=cli-file
fi

seconds="${1:-$DEFAULT_SECONDS}"
audio="/tmp/talk-to-alfred-$(date +%s).wav"

# AVFoundation mic input on macOS.
# Device :0 is the default audio input. Use `ffmpeg -f avfoundation -list_devices true -i ""` to inspect.
echo "🎙️  Recording ${seconds}s from default mic. Speak now..."
ffmpeg -y -hide_banner -loglevel error \
  -f avfoundation -i ":0" \
  -ar 16000 -ac 1 -t "$seconds" \
  "$audio"

echo "📝 Transcribing + sending to Alfred..."
node "$WRAPPER" "$audio" --source=cli-mic

# Cleanup
rm -f "$audio"
