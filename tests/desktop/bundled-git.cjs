// Read-only public GitHub transport test; no credentials or target checkout used.
const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');const os=require('node:os');const {execFileSync}=require('node:child_process');
const {childEnvironment}=require('../../desktop/security.cjs');
const {nativeArchitecture}=require('../../scripts/desktop/platform.cjs');
const root=path.resolve(__dirname,'../..');const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'flow git '));
const runtime=process.env.PR_FLOW_RUNTIME||path.join(root,'.cache','desktop-runtime',nativeArchitecture());
const env=childEnvironment(runtime,{HOME:temporary,TMPDIR:process.env.TMPDIR});env.GH_CONFIG_DIR=path.join(temporary,'gh');
const git=(...args)=>execFileSync(path.join(runtime,'tools/bin/git'),args,{env,encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']});
try{
  const repo=path.join(temporary,'snapshot cache.git');
  git('init','--bare',repo);
  git('-C',repo,'-c','credential.helper=','-c','credential.https://github.com.helper=!gh auth git-credential',
    'fetch','--depth=1','--no-tags','https://github.com/octocat/Hello-World.git','master');
  const sha=git('-C',repo,'rev-parse','FETCH_HEAD').trim();assert.match(sha,/^[0-9a-f]{40}$/);
  assert.match(git('-C',repo,'show',`${sha}:README`),/Hello World/);
  console.log('Bundled Git HTTPS fetch, credential-helper environment, bare snapshots and source reads passed without developer PATH.');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
