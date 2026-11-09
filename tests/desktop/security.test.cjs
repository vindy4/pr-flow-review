const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {classifyURL,assetPath,trustedSender,externalURL,childEnvironment}=require('../../desktop/security.cjs');

test('only local assets and exact API routes/methods are accepted',()=>{
  assert.deepEqual(classifyURL('app://flow-review/api/health','GET'),{kind:'api',path:'/api/health'});
  assert.equal(classifyURL('app://flow-review/api/reviews/submit','POST').kind,'api');
  for(const [url,method] of [
    ['app://evil/api/health','GET'],['https://flow-review/','GET'],
    ['app://flow-review/api/reviews/submit','GET'],['app://flow-review/api/unknown','POST'],
    ['app://flow-review/api/health','DELETE'],['app://flow-review/api/jobs/not-an-id','GET'],
    ['app://flow-review/%2e%2e/secrets','GET'],['app://flow-review/../secrets','GET'],
    ['app://flow-review/%5c..%5csecret','GET'],['app://flow-review/%00','GET'],
  ]) assert.throws(()=>classifyURL(url,method),undefined,`${method} ${url}`);
});

test('assets cannot escape the static root through symlinks',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow assets '));
  try {
    await fs.mkdir(path.join(root,'dist')); await fs.writeFile(path.join(root,'secret'),'secret');
    await fs.writeFile(path.join(root,'dist/index.html'),'ok');
    await fs.symlink(path.join(root,'secret'),path.join(root,'dist/escape'));
    assert.equal(await assetPath(path.join(root,'dist'),'/'),await fs.realpath(path.join(root,'dist/index.html')));
    await assert.rejects(assetPath(path.join(root,'dist'),'/escape'));
    await assert.rejects(assetPath(path.join(root,'dist'),'/../secret'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('IPC accepts only the main application frame and external links are allowlisted',()=>{
  const frame={url:'app://flow-review/'};
  assert.equal(trustedSender({senderFrame:frame,sender:{mainFrame:frame}}),true);
  assert.equal(trustedSender({senderFrame:{url:'app://flow-review/'},sender:{mainFrame:frame}}),false);
  for(const url of ['https://evil.test/','file:///etc/passwd','app://evil/']) {
    const f={url}; assert.equal(trustedSender({senderFrame:f,sender:{mainFrame:f}}),false);
  }
  assert.equal(externalURL('https://github.com/owner/repo/pull/1'),true);
  assert.equal(externalURL('https://github.com/login/device'),true);
  for(const url of ['javascript:alert(1)','https://github.com.evil.test/','https://x@github.com/','file:///etc/passwd'])
    assert.equal(externalURL(url),false);
});

test('Finder child environment uses bundled helpers and removes credential overrides',()=>{
  const env=childEnvironment('/Applications/Flow App.app/Contents/Resources/runtime',{
    PATH:'/opt/homebrew/bin',GH_TOKEN:'secret',GITHUB_TOKEN:'secret',GH_ENTERPRISE_TOKEN:'secret',
    GITHUB_ENTERPRISE_TOKEN:'secret',GH_HOST:'evil',BASH_ENV:'/tmp/evil',ENV:'/tmp/evil',GH_TELEMETRY:'1',
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'evil',
  });
  assert.equal(env.GH_HOST,'github.com'); assert.ok(env.PATH.startsWith('/Applications/Flow App.app/Contents/Resources/runtime/tools/bin:'));
  assert.equal(env.GH_TELEMETRY,'0');
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','BASH_ENV','ENV','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'])
    assert.equal(env[key],undefined,key);
});
