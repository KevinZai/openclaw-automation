#!/usr/bin/env python3
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation

import json
import os
import sys
from datetime import datetime, timedelta

def parse_session_logs(log_dir, since_hours=24):
    """
    Parses OpenClaw session logs to extract per-agent, per-model cost data.
    """
    agent_costs = {}
    cutoff_time = datetime.now() - timedelta(hours=since_hours)

    agents_root = log_dir
    if not os.path.exists(agents_root):
        print(f"Error: Agent root directory not found at {agents_root}", file=sys.stderr)
        return {}

    # List all agent directories
    for agent_id in os.listdir(agents_root):
        agent_path = os.path.join(agents_root, agent_id)
        if not os.path.isdir(agent_path):
            continue

        sessions_path = os.path.join(agent_path, "sessions")
        if not os.path.exists(sessions_path):
            continue

        agent_costs[agent_id] = {'total': 0.0, 'models': {}}

        for session_file in os.listdir(sessions_path):
            if not session_file.endswith('.jsonl'):
                continue

            file_path = os.path.join(sessions_path, session_file)
            try:
                # Get file modification time to filter by since_hours
                mod_time_timestamp = os.path.getmtime(file_path)
                mod_time = datetime.fromtimestamp(mod_time_timestamp)
                if mod_time < cutoff_time:
                    continue # Skip older files

                with open(file_path, 'r') as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            message = entry.get('message', {})
                            if isinstance(message, dict) and 'usage' in message and 'model' in message:
                                usage = message['usage']
                                model_id = message['model']
                                cost = usage.get('cost', {}).get('total', 0.0)

                                agent_costs[agent_id]['total'] += cost
                                if model_id not in agent_costs[agent_id]['models']:
                                    agent_costs[agent_id]['models'][model_id] = 0.0
                                agent_costs[agent_id]['models'][model_id] += cost
                        except json.JSONDecodeError:
                            continue # Skip malformed JSON lines
            except Exception as e:
                print(f"Error processing {file_path}: {e}", file=sys.stderr)
                continue
    return agent_costs

def format_report(agent_costs, since_hours):
    """
    Formats the aggregated cost data into a human-readable report.
    """
    report = [f"LLM Costs by Agent (last {since_hours} hours):"]
    total_system_cost = 0.0

    if not agent_costs:
        report.append("  No LLM usage recorded.")
        return "\n".join(report)

    sorted_agents = sorted(agent_costs.items(), key=lambda item: item[1]['total'], reverse=True)

    for agent_id, data in sorted_agents:
        agent_total = data['total']
        total_system_cost += agent_total
        report.append(f"\nAgent: {agent_id} - Total: ${agent_total:.4f}")
        
        if data['models']:
            sorted_models = sorted(data['models'].items(), key=lambda item: item[1], reverse=True)
            for model_id, model_cost in sorted_models:
                report.append(f"  - {model_id}: ${model_cost:.4f}")
        else:
            report.append("  (No model usage)")
    
    report.append(f"\nSYSTEM TOTAL: ${total_system_cost:.4f}")
    return "\n".join(report)

if __name__ == "__main__":
    hours = 24
    if len(sys.argv) > 1:
        try:
            hours = int(sys.argv[1])
        except ValueError:
            print("Usage: python cost_by_agent.py [hours]", file=sys.stderr)
            sys.exit(1)

    log_root = os.path.expanduser("~/.openclaw/agents")
    costs = parse_session_logs(log_root, hours)
    print(format_report(costs, hours))
