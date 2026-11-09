const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {validateRuntime,validateRelease}=require('../../scripts/desktop/validate.cjs');
const {nativeArchitecture}=require('../../scripts/desktop/platform.cjs');
test('Rosetta builder selects host architecture and rejects mixed runtime targets',()=>{
  assert.equal(nativeArchitecture({platform:'darwin',arch:'x64',armSupported:()=>true}),'arm64');
  assert.equal(nativeArchitecture({platform:'darwin',arch:'x64',armSupported:()=>false}),'x64');
});
test('distribution requires explicit signing and notarization credentials',()=>{
  assert.throws(()=>validateRelease({}),/Developer ID/);
  assert.throws(()=>validateRelease({CSC_LINK:'certificate',CSC_KEY_PASSWORD:'password'}),/notarization/i);
  assert.doesNotThrow(()=>validateRelease({CSC_LINK:'certificate',CSC_KEY_PASSWORD:'password',APPLE_API_KEY:'/key',APPLE_API_KEY_ID:'id',APPLE_API_ISSUER:'issuer'}));
});
test('packaging rejects missing runtime files and foreign architecture',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime '));
  try{
    await assert.rejects(validateRuntime(root,'arm64'),/runtime/i);
    await fs.mkdir(path.join(root,'tools/bin'),{recursive:true});await fs.mkdir(path.join(root,'backend'),{recursive:true});
    await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({arch:'x64',ghSecureStorage:true}));
    await assert.rejects(validateRuntime(root,'arm64'),/architecture/i);
    await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({arch:'arm64',ghSecureStorage:true}));
    for(const file of ['backend/pr-flow-backend','tools/bin/git','tools/bin/gh','tools/libexec/git-core/git-remote-https','THIRD_PARTY_NOTICES.txt','sources.json']){
      await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'fixture');
    }
    await fs.symlink(os.tmpdir(),path.join(root,'backend/escaped-library'));
    await assert.rejects(validateRuntime(root,'arm64'),/symlink/i);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
