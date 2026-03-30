#!/usr/bin/env node
/**
 * @file input-sanitizer.js
 * @description Input sanitization checks for channel-facing agents
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-30
 *
 * Detects prompt injection patterns in incoming messages.
 * Can be called as a preProcess hook or standalone check.
 * Logs suspicious messages without blocking (alert-only mode).
 *
 * Patterns detected:
 * - System prompt extraction attempts ("ignore previous", "you are now")
 * - Instruction override attempts ("forget your rules", "new instructions")
 * - Data exfiltration attempts ("show me your config", "print your prompt")
 * - Role manipulation ("pretend you are", "act as root")
 */

const INJECTION_PATTERNS = [
  // System prompt extraction
  { pattern: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i, severity: 'HIGH', type: 'prompt_override' },
  { pattern: /forget\s+(your|all|previous)\s+(rules|instructions|context)/i, severity: 'HIGH', type: 'prompt_override' },
  { pattern: /you\s+are\s+now\s+(a|an|the)\s/i, severity: 'MEDIUM', type: 'role_manipulation' },
  { pattern: /new\s+instructions?\s*:/i, severity: 'HIGH', type: 'prompt_override' },
  { pattern: /system\s*prompt|initial\s*prompt|hidden\s*prompt/i, severity: 'HIGH', type: 'extraction' },

  // Data exfiltration
  { pattern: /show\s+me\s+your\s+(config|prompt|instructions|rules|system)/i, severity: 'HIGH', type: 'extraction' },
  { pattern: /print\s+(your\s+)?(system|initial)\s+(prompt|message|instructions)/i, severity: 'HIGH', type: 'extraction' },
  { pattern: /what\s+are\s+your\s+(instructions|rules|guidelines|constraints)/i, severity: 'MEDIUM', type: 'extraction' },
  { pattern: /repeat\s+(everything|all|the\s+text)\s+(above|before|from\s+the\s+start)/i, severity: 'HIGH', type: 'extraction' },
  { pattern: /output\s+(your|the)\s+(entire|full|complete)\s+(prompt|context|system)/i, severity: 'HIGH', type: 'extraction' },

  // Role manipulation
  { pattern: /pretend\s+(you\s+are|to\s+be)\s/i, severity: 'MEDIUM', type: 'role_manipulation' },
  { pattern: /act\s+as\s+(root|admin|sudo|developer|the\s+system)/i, severity: 'HIGH', type: 'role_manipulation' },
  { pattern: /jailbreak|DAN\s+mode|developer\s+mode/i, severity: 'HIGH', type: 'jailbreak' },

  // Command injection
  { pattern: /exec\s*\(|eval\s*\(|system\s*\(/i, severity: 'HIGH', type: 'code_injection' },
  { pattern: /\$\{.*\}|`.*`/i, severity: 'LOW', type: 'template_injection' },

  // API key fishing
  { pattern: /api[_\s]?key|secret[_\s]?key|access[_\s]?token|bearer\s+token/i, severity: 'MEDIUM', type: 'credential_fishing' },
  { pattern: /\.env|environment\s+variables?|1password|op\s+read/i, severity: 'MEDIUM', type: 'credential_fishing' },
];

function scanMessage(message) {
  const findings = [];
  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(message)) {
      findings.push({
        severity: rule.severity,
        type: rule.type,
        pattern: rule.pattern.source.slice(0, 40),
      });
    }
  }
  return findings;
}

// CLI mode — test a message
if (process.argv[2]) {
  const message = process.argv.slice(2).join(' ');
  const findings = scanMessage(message);
  if (findings.length === 0) {
    console.log('CLEAN — no injection patterns detected');
  } else {
    console.log(`ALERT — ${findings.length} pattern(s) detected:`);
    for (const f of findings) {
      console.log(`  [${f.severity}] ${f.type}: /${f.pattern}/`);
    }
  }
} else {
  // Module mode — export for hook usage
  module.exports = { scanMessage, INJECTION_PATTERNS };
  console.log('[input-sanitizer] Loaded. 17 patterns. Use: node input-sanitizer.js "test message"');
}
