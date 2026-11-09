const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopProcess(child, {kill = process.kill, grace = 800} = {}) {
  if (!child?.pid || child.pid < 2) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (signal === 'SIGTERM') await delay(grace);
  }
}

class BackendController {
  constructor(options) { this.options = options; this.endpoint = null; this.child = null; this.pending = null; }
  start() {
    if (this.pending) return this.pending;
    if (this.endpoint) return Promise.resolve(this.endpoint);
    this.stopping = false;
    const secret = randomBytes(32).toString('hex');
    const {command, args, env, timeout = 30000} = this.options;
    this.pending = new Promise((resolve, reject) => {
      let settled = false, buffer = '', checking = false;
      const child = (this.options.spawn || spawn)(command, [...args, '--desktop', '--port', '0'], {
        env: {...env, PR_FLOW_DESKTOP: '1', PR_FLOW_API_SECRET: secret}, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'], cwd: this.options.cwd,
      });
      this.child = child;
      const fail = async message => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.endpoint = null;
        await (this.options.terminate || stopProcess)(child);
        if (this.child === child) this.child = null;
        reject(new Error(message));
      };
      this.cancelStart = () => fail('Review engine startup was canceled.');
      const timer = setTimeout(() => void fail('The local review engine timed out while starting.'), timeout);
      child.on('error', () => void fail('The local review engine could not start. Reinstall the app or retry.'));
      child.on('exit', () => {
        if (!settled) void fail('The local review engine exited before startup completed.');
        else if (!this.stopping && this.child === child) {
          this.endpoint = null;
          void (this.options.terminate || stopProcess)(child).finally(() => this.options.onCrash?.());
        }
      });
      child.stderr.on('data', () => {}); // Never log source text, paths, tokens or raw tracebacks.
      child.stdout.on('data', async data => {
        if (settled || checking) return;
        buffer += data.toString();
        if (buffer.length > 8192) return void fail('Invalid startup response from the review engine.');
        if (!buffer.includes('\n')) return;
        let record;
        try { record = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); } catch { return void fail('Invalid startup response from the review engine.'); }
        if (record.event !== 'ready' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || record.pid !== child.pid)
          return void fail('Invalid startup response from the review engine.');
        checking = true;
        try {
          await (this.options.health || (async (port, key) => {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
              headers: {'X-PR-Flow-Secret': key}, signal: AbortSignal.timeout(5000),
            });
            if (!response.ok || !(await response.json()).ok) throw new Error('health');
          }))(record.port, secret);
          if (settled || this.stopping || this.child !== child) return;
          settled = true; clearTimeout(timer);
          this.endpoint = {port: record.port, secret};
          resolve(this.endpoint);
        } catch { void fail('The local review engine did not pass its startup check.'); }
      });
    }).finally(() => { this.pending = null; this.cancelStart = null; });
    return this.pending;
  }
  async stop() {
    this.stopping = true; this.endpoint = null;
    if (this.pending && this.cancelStart) {
      await this.cancelStart();
      await this.pending?.catch(() => {});
      return;
    }
    const child = this.child; this.child = null;
    if (child) await (this.options.terminate || stopProcess)(child);
  }
}
module.exports = {BackendController, stopProcess};
