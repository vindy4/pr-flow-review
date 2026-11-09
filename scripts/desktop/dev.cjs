const path=require('node:path');const {spawn}=require('node:child_process');
const {nativeArchitecture}=require('./platform.cjs');const {validateRuntime}=require('./validate.cjs');
const root=path.resolve(__dirname,'../..');
async function main(){
  const arch=nativeArchitecture();await validateRuntime(path.join(root,'.cache','desktop-runtime',arch),arch);
  const child=spawn(require('electron'),[root],{cwd:root,stdio:'inherit',env:{...process.env,PR_FLOW_DEV_ARCH:arch}});
  child.on('exit',code=>{process.exitCode=code||0;});child.on('error',error=>{console.error(error.message);process.exitCode=1;});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
