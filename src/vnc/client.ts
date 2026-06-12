// src/vnc/client.ts
import { VncClient } from '@computernewb/nodejs-rfb';
import { VncConfig, CoordinateValidation } from '../types.js';

export class VncConnectionManager {
  private config: VncConfig;
  private client: VncClient | null = null;
  private connectPromise: Promise<VncClient> | null = null;
  private isReady = false;
  private isClosing = false;

  constructor(config: VncConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    await this.getClient();
  }

  // Execute a callback with the persistent VNC connection.
  async executeWithConnection<T>(callback: (client: VncClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    return callback(client);
  }

  async getClient(): Promise<VncClient> {
    if (this.client && this.isReady && this.client.connected && this.client.authenticated) {
      return this.client;
    }

    try {
      return await this.createConnection();
    } catch (error) {
      throw new Error(`VNC reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    this.isClosing = true;

    if (!this.client) {
      return;
    }

    const client = this.client;
    this.client = null;
    this.isReady = false;
    this.connectPromise = null;

    try {
      console.error(`Closing VNC connection to ${this.config.host}:${this.config.port}`);
      client.disconnect();
    } catch (error) {
      console.error('Error closing VNC client:', error);
    }
  }

  private async createConnection(): Promise<VncClient> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.isClosing = false;
    this.isReady = false;

    this.connectPromise = new Promise((resolve, reject) => {
      const vncClient = new VncClient({
        debug: false,
        encodings: [
          VncClient.consts.encodings.raw, // Try raw encoding first for problematic servers
          VncClient.consts.encodings.copyRect,
          VncClient.consts.encodings.hextile
          // Removed zrle as it seems to cause "Invalid subencoding" errors on some servers
        ]
      });

      let hasReceivedInitialFramebuffer = false;
      let isSettled = false;
      let timeoutId: NodeJS.Timeout | null = null;
      let frameRequestTimer: NodeJS.Timeout | null = null;

      const cleanupPendingConnection = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (frameRequestTimer) {
          clearTimeout(frameRequestTimer);
          frameRequestTimer = null;
        }
        if (this.connectPromise) {
          this.connectPromise = null;
        }
      };

      const failConnection = (error: Error) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        cleanupPendingConnection();
        if (this.client === vncClient) {
          this.client = null;
          this.isReady = false;
        }
        try {
          vncClient.disconnect();
        } catch {
          // The socket may already be closed.
        }
        reject(error);
      };

      const markDisconnected = (reason: string) => {
        const wasCurrentClient = this.client === vncClient;

        if (wasCurrentClient) {
          this.client = null;
          this.isReady = false;
        }

        if (this.isClosing) {
          console.error(`VNC connection closed by MCP shutdown: ${reason}`);
        } else {
          console.error(`VNC connection lost: ${reason}`);
        }
      };

      const requestInitialFrameWhenSized = (attempt = 0) => {
        if (isSettled) {
          return;
        }

        const screenWidth = vncClient.clientWidth || 0;
        const screenHeight = vncClient.clientHeight || 0;

        if (screenWidth > 0 && screenHeight > 0) {
          console.error(`Requesting initial framebuffer: ${screenWidth}x${screenHeight}`);
          vncClient.requestFrameUpdate(true, 0, 0, 0, screenWidth, screenHeight);
          return;
        }

        if (attempt >= 20) {
          failConnection(new Error('VNC screen dimensions were not available after authentication'));
          return;
        }

        frameRequestTimer = setTimeout(() => {
          requestInitialFrameWhenSized(attempt + 1);
        }, 100);
      };

      vncClient.on('connected', () => {
        console.error(`Connected to VNC server at ${this.config.host}:${this.config.port}`);
      });

      vncClient.on('authenticated', () => {
        const screenWidth = vncClient.clientWidth || 0;
        const screenHeight = vncClient.clientHeight || 0;
        console.error(`VNC authenticated, screen: ${screenWidth}x${screenHeight}`);
        requestInitialFrameWhenSized();
      });

      vncClient.on('frameUpdated', () => {
        if (!hasReceivedInitialFramebuffer) {
          hasReceivedInitialFramebuffer = true;
          console.error('Received initial framebuffer, connection ready');
          this.client = vncClient;
          this.isReady = true;
          isSettled = true;
          cleanupPendingConnection();
          resolve(vncClient);
        }
      });

      vncClient.on('firstFrameUpdate', () => {
        if (!hasReceivedInitialFramebuffer) {
          hasReceivedInitialFramebuffer = true;
          console.error('Received initial framebuffer, connection ready');
          this.client = vncClient;
          this.isReady = true;
          isSettled = true;
          cleanupPendingConnection();
          resolve(vncClient);
        }
      });

      vncClient.on('connectError', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`VNC connection error: ${message}`);
        failConnection(new Error(`VNC connection error: ${message}`));
      });

      vncClient.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`VNC client error: ${message}`);
        failConnection(new Error(`VNC client error: ${message}`));
      });

      vncClient.on('connectTimeout', () => {
        failConnection(new Error('VNC connection timeout'));
      });

      vncClient.on('authError', () => {
        failConnection(new Error('VNC authentication failed'));
      });

      // Handle VNC disconnections
      vncClient.on('disconnected', () => {
        markDisconnected('client disconnected');
      });

      vncClient.on('closed', () => {
        markDisconnected('socket closed');
      });

      const connectionOptions = {
        host: this.config.host,
        port: this.config.port,
        path: null,
        auth: this.config.password ? { password: this.config.password } : undefined
      };

      vncClient.connect(connectionOptions);

      timeoutId = setTimeout(() => {
        failConnection(new Error('VNC connection timeout'));
      }, 15000); // Increased timeout to wait for initial frame
    });

    return this.connectPromise;
  }

  public validateCoordinates(client: VncClient, x: number, y: number): CoordinateValidation {
    const screenWidth = client.clientWidth || 0;
    const screenHeight = client.clientHeight || 0;
    
    if (screenWidth === 0 || screenHeight === 0) {
      return { valid: true }; // Allow if dimensions not yet known
    }
    
    if (x < 0 || x >= screenWidth || y < 0 || y >= screenHeight) {
      return {
        valid: false,
        error: `Coordinates (${x}, ${y}) are outside screen bounds (0, 0) to (${screenWidth - 1}, ${screenHeight - 1})`
      };
    }
    
    return { valid: true };
  }
}
