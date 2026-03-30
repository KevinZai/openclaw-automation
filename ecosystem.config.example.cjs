// Example PM2 ecosystem config for openclaw-automation scripts
// Copy to ecosystem.config.cjs and adjust paths for your setup
module.exports = { apps: [
  { name: 'agent-heartbeat', script: 'agent-heartbeat-monitor.js', cron_restart: '*/10 * * * *', autorestart: false },
  { name: 'self-heal', script: 'self-heal.js', cron_restart: '*/5 * * * *', autorestart: false },
  { name: 'correction-propagator', script: 'correction-propagator.js', cron_restart: '0 12 * * *', autorestart: false },
  { name: 'skill-effectiveness', script: 'skill-effectiveness.js', cron_restart: '0 13 * * 1', autorestart: false },
  { name: 'config-drift-detector', script: 'config-drift-detector.js', cron_restart: '0 13 * * *', autorestart: false },
  { name: 'workspace-convention', script: 'workspace-convention-check.js', cron_restart: '0 14 * * 0', autorestart: false },
  { name: 'backup-verify', script: 'backup-verify.js', cron_restart: '30 12 * * *', autorestart: false },
  { name: 'competitive-monitor', script: 'competitive-monitor.js', cron_restart: '0 14 * * 1', autorestart: false },
  { name: 'morning-brief', script: 'morning-brief.js', cron_restart: '0 14 * * *', autorestart: false },
  { name: 'openclaw-doctor', script: 'openclaw-doctor-cron.js', cron_restart: '0 15,23 * * *', autorestart: false },
  { name: 'revenue-task-gen', script: 'revenue-task-generator.js', cron_restart: '0 12 * * *', autorestart: false },
  { name: 'self-improve', script: 'self-improve.js', cron_restart: '0 15 * * 0', autorestart: false },
  { name: 'free-fleet-optimizer', script: 'free-fleet-optimizer.js', cron_restart: '0 */2 * * *', autorestart: false },
  { name: 'scout-agent', script: 'scout-agent.js', cron_restart: '0 */4 * * *', autorestart: false },
]};
