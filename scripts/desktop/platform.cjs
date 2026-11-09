const {execFileSync}=require('node:child_process');
function nativeArchitecture({platform=process.platform,arch=process.arch,armSupported=()=>{
  try{return execFileSync('/usr/sbin/sysctl',['-n','hw.optional.arm64'],{encoding:'utf8'}).trim()==='1';}catch{return false;}
}}={}){return platform==='darwin'&&armSupported()?'arm64':arch;}
module.exports={nativeArchitecture};
