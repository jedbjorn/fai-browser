#!/usr/bin/env node
// Foreground daemon process. Auto-start (ensureDaemon) spawns this file; `fai-browser daemon` calls the same
// runDaemonMain().
import { runDaemonMain } from './daemon.js';

await runDaemonMain();
