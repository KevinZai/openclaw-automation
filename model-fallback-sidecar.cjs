#!/usr/bin/env node
/**
 * model-fallback-sidecar.cjs — CC-719 schema workaround
 *
 * Reads {agentId, model, error} from stdin, writes {fallbackModel, reason, chain, step}
 * to stdout. Exits 0 on success (fallback found), 1 if no fallback, 2 on bad input.
 *
 * Config: ~/.openclaw/fallback-chains.json
 *
 * Usage:
 *   echo '{"agentId":"bard","model":"cerebras/qwen-3-235b-a22b-instruct-2507","error":"429"}' \
 *     | node scripts/model-fallback-sidecar.cjs
 *
 * Why this exists: OC v2026.5.7 schema rejects `fallbackChains` at agent level.
 * This sidecar is the building block — wire into Paperclip wake adapter or
 * gateway pre-flight as a follow-up.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CONFIG_PATH =
  process.env.FALLBACK_CHAINS_PATH ||
  path.join(os.homedir(), ".openclaw", "fallback-chains.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[fallback-sidecar] failed to read ${CONFIG_PATH}: ${err.message}\n`
    );
    process.exit(2);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

function matchesTrigger(error, triggers) {
  if (!error) return false;
  const s = String(error).toLowerCase();
  for (const status of triggers.httpStatuses || []) {
    if (s.includes(String(status))) return true;
  }
  for (const pat of triggers.errorPatterns || []) {
    if (s.includes(String(pat).toLowerCase())) return true;
  }
  return false;
}

function resolveFallback(config, agentId, currentModel, errorStr) {
  const triggers = config.defaults?.triggers || {};
  if (!matchesTrigger(errorStr, triggers)) {
    return {
      ok: false,
      reason: `error '${errorStr}' did not match any trigger (statuses=${triggers.httpStatuses?.join(",")}, patterns=${triggers.errorPatterns?.join(",")})`,
    };
  }

  const chainName = config.agents?.[agentId];
  if (!chainName) {
    return {
      ok: false,
      reason: `agent '${agentId}' has no chain mapping in fallback-chains.json`,
    };
  }

  const chain = config.chains?.[chainName];
  if (!chain || !Array.isArray(chain.steps)) {
    return {
      ok: false,
      reason: `chain '${chainName}' not found or malformed`,
    };
  }

  const idx = chain.steps.indexOf(currentModel);
  if (idx === -1) {
    // Current model not in chain — fall to step 0.
    return {
      ok: true,
      fallbackModel: chain.steps[0],
      reason: `current model '${currentModel}' not in chain '${chainName}'; routing to step 0`,
      chain: chainName,
      step: 0,
    };
  }
  if (idx + 1 >= chain.steps.length) {
    return {
      ok: false,
      reason: `agent '${agentId}' already at last step of chain '${chainName}' (no further fallback)`,
      chain: chainName,
      step: idx,
    };
  }
  return {
    ok: true,
    fallbackModel: chain.steps[idx + 1],
    reason: `trigger matched; advancing chain '${chainName}' from step ${idx} (${currentModel}) to step ${idx + 1}`,
    chain: chainName,
    step: idx + 1,
  };
}

(async () => {
  const config = loadConfig();
  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stderr.write("[fallback-sidecar] empty stdin\n");
    process.exit(2);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[fallback-sidecar] bad JSON: ${err.message}\n`);
    process.exit(2);
  }

  const { agentId, model, error } = input;
  if (!agentId || !model) {
    process.stderr.write(
      "[fallback-sidecar] required fields: agentId, model (error optional)\n"
    );
    process.exit(2);
  }

  const result = resolveFallback(config, agentId, model, error || "");
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
})();
