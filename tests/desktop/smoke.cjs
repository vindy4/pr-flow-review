// Exercise the actual installed app with isolated storage and an empty gh config.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {nativeArchitecture}=require('../../scripts/desktop/platform.cjs');
const root=path.resolve(__dirname,'../..');
async function main(){
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'Flow Review smoke '));
  const arch=nativeArchitecture();
  const appPath=process.env.PR_FLOW_APP || path.join(root,'release',arch==='arm64'?'mac-arm64':'mac','PR Flow Review.app');
  let launches=0;
  let app;const errors=[];
  const launch=async()=>{
    const launchPath=launches++&&process.env.PR_FLOW_REPLACEMENT_APP?process.env.PR_FLOW_REPLACEMENT_APP:appPath;
    const executablePath=path.join(launchPath,'Contents','MacOS','PR Flow Review');
    app=await electron.launch({executablePath,env:{...process.env,PATH:'/usr/bin:/bin',PR_FLOW_TEST_DATA_DIR:profile,
      GH_CONFIG_DIR:path.join(profile,'empty-gh'),GH_TOKEN:'',GITHUB_TOKEN:''},timeout:30000});
    const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('heading',{name:'PR Flow Review',exact:true}).waitFor({state:'hidden',timeout:30000});
    await page.getByRole('textbox',{name:'Pull request URL'}).waitFor();
    return page;
  };
  try{
    let page=await launch();
    assert.equal(await page.getByRole('textbox',{name:'Pull request URL'}).inputValue(),'');
    assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
    assert.equal(await page.evaluate(()=>typeof window.process),'undefined');
    const health=await page.evaluate(()=>fetch('/api/health').then(response=>response.json()));assert.equal(health.ok,true);
    const backendPids=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n')
      .map(line=>line.trim().split(/\s+/)).filter(parts=>Number(parts[1])===app.process().pid&&parts.join(' ').includes('pr-flow-backend --desktop'))
      .map(parts=>Number(parts[0]));
    assert.equal(backendPids.length,1);
    const state=await page.evaluate(async()=>{
      localStorage.setItem('desktop-smoke-draft','preserved');
      const auth=await window.desktop.authStatus();
      return {auth,storage:location.origin};
    });
    assert.equal(state.storage,'app://flow-review');assert.ok(['signed_out','signed_in'].includes(state.auth.status));
    await page.getByRole('button',{name:'Advanced options'}).click();
    await page.getByRole('button',{name:'Browse…'}).waitFor();
    // The native dialog is tested with Electron's dialog boundary stubbed, not by clicking a real folder.
    await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:['/tmp/repository with spaces']});});
    await page.getByRole('button',{name:'Browse…'}).click();
    assert.equal(await page.locator('.repository-input input').inputValue(),'/tmp/repository with spaces');
    // Foreign IPC must fail even if a compromised frame can invoke the channel.
    const blocked=await app.evaluate(async({ipcMain})=>{
      const handler=ipcMain._invokeHandlers.get('desktop:runtime-status');
      try{await handler({senderFrame:{url:'https://evil.test/'},sender:{mainFrame:{url:'https://evil.test/'}}});return false;}catch{return true;}
    });assert.equal(blocked,true);
    // Renderer-controlled secrets must not be forwarded, and oversized requests stop at the broker.
    const rejected=await page.evaluate(()=>fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(65537)}).then(r=>r.status));
    assert.equal(rejected,413);
    await page.screenshot({path:path.join(root,'.cache/desktop-work/desktop-smoke.png'),fullPage:true});
    await app.close();app=null;
    for(const pid of backendPids){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
    page=await launch();
    assert.equal(await page.evaluate(()=>localStorage.getItem('desktop-smoke-draft')),'preserved');
    await Promise.all([page.waitForEvent('domcontentloaded'),page.evaluate(()=>window.desktop.retry())]);
    await page.getByRole('textbox',{name:'Pull request URL'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('desktop-smoke-draft')),'preserved');
    await app.close();app=null;
    assert.deepEqual(errors,[]);
    const runtime=path.join(appPath,'Contents/Resources/runtime');
    const env={PATH:path.join(runtime,'tools/bin')+':/usr/bin:/bin',HOME:profile};
    const selftest=JSON.parse(execFileSync(path.join(runtime,'backend/pr-flow-backend'),['--self-test'],{env,encoding:'utf8'}));assert.equal(selftest.ok,true);
    console.log('Installed desktop smoke passed: native runtime, startup, API broker, sandbox, picker, IPC, relaunch persistence, restart, quit.');
  }finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
