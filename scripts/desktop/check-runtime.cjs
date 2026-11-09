const fs=require('node:fs/promises');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {validateRuntime}=require('./validate.cjs');
const {childEnvironment}=require('../../desktop/security.cjs');
const {nativeArchitecture}=require('./platform.cjs');
async function main(){
  const arch=nativeArchitecture();
  const root=path.resolve(process.argv[2]);await validateRuntime(root,arch);
  const env=childEnvironment(root,{HOME:process.env.HOME,TMPDIR:process.env.TMPDIR});
  for(const [file,args] of [['backend/pr-flow-backend',['--self-test']],['tools/bin/git',['--version']],['tools/bin/gh',['--version']]]){
    console.log(execFileSync(path.join(root,file),args,{env,encoding:'utf8'}).trim());
  }
  async function scan(directory){for(const item of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory()){await scan(file);continue;}
    const kind=execFileSync('/usr/bin/file',['-b',file],{encoding:'utf8'});
    if(!kind.includes('Mach-O'))continue;
    if(!kind.includes(arch==='arm64'?'arm64':'x86_64'))throw new Error(`Wrong architecture: ${file}`);
    const commands=execFileSync('/usr/bin/otool',['-l',file],{encoding:'utf8'});
    const minimum=/\bminos (\d+)(?:\.(\d+))?/.exec(commands)||/\bversion (\d+)(?:\.(\d+))?/.exec(commands);
    if(minimum && Number(minimum[1])>13)throw new Error(`Runtime requires macOS ${minimum[1]}, above the macOS 13 baseline: ${file}`);
    const links=execFileSync('/usr/bin/otool',['-L',file],{encoding:'utf8'});
    for(const line of links.split('\n').slice(1)){
      const dependency=line.trim().split(' (')[0];
      if(dependency.startsWith('/')&&!dependency.startsWith('/usr/lib/')&&!dependency.startsWith('/System/Library/'))
        throw new Error(`External runtime dependency: ${dependency} in ${file}`);
    }
  }}
  await scan(root);console.log('Runtime architecture and dynamic-library audit passed.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
