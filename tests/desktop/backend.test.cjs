const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {BackendController,stopProcess}=require('../../desktop/backend.cjs');

function child(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.pid=999999;c.exitCode=null;return c;}
test('readiness is validated and authenticated before a backend is exposed',async()=>{
  const c=child();let options;let checked=false;
  const controller=new BackendController({command:'/path with spaces/server',args:[],env:{},
    spawn:(cmd,args,opts)=>{assert.equal(cmd,'/path with spaces/server');options=opts;return c;},
    health:async(port,secret)=>{assert.equal(port,42345);assert.equal(secret.length,64);checked=true;},
    terminate:async()=>{},timeout:500});
  const started=controller.start();
  c.stdout.write('{"event":"ready","port":42345,"pid":999999}\n');
  const endpoint=await started;
  assert.equal(endpoint.port,42345);assert.equal(checked,true);assert.equal(options.detached,true);
  assert.equal(options.env.PR_FLOW_API_SECRET,endpoint.secret);
  await controller.stop();assert.equal(controller.endpoint,null);
});
test('startup timeout and premature exit fail without exposing diagnostics or leaving a child',async()=>{
  for(const mode of ['timeout','exit']) {
    const c=child();let stopped=0;
    const controller=new BackendController({command:'server',args:[],env:{},spawn:()=>c,
      health:async()=>{},terminate:async()=>{stopped++;},timeout:15});
    const started=controller.start();
    c.stderr.write('private token and source text');
    if(mode==='exit'){c.exitCode=2;c.emit('exit',2);}
    await assert.rejects(started,/start|exit|timed out/i);
    assert.equal(stopped,1);assert.equal(controller.endpoint,null);
  }
});
test('quit sends TERM then KILL to the owned process group even after leader exits',async()=>{
  const signals=[];const c=child();c.exitCode=0;
  await stopProcess(c,{kill:(pid,signal)=>signals.push([pid,signal]),grace:1});
  assert.deepEqual(signals,[[-999999,'SIGTERM'],[-999999,'SIGKILL']]);
});
test('canceling startup cannot publish a late ready endpoint',async()=>{
  const c=child();let healthResolve;
  const controller=new BackendController({command:'server',args:[],env:{},spawn:()=>c,
    health:()=>new Promise(resolve=>{healthResolve=resolve;}),terminate:async()=>{},timeout:100});
  const started=controller.start();const rejected=assert.rejects(started,/cancel|stop/i);
  c.stdout.write('{"event":"ready","port":42345,"pid":999999}\n');
  await controller.stop();healthResolve();await rejected;
  assert.equal(controller.endpoint,null);
});
