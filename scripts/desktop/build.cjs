const path=require('node:path');const fs=require('node:fs/promises');const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {validateRelease,validateRuntime}=require('./validate.cjs');
const {nativeArchitecture}=require('./platform.cjs');
const arch=nativeArchitecture();
const root=path.resolve(__dirname,'../..');
async function run(command,args,env=process.env){await new Promise((resolve,reject)=>{
  const c=spawn(command,args,{cwd:root,env,stdio:'inherit'});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
});}
async function main(){
  const release=process.argv.includes('--release');
  if(process.platform!=='darwin')throw new Error('Build the macOS app on macOS.');
  if(release)validateRelease();
  await validateRuntime(path.join(root,'.cache','desktop-runtime',arch),arch);
  await run('npm',['run','build']);
  const env={...process.env,PR_FLOW_SIGNED_RELEASE:release?'1':'0',PR_FLOW_TARGET_ARCH:arch};
  if(!release){env.CSC_IDENTITY_AUTO_DISCOVERY='false';delete env.CSC_LINK;delete env.CSC_NAME;delete env.CSC_KEY_PASSWORD;}
  await run(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),'--mac',`--${arch}`, '--publish','never','--config',path.join(root,'electron-builder.config.cjs'),...(process.argv.includes('--dir')?['--dir']:[])],env);
  const output=path.join(root,'release');
  for(const name of await fs.readdir(output))if(name.endsWith(`-${arch}.dmg`)){
    const file=path.join(output,name);
    if(release){
      const result=JSON.parse(execFileSync('/usr/bin/xcrun',['notarytool','submit',file,
        '--key',process.env.APPLE_API_KEY,'--key-id',process.env.APPLE_API_KEY_ID,'--issuer',process.env.APPLE_API_ISSUER,
        '--wait','--output-format','json'],{encoding:'utf8'}));
      if(result.status!=='Accepted')throw new Error('Apple did not accept the DMG notarization submission.');
      execFileSync('/usr/bin/xcrun',['stapler','staple',file],{stdio:'inherit'});
      execFileSync('/usr/bin/xcrun',['stapler','validate',file],{stdio:'inherit'});
    }
    await fs.writeFile(`${file}.sha256`,`${crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${name}\n`);
  }
  if(release){
    const app=path.join(output,arch==='arm64'?'mac-arm64':'mac','PR Flow Review.app');
    execFileSync('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app],{stdio:'inherit'});
  }
  console.log(release?'Signed release artifacts built and verified.':'Unsigned development build only. Sign and notarize a release before sharing with teammates.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
