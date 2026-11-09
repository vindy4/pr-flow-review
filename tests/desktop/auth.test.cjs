const {test}=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {AuthController,parseDevicePrompt}=require('../../desktop/auth.cjs');
test('device flow exposes only a bounded user code and known GitHub verification URL',()=>{
  assert.deepEqual(parseDevicePrompt('! First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device'),{
    code:'ABCD-1234',url:'https://github.com/login/device',
  });
  assert.equal(parseDevicePrompt('token gho_secret https://evil.test/login/device'),null);
});
test('login cancellation and denied authorization terminate owned auth processes and keep output private',async()=>{
  for(const mode of ['cancel','failure']){
    const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.pid=999999;
    let stops=0;let invoked;
    const auth=new AuthController({command:'/bundled gh',env:{},spawn:(cmd,args)=>{invoked=args;return c;},
      terminate:async()=>{stops++;},openExternal:async()=>{},timeout:500});
    await auth.start();assert.ok(invoked.includes('--web'));assert.ok(!invoked.includes('--insecure-storage'));
    c.stderr.write('gho_private_token');
    if(mode==='cancel')await auth.cancel();else {c.emit('exit',1);await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(stops,1);assert.doesNotMatch(JSON.stringify(auth.state),/gho_private_token/);
    assert.equal(auth.state.status,mode==='cancel'?'signed_out':'error');
  }
});
test('concurrent status requests share one owned check process',async()=>{
  const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.pid=999999;
  let starts=0;
  const auth=new AuthController({command:'gh',env:{},spawn:()=>{starts++;return c;},terminate:async()=>{}});
  const first=auth.status();const second=auth.status();
  c.stdout.write('teammate');c.emit('exit',0);
  assert.equal((await first).login,'teammate');assert.equal((await second).login,'teammate');assert.equal(starts,1);
});
test('cancel during an in-flight status cleanup cannot spawn a detached login afterwards',async()=>{
  const check=new EventEmitter();check.stdout=new PassThrough();check.stderr=new PassThrough();check.pid=999999;
  const login=new EventEmitter();login.stdout=new PassThrough();login.stderr=new PassThrough();login.stdin=new PassThrough();login.pid=999998;
  let release;let cleanupCount=0;const spawned=[];
  const auth=new AuthController({command:'gh',env:{},openExternal:async()=>{},
    spawn:(_cmd,args)=>{spawned.push(args[0]);return args[0]==='api'?check:login;},
    terminate:async()=>{if(++cleanupCount===1)await new Promise(resolve=>{release=resolve;});}});
  const checking=auth.status();const starting=auth.start();
  await auth.cancel();release();await starting;
  const actual=[...spawned];
  check.emit('exit',1);await checking;
  await auth.cancel();
  assert.deepEqual(actual,['api']);assert.equal(auth.state.status,'signed_out');
});
test('two sign-in clicks during status cleanup launch only one login',async()=>{
  const check=new EventEmitter();check.stdout=new PassThrough();check.stderr=new PassThrough();check.pid=999999;
  const login=new EventEmitter();login.stdout=new PassThrough();login.stderr=new PassThrough();login.stdin=new PassThrough();login.pid=999998;
  let release;let cleaned=false;let logins=0;const gate=new Promise(resolve=>{release=resolve;});
  const auth=new AuthController({command:'gh',env:{},openExternal:async()=>{},spawn:(_cmd,args)=>{if(args[0]==='api')return check;logins++;return login;},
    terminate:async child=>{if(child===check&&!cleaned){await gate;cleaned=true;}}});
  const checking=auth.status();const first=auth.start();const second=auth.start();
  release();await new Promise(resolve=>setTimeout(resolve,1));
  check.emit('exit',1);await checking;
  // Resolve both promises before cleanup, and clean up even when the regression fails.
  await Promise.all([first,second]);await auth.cancel();assert.equal(logins,1);
});
