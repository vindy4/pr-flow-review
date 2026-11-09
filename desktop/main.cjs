const {app, BrowserWindow, protocol, session, ipcMain, dialog, shell, Menu} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {BackendController} = require('./backend.cjs');
const {AuthController} = require('./auth.cjs');
const {createProtocol} = require('./protocol.cjs');
const {APP_ORIGIN, trustedSender, externalURL, childEnvironment} = require('./security.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true}}]);
app.setName('PR Flow Review');
// Keep identity independent of Electron's development/package executable names.
const data = process.env.PR_FLOW_TEST_DATA_DIR || path.join(app.getPath('appData'),'PR Flow Review');
app.setPath('userData', data);
let window, backend, auth, stopping = false, runtime = {status:'starting'}, logFile, restarting;
const partition = 'persist:pr-flow-review';
const root = path.resolve(__dirname,'..');
const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath,'runtime') : path.join(root,'.cache','desktop-runtime',process.env.PR_FLOW_DEV_ARCH||process.arch);

async function log(event) {
  // Callers use constant event names; never pass subprocess output or exceptions.
  if (!logFile) return;
  try {
    const stat = await fs.stat(logFile).catch(() => null);
    if (stat?.size > 128 * 1024) await fs.rename(logFile,`${logFile}.previous`).catch(() => {});
    await fs.appendFile(logFile,`${new Date().toISOString()} ${event}\n`,{mode:0o600});
  } catch {}
}
function send(channel, state) { if (window && !window.isDestroyed()) window.webContents.send(channel,state); }
function setRuntime(state) { runtime=state;send('desktop:runtime',state); }
async function startBackend() {
  if (stopping) return;
  if (runtime.status==='ready' && backend.endpoint) return;
  setRuntime({status:'starting'});
  await log('backend-start');
  try {
    await backend.start();
    if(stopping) return;
    setRuntime({status:'ready'});await log('backend-ready');
    if(window && !window.isDestroyed()) await window.loadURL(`${APP_ORIGIN}/`);
  } catch {
    setRuntime({status:'error',message:'The review engine could not start. Retry, or reinstall the app if this continues.'});
    await log('backend-start-failed');
  }
}
function restartBackend() {
  if (restarting || stopping) return;
  setRuntime({status:'starting'});
  restarting=backend.stop().then(()=>startBackend()).catch(()=>{
    setRuntime({status:'error',message:'Unable to restart. Quit and reopen the application.'});
  }).finally(()=>{restarting=null;});
}
function openExternal(url) { if(externalURL(url)) return shell.openExternal(url); return Promise.resolve(); }
function createWindow() {
  if(window && !window.isDestroyed()) {window.show();window.focus();return;}
  window=new BrowserWindow({width:1480,height:980,minWidth:780,minHeight:600,backgroundColor:'#0b1426',
    title:'PR Flow Review',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),
      partition,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.once('ready-to-show',()=>window?.show());
  window.on('closed',()=>{window=null;});
  window.webContents.setWindowOpenHandler(({url})=>{void openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{
    if(url!==`${APP_ORIGIN}/` && url!==`${APP_ORIGIN}/startup.html`) {event.preventDefault();void openExternal(url);}
  });
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  void window.loadURL(runtime.status==='ready'?`${APP_ORIGIN}/`:`${APP_ORIGIN}/startup.html`);
}
function registerIPC() {
  const handle=(channel,fn)=>ipcMain.handle(channel,(event,...args)=>{
    if(stopping||!trustedSender(event)||event.sender!==window?.webContents||args.length) throw new Error('Unauthorized desktop request.');
    return fn();
  });
  handle('desktop:auth-status',()=>auth.status());
  handle('desktop:sign-in',()=>auth.start());
  handle('desktop:cancel-sign-in',()=>auth.cancel());
  handle('desktop:runtime-status',()=>runtime);
  handle('desktop:retry',()=>{restartBackend();return {status:'starting'};});
  handle('desktop:diagnostics',async()=>{shell.showItemInFolder(logFile);});
  handle('desktop:select-repository',async()=>{
    const preferences=path.join(data,'preferences.json');
    let previous;try{previous=JSON.parse(await fs.readFile(preferences,'utf8')).repository;}catch{}
    const selected=await dialog.showOpenDialog(window,{title:'Select a Git repository',properties:['openDirectory'],defaultPath:previous});
    if(selected.canceled||!selected.filePaths[0])return null;
    await fs.writeFile(preferences,JSON.stringify({repository:selected.filePaths[0]}),{mode:0o600});
    return selected.filePaths[0];
  });
}

if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>createWindow());
  app.whenReady().then(async()=>{
    await fs.mkdir(data,{recursive:true,mode:0o700});
    const logs=process.env.PR_FLOW_TEST_DATA_DIR?path.join(data,'logs'):path.join(os.homedir(),'Library','Logs','PR Flow Review');
    await fs.mkdir(logs,{recursive:true,mode:0o700});logFile=path.join(logs,'desktop.log');
    const env=childEnvironment(runtimeRoot);
    Object.assign(env,{PR_FLOW_DATA_DIR:data,
      PR_FLOW_CACHE_DIR:process.env.PR_FLOW_TEST_DATA_DIR?path.join(data,'cache'):path.join(os.homedir(),'Library','Caches','PR Flow Review'),
      PR_FLOW_RESOURCE_DIR:app.isPackaged?process.resourcesPath:root,PR_FLOW_DESKTOP:'1'});
    await fs.mkdir(env.PR_FLOW_CACHE_DIR,{recursive:true,mode:0o700});
    backend=new BackendController({command:path.join(runtimeRoot,'backend','pr-flow-backend'),args:[],env,cwd:data,
      onCrash:async()=>{if(stopping)return;await log('backend-exited');setRuntime({status:'error',message:'The review engine stopped. Saved drafts are preserved. Restart the engine to continue.'});}});
    auth=new AuthController({command:path.join(runtimeRoot,'tools','bin','gh'),env,
      openExternal,onChange:state=>send('desktop:auth',state)});
    const ses=session.fromPartition(partition);
    ses.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    ses.setPermissionCheckHandler(()=>false);
    await ses.protocol.handle('app',createProtocol({dist:path.join(app.isPackaged?process.resourcesPath:root,'dist'),desktop:__dirname,backend}));
    registerIPC();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'PR Flow Review',submenu:[{role:'about'},{type:'separator'},
        {label:'Restart Review Engine',click:()=>restartBackend()},
        {label:'Show Diagnostic Log',click:()=>shell.showItemInFolder(logFile)},
        {type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      {role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'},
    ]));
    createWindow();void startBackend();
    app.on('activate',()=>createWindow());
  }).catch(async()=>{await log('desktop-initialization-failed');dialog.showErrorBox('PR Flow Review could not start','Reinstall the application and try again.');app.quit();});
  app.on('before-quit',event=>{
    if(stopping)return;event.preventDefault();stopping=true;
    Promise.allSettled([auth?.cancel(),backend?.stop()]).finally(()=>app.quit());
  });
}
