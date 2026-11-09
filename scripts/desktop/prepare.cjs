#!/usr/bin/env node
// Native macOS builder. Developer tools are build dependencies, never runtime dependencies.
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const sources=require('./sources.json');
const root=path.resolve(__dirname,'../..');
const {nativeArchitecture}=require('./platform.cjs');
const arch=nativeArchitecture();
const work=path.join(root,'.cache','desktop-build',arch);
const runtime=path.join(root,'.cache','desktop-runtime',arch);

async function run(command,args,{cwd=root,env={},log}={}){
  const handle=log?await fs.open(path.join(work,log),'a'):null;
  try {await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0',GOTELEMETRY:'off',...env},
      stdio:handle?['ignore',handle.fd,handle.fd]:'inherit'});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}${log?`; see ${path.join(work,log)}`:''}`)));
  });}finally{await handle?.close();}
}
async function fetchSource(name){
  const source=sources[name];const archive=path.join(work,`${name}.archive`);
  const valid=async()=>{try{return crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex')===source.sha256;}catch{return false;}};
  if(!await valid()){
    await fs.rm(archive,{force:true});
    await run('/usr/bin/curl',['--fail','--location','--retry','3','--proto','=https','--output',archive,source.url],{log:'download.log'});
    if(!await valid())throw new Error(`Checksum mismatch for ${name}; refusing this source.`);
  }
  const directory=path.join(work,source.directory);
  if(!await fs.stat(directory).catch(()=>null))await run('/usr/bin/tar',['-xf',archive,'-C',work]);
  return directory;
}
async function main(){
  if(process.platform!=='darwin'||!['arm64','x64'].includes(arch))throw new Error('Build natively on an Apple Silicon or Intel Mac.');
  await fs.mkdir(work,{recursive:true});await fs.mkdir(runtime,{recursive:true});
  const tools=path.join(runtime,'tools');await fs.mkdir(path.join(tools,'bin'),{recursive:true});
  console.log(`Preparing self-contained ${arch} runtime…`);
  const gh=await fetchSource('gh');
  await fs.copyFile(path.join(__dirname,'gh-secure_test.go'),path.join(gh,'internal/config/desktop_secure_test.go'));
  await run('python3',[path.join(__dirname,'patch-gh.py'),gh]);
  await run('go',['test','./internal/config','-run','^TestDesktop|^TestLoginSecureStorageUsesKeyring$','-count=1'],{cwd:gh,log:'gh-tests.log'});
  await run('go',['build','-trimpath','-ldflags',`-s -w -X github.com/cli/cli/v2/internal/build.Version=${sources.gh.version}-pr-flow -X github.com/cli/cli/v2/internal/build.Date=2026-11-03`,'-o',path.join(tools,'bin','gh'),'./cmd/gh'],{cwd:gh,env:{CGO_ENABLED:'0',GOARCH:arch==='x64'?'amd64':'arm64'},log:'gh-build.log'});
  console.log('GitHub CLI built with secure credential storage required.');
  const git=await fetchSource('git');
  const flags=[`prefix=${tools}`,'NO_DARWIN_PORTS=YesPlease','NO_GETTEXT=YesPlease','NO_OPENSSL=YesPlease',
    'NO_TCLTK=YesPlease','NO_PERL=YesPlease','NO_PYTHON=YesPlease','NO_EXPAT=YesPlease','NO_RUST=YesPlease',
    'RUNTIME_PREFIX=YesPlease','CURL_CONFIG=/usr/bin/false','CURL_LDFLAGS=-lcurl',
    `CFLAGS=-O2 -arch ${arch==='x64'?'x86_64':'arm64'} -mmacosx-version-min=13.0`,`LDFLAGS=-arch ${arch==='x64'?'x86_64':'arm64'} -mmacosx-version-min=13.0`];
  await run('/usr/bin/make',[`-j${Math.min(os.cpus().length,8)}`,...flags,'git','git-remote-http'],{cwd:git,log:'git-build.log'});
  // Stage only commands used by the app: the builtin dispatcher and HTTPS transport.
  const execPath=path.join(tools,'libexec','git-core');
  await fs.mkdir(execPath,{recursive:true});
  await fs.mkdir(path.join(tools,'share','git-core','templates'),{recursive:true});
  await fs.copyFile(path.join(git,'git'),path.join(tools,'bin','git'));
  await fs.copyFile(path.join(git,'git-remote-http'),path.join(execPath,'git-remote-http'));
  await fs.rm(path.join(execPath,'git-remote-https'),{force:true});
  await fs.symlink('git-remote-http',path.join(execPath,'git-remote-https'));
  for(const name of await fs.readdir(execPath))if(!['git-remote-http','git-remote-https'].includes(name))await fs.rm(path.join(execPath,name),{recursive:true,force:true});
  for(const name of await fs.readdir(path.join(tools,'bin')))if(!['git','gh'].includes(name))await fs.rm(path.join(tools,'bin',name),{force:true});
  for(const file of [path.join(tools,'bin','git'),path.join(execPath,'git-remote-http')])await run('/usr/bin/strip',['-x',file],{log:'git-build.log'});
  console.log('Git built against macOS system libraries. Freezing the analyzer…');
  await run('uv',['run','--frozen','--python','3.12','--group','desktop','python','-m','PyInstaller','--noconfirm','--clean','--onedir',
    '--name','pr-flow-backend','--paths',root,'--collect-all','tree_sitter','--collect-all','tree_sitter_javascript',
    '--collect-all','tree_sitter_typescript','--distpath',path.join(work,'frozen'),'--workpath',path.join(work,'pyinstaller'),
    '--specpath',work,path.join(root,'desktop','backend-entry.py')],{env:{UV_CACHE_DIR:path.join(root,'.cache','uv')},log:'python-build.log'});
  await fs.rm(path.join(runtime,'backend'),{recursive:true,force:true});
  await fs.cp(path.join(work,'frozen','pr-flow-backend'),path.join(runtime,'backend'),{recursive:true,verbatimSymlinks:true});
  await run(path.join(runtime,'backend','pr-flow-backend'),['--self-test']);
  await fs.copyFile(path.join(__dirname,'sources.json'),path.join(runtime,'sources.json'));
  await fs.copyFile(path.join(__dirname,'patch-gh.py'),path.join(runtime,'patch-gh.py'));
  await fs.copyFile(path.join(__dirname,'prepare.cjs'),path.join(runtime,'prepare.cjs'));
  await run('uv',['run','--frozen','--python','3.12','--group','desktop','python',path.join(__dirname,'collect-notices.py'),path.join(runtime,'PYTHON_NOTICES.txt')],{env:{UV_CACHE_DIR:path.join(root,'.cache','uv')}});
  await run('python3',[path.join(__dirname,'collect-go-notices.py'),gh,path.join(runtime,'GITHUB_CLI_NOTICES.txt')]);
  const licenses=[
    'PR Flow Review bundled components\n\nGit is GPL-2.0. Its complete corresponding source is included in sources/git-source.tar.xz. Git is built without source modifications.\nGitHub CLI is MIT licensed; complete source and the fail-closed credential patch are included.\nBuild instructions: see docs/macos.md in the PR Flow Review project.\n',
    await fs.readFile(path.join(git,'COPYING'),'utf8'),await fs.readFile(path.join(gh,'LICENSE'),'utf8'),
  ];
  await fs.writeFile(path.join(runtime,'THIRD_PARTY_NOTICES.txt'),licenses.join('\n\n'));
  // Include corresponding source with the distributed app, rather than relying on a third-party link.
  await fs.mkdir(path.join(runtime,'sources'),{recursive:true});
  await fs.copyFile(path.join(work,'git.archive'),path.join(runtime,'sources','git-source.tar.xz'));
  await fs.copyFile(path.join(work,'gh.archive'),path.join(runtime,'sources','gh-source.tar.gz'));
  await fs.writeFile(path.join(runtime,'manifest.json'),JSON.stringify({arch,ghSecureStorage:true,git:sources.git.version,gh:sources.gh.version,python:'3.12',macOS:'13.0'},null,2));
  await run(process.execPath,[path.join(__dirname,'check-runtime.cjs'),runtime]);
  console.log(`Runtime ready: ${runtime}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
