const path = require('node:path');
const fs = require('node:fs/promises');

const APP_ORIGIN = 'app://flow-review';
const API_METHODS = new Map([
  ['/api/health', 'GET'], ['/api/analyze', 'POST'], ['/api/files/read', 'POST'],
  ['/api/reviews/context', 'POST'], ['/api/reviews/refresh', 'POST'], ['/api/reviews/submit', 'POST'],
]);

function classifyURL(value, method = 'GET') {
  const match = /^app:\/\/flow-review(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(value);
  if (!match) throw new Error('Unknown application origin.');
  const pathname = decodeURIComponent(match[1] || '/');
  if (/[\\\x00-\x1f\x7f]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..'))
    throw new Error('Invalid application path.');
  if (pathname.startsWith('/api/')) {
    const expected = /^\/api\/jobs\/[a-f0-9]{32}$/.test(pathname) ? 'GET' : API_METHODS.get(pathname);
    if (!expected || expected !== method) throw new Error('Unknown API route or method.');
    return {kind: 'api', path: pathname};
  }
  if (method !== 'GET') throw new Error('Assets are read only.');
  return {kind: 'asset', path: pathname};
}

async function assetPath(root, pathname) {
  if (/[\\\x00-\x1f]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid asset.');
  const base = await fs.realpath(root);
  const file = await fs.realpath(path.join(base, pathname === '/' ? 'index.html' : pathname.slice(1)));
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(file)).isFile()) throw new Error('Invalid asset.');
  return file;
}

function trustedSender(event) {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame &&
    /^app:\/\/flow-review\/(?:[^?#]*)?(?:[?#].*)?$/.test(frame.url);
}

function externalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function childEnvironment(runtime, inherited = process.env) {
  const env = {...inherited};
  for (const key of Object.keys(env)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|BASH_ENV|ENV|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|PYTHONHOME|PYTHONPATH|DYLD_.*|GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_SSH.*|GIT_ASKPASS|SSH_ASKPASS|GH_BROWSER|BROWSER)$/.test(key)) delete env[key];
  }
  env.PATH = `${path.join(runtime, 'tools', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`;
  env.GIT_EXEC_PATH = path.join(runtime, 'tools', 'libexec', 'git-core');
  env.GIT_TEMPLATE_DIR = path.join(runtime, 'tools', 'share', 'git-core', 'templates');
  env.GH_HOST = 'github.com';
  env.GH_TELEMETRY = '0';
  env.GH_PROMPT_DISABLED = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.NO_COLOR = '1';
  return env;
}

module.exports = {APP_ORIGIN, classifyURL, assetPath, trustedSender, externalURL, childEnvironment};
