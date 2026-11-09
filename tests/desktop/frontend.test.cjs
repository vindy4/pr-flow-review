const {test}=require('node:test');const assert=require('node:assert/strict');
const esbuild=require('esbuild');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const path=require('node:path');
test('desktop setup renders sign-in, device code, cancellation and recovery without tokens',async()=>{
  const result=await esbuild.build({entryPoints:[path.resolve('frontend/DesktopSetup.tsx')],bundle:true,write:false,
    platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime']});
  const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,mod,mod.exports);
  const render=auth=>renderToStaticMarkup(React.createElement(mod.exports.default,{auth,runtime:null}));
  assert.match(render({status:'signed_out'}),/Sign in to GitHub/);
  const pending=render({status:'signing_in',code:'ABCD-1234',url:'https://github.com/login/device'});
  assert.match(pending,/ABCD-1234/);assert.match(pending,/Cancel/);assert.match(pending,/github.com\/login\/device/);
  assert.match(render({status:'error',message:'GitHub sign-in expired.'}),/GitHub sign-in expired/);
  assert.match(render({status:'signed_in',login:'teammate'}),/teammate/);
});
