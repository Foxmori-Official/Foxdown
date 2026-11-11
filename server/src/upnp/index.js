import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NatAPI = require('nat-api');

/**
 * UPnP/NAT-PMP port mapping manager (reference: Motrix src/main/core/UPnPManager.js,
 * a thin wrapper over the nat-api package). Maps/unmaps the BT listen port;
 * failures only warn and never block downloads.
 */
export class UpnpManager {
  constructor(settings) {
    this.settings = settings;
    this.client = null;
    this.mappedPorts = new Set();
  }

  _ensureClient() {
    if (!this.client) {
      this.client = new NatAPI({ autoUpdate: true });
    }
    return this.client;
  }

  /** Map a port. Returns false on failure without affecting downloads. */
  async map(port) {
    if (!port) return false;
    if (this.mappedPorts.has(port)) return true;
    try {
      const client = this._ensureClient();
      await new Promise((resolve, reject) => client.map(port, (err) => err ? reject(err) : resolve()));
      this.mappedPorts.add(port);
      console.log(`[upnp] port ${port} mapped (UPnP/NAT-PMP)`);
      return true;
    } catch (e) {
      console.log(`[upnp] map port ${port} failed: ${e.message}`);
      return false;
    }
  }

  async unmap(port) {
    if (!port || !this.mappedPorts.has(port)) return;
    try {
      const client = this._ensureClient();
      await new Promise((resolve, reject) => client.unmap(port, (err) => err ? reject(err) : resolve()));
      this.mappedPorts.delete(port);
      console.log(`[upnp] port ${port} unmapped`);
    } catch (e) {
      console.log(`[upnp] unmap port ${port} failed: ${e.message}`);
    }
  }

  /** Apply current settings: map the listen port when enabled, clean up when disabled. */
  async apply(settings) {
    this.settings = settings;
    const port = Number(settings.listenPort) || 51413;
    if (settings.upnpEnabled) {
      await this.map(port);
    } else if (this.mappedPorts.size) {
      for (const p of [...this.mappedPorts]) await this.unmap(p);
    }
  }

  async destroy() {
    for (const p of [...this.mappedPorts]) await this.unmap(p);
    try { this.client?.destroy(); } catch {}
    this.client = null;
  }
}
