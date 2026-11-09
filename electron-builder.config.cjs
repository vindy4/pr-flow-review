const path=require('node:path');
const arch=process.env.PR_FLOW_TARGET_ARCH || require('./scripts/desktop/platform.cjs').nativeArchitecture();
module.exports={
  appId:'com.prflowreview.desktop',productName:'PR Flow Review',
  directories:{output:'release',buildResources:'desktop'},
  artifactName:'PR-Flow-Review-${version}-${arch}.${ext}',
  files:['desktop/**/*.cjs','desktop/startup.html','desktop/startup.js','package.json'],
  extraResources:[{from:'dist',to:'dist'},
    {from:path.join('.cache','desktop-runtime',arch),to:'runtime'},
    {from:'docs/macos.md',to:'BUILDING.md'}],
  asar:true,npmRebuild:false,publish:null,
  mac:{target:[{target:'dmg',arch:[arch]}],category:'public.app-category.developer-tools',
    minimumSystemVersion:'13.0',icon:'desktop/icon.icns',hardenedRuntime:true,
    entitlements:'desktop/entitlements.mac.plist',entitlementsInherit:'desktop/entitlements.mac.plist',
    notarize:process.env.PR_FLOW_SIGNED_RELEASE==='1'},
  dmg:{title:'PR Flow Review',window:{width:540,height:360},
    contents:[{x:145,y:170},{x:395,y:170,type:'link',path:'/Applications'}]},
  afterSign:async context=>{
    if(process.env.PR_FLOW_SIGNED_RELEASE!=='1')return;
    const {execFileSync}=require('node:child_process');
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(context.appOutDir,'PR Flow Review.app')],{stdio:'inherit'});
  },
};
