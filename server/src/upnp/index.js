import NatAPI from '@silentbot1/nat-api';

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
    this.operation = Promise.resolve();
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
      if (await client.map(port) === false) throw new Error('gateway rejected the mapping');
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
      if (await client.unmap(port) === false) throw new Error('gateway rejected the unmapping');
      this.mappedPorts.delete(port);
      console.log(`[upnp] port ${port} unmapped`);
    } catch (e) {
      console.log(`[upnp] unmap port ${port} failed: ${e.message}`);
    }
  }

  /** Apply current settings: map the listen port when enabled, clean up when disabled. */
  apply(settings) {
    this.settings = settings;
    const port = Number(settings.listenPort) || 51413;
    const enabled = settings.upnpEnabled;
    return this._enqueue(async () => {
      for (const previous of [...this.mappedPorts]) if (previous !== port) await this.unmap(previous);
      if (enabled) await this.map(port);
      else for (const p of [...this.mappedPorts]) await this.unmap(p);
    });
  }

  destroy() {
    return this._enqueue(async () => {
      for (const p of [...this.mappedPorts]) await this.unmap(p);
      try { await this.client?.destroy(); } catch {}
      this.mappedPorts.clear();
      this.client = null;
    });
  }

  _enqueue(operation) {
    const run = this.operation.then(operation);
    this.operation = run.catch(() => {});
    return run;
  }
}
