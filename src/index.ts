#!/usr/bin/env node
// src/index.ts
import { VncMcpServer } from './server.js';
import { VncConfig } from './types.js';

function isTransientVncFramebufferError(error: { message?: string; code?: string } | undefined): boolean {
  return !!error && (
    error.message?.includes('invalid distance too far back') ||
    error.code === 'ERR_OUT_OF_RANGE' ||
    error.code === 'Z_DATA_ERROR'
  );
}

process.on('uncaughtException', (error) => {
  if (isTransientVncFramebufferError(error)) {
    console.error('Transient VNC framebuffer error ignored:', error.message);
    return;
  }
  
  console.error('Uncaught exception:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const error = reason as { message?: string; code?: string } | undefined;
  if (isTransientVncFramebufferError(error)) {
    console.error('Transient VNC framebuffer error ignored:', error?.message);
    return;
  }

  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

const config: VncConfig = {
  host: process.env.VNC_HOST || 'localhost',
  port: parseInt(process.env.VNC_PORT || '5900'),
  username: process.env.VNC_USER,
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
