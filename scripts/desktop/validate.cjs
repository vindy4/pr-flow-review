const fs=require('node:fs/promises');
const path=require('node:path');
function validateRelease(env=process.env){
  if(!env.CSC_LINK || !env.CSC_KEY_PASSWORD) throw new Error('A Developer ID certificate (CSC_LINK, CSC_KEY_PASSWORD) is required for a distribution release.');
  if(!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER)
    throw new Error('App Store Connect API notarization credentials (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER) are required.');
}
async function validateRuntime(root,arch){
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));}catch{throw new Error('Bundled runtime is missing. Run npm run desktop:prepare first.');}
  if(manifest.arch!==arch)throw new Error('Bundled runtime architecture does not match the target. Build natively on the matching Mac.');
  if(manifest.ghSecureStorage!==true)throw new Error('Bundled GitHub CLI must disable insecure credential fallback.');
  for(const file of ['backend/pr-flow-backend','tools/bin/git','tools/bin/gh','tools/libexec/git-core/git-remote-https','THIRD_PARTY_NOTICES.txt','sources.json']){
    try{await fs.access(path.join(root,file));}catch{throw new Error(`Bundled runtime is incomplete: ${file}`);}
  }
  const base=await fs.realpath(root);
  async function auditLinks(directory){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink()){
        const target=await fs.realpath(file).catch(()=>null);
        const relative=target?path.relative(base,target):'..';
        if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error(`Bundled runtime symlink escapes its resources: ${entry.name}`);
      }else if(entry.isDirectory())await auditLinks(file);
    }
  }
  await auditLinks(base);
  return manifest;
}
module.exports={validateRelease,validateRuntime};
