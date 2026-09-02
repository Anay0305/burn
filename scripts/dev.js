#!/usr/bin/env node
// One-command dev: runs the collector and the Next.js dashboard together.
// If a collector is already running (e.g. the agent-monitor systemd service),
// ours exits with EADDRINUSE and the dashboard simply uses the existing one.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const collector = spawn('node', ['src/server.js'], { cwd: root, stdio: 'inherit' });
const web = spawn('npm', ['run', 'dev'], { cwd: path.join(root, 'web'), stdio: 'inherit' });

const stop = () => {
  collector.kill('SIGTERM');
  web.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
web.on('exit', stop);
collector.on('exit', (code) => {
  if (code !== 0) {
    console.log('[dev] collector exited (already running elsewhere?) — dashboard continues');
  }
});
