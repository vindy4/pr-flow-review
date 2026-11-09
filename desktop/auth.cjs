const {spawn} = require('node:child_process');
const {stopProcess} = require('./backend.cjs');

function parseDevicePrompt(text) {
  const match = /(?:one-time code:|code:)\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text);
  return match ? {code: match[1], url: 'https://github.com/login/device'} : null;
}

class AuthController {
  constructor(options) { this.options = options; this.state = {status: 'checking'}; this.child = null; this.generation = 0; }
  update(state) { this.state = state; this.options.onChange?.(state); return state; }
  async status() {
    if (this.child) return this.state;
    if (this.statusPending) return this.statusPending;
    const generation = this.generation;
    this.statusPending = new Promise(resolve => {
      let output = '', finished = false;
      const child = (this.options.spawn || spawn)(this.options.command, ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], {
        env: this.options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.checkChild = child;
      const finish = async success => {
        if (finished) return; finished = true; clearTimeout(timer);
        await (this.options.terminate || stopProcess)(child);
        if (this.checkChild === child) this.checkChild = null;
        if (generation !== this.generation) return resolve(this.state);
        const login = output.trim();
        resolve(this.update(success && /^[a-zA-Z0-9-]{1,39}$/.test(login)
          ? {status: 'signed_in', login} : {status: 'signed_out'}));
      };
      const timer = setTimeout(() => void finish(false), 15000);
      child.stdout.on('data', data => { output = (output + data).slice(0, 256); });
      child.stderr.on('data', () => {});
      child.on('error', () => void finish(false)); child.on('exit', code => void finish(code === 0));
    }).finally(() => { this.statusPending = null; });
    return this.statusPending;
  }
  start() {
    if (this.startPending) return this.startPending;
    this.startPending = this.beginLogin().finally(() => { this.startPending = null; });
    return this.startPending;
  }
  async beginLogin() {
    if (this.child) return this.state;
    const generation = ++this.generation;
    const checking = this.checkChild;
    if (checking) {
      await (this.options.terminate || stopProcess)(checking);
      if (this.checkChild === checking) this.checkChild = null;
    }
    if (generation !== this.generation) return this.state;
    const child = (this.options.spawn || spawn)(this.options.command,
      ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
        env: {...this.options.env, GH_BROWSER: '/usr/bin/false'}, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    this.child = child;
    this.update({status: 'signing_in'});
    let output = '', prompted = false, finished = false;
    const finish = async (code, timedOut = false) => {
      if (finished) return; finished = true; clearTimeout(timer);
      await (this.options.terminate || stopProcess)(child);
      if (this.child === child) this.child = null;
      if (generation !== this.generation) return;
      if (code === 0) await this.status();
      else this.update({status: 'error', message: timedOut
        ? 'GitHub sign-in expired. Try signing in again.'
        : 'GitHub sign-in did not finish. Check your connection and Keychain access, then retry.'});
    };
    const timer = setTimeout(() => void finish(1, true), this.options.timeout || 10 * 60 * 1000);
    this.timer = timer;
    child.stdin.on('error', () => {});
    const receive = data => {
      if (generation !== this.generation || finished) return;
      output = (output + data.toString()).slice(-4096);
      const prompt = parseDevicePrompt(output);
      if (prompt && !prompted) {
        prompted = true; this.update({status: 'signing_in', ...prompt});
        child.stdin.write('\n');
        Promise.resolve(this.options.openExternal(prompt.url)).catch(() => {});
      }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', () => void finish(1)); child.on('exit', code => void finish(code));
    return this.state;
  }
  async cancel() {
    this.generation++; clearTimeout(this.timer);
    const child = this.child; this.child = null;
    if (child) await (this.options.terminate || stopProcess)(child);
    if (this.checkChild) { await (this.options.terminate || stopProcess)(this.checkChild); this.checkChild = null; }
    return this.update({status: 'signed_out'});
  }
}
module.exports = {AuthController, parseDevicePrompt};
