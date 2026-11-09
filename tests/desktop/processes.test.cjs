const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {AuthController}=require('../../desktop/auth.cjs');const {stopProcess}=require('../../desktop/backend.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('real device-flow subprocess can complete and only exposes the user code',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow login fixture '));
  let auth;
  try{
    const file=path.join(root,'fake-gh');
    await fs.writeFile(file,'#!/bin/sh\nif [ "$1" = "api" ]; then echo teammate; exit 0; fi\necho "! First copy your one-time code: ABCD-1234" >&2\nread answer\nexit 0\n',{mode:0o700});
    const opened=[],states=[];
    auth=new AuthController({command:file,env:process.env,timeout:2000,
      terminate:child=>stopProcess(child,{grace:10}),openExternal:async url=>opened.push(url),onChange:state=>states.push(state)});
    await auth.start();
    for(let i=0;i<100&&auth.state.status!=='signed_in';i++)await wait(20);
    assert.equal(auth.state.status,'signed_in');assert.equal(auth.state.login,'teammate');
    assert.deepEqual(opened,['https://github.com/login/device']);assert.ok(states.some(state=>state.code==='ABCD-1234'));
  }finally{await auth?.cancel();await fs.rm(root,{recursive:true,force:true});}
});

test('real process group cleanup terminates a running helper descendant',async()=>{
  const child=spawn('/bin/sh',['-c','sleep 60 & echo $!; wait'],{detached:true,stdio:['ignore','pipe','ignore']});
  let helper;
  try{
    helper=await new Promise((resolve,reject)=>{child.stdout.once('data',data=>resolve(Number(data.toString().trim())));child.once('error',reject);});
    assert.ok(helper>1);await stopProcess(child,{grace:50});
    let alive=true;
    for(let i=0;i<50&&alive;i++){try{process.kill(helper,0);await wait(10);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}}
    assert.equal(alive,false);
  }finally{await stopProcess(child,{grace:1});}
});
