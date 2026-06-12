#!/usr/bin/env node
// src/index.ts
import { VncMcpServer } from './server.js';
import { VncConfig } from './types.js';

process.on('uncaughtException', (error) => {
  if (error.message?.includes('invalid distance too far back') || 
      (error as any).code === 'Z_DATA_ERROR') {
    console.error('VNC compression error detected:', error.message);
    return;
  }
  
  console.error('Uncaught exception:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

const config: VncConfig = {
  host: process.env.VNC_HOST || 'localhost',
  port: parseInt(process.env.VNC_PORT || '5900'),
  password: process.env.VNC_PASSWORD
};

const server = new VncMcpServer(config);

function shutdown(signal: NodeJS.Signals) {
  console.error(`Received ${signal}, shutting down mcp-vnc...`);
  server.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.run().catch(console.error);
