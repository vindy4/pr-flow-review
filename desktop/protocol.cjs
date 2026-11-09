const fs = require('node:fs/promises');
const path = require('node:path');
const {classifyURL, assetPath} = require('./security.cjs');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'";
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.json':'application/json'};

function createProtocol({dist, desktop, backend}) {
  return async request => {
    try {
      const route = classifyURL(request.url, request.method);
      if (route.kind === 'api') {
        const endpoint = backend.endpoint;
        if (!endpoint) return Response.json({error:'The review engine is unavailable. Restart it from the app menu.'},{status:503});
        const headers = {'X-PR-Flow-Secret':endpoint.secret};
        let body;
        if (request.method === 'POST') {
          const limit = route.path === '/api/reviews/refresh' ? 1024 * 1024 : 65536;
          // Bound reads rather than trusting Content-Length from the renderer.
          const reader = request.body?.getReader(); const chunks=[]; let size=0;
          if (reader) {
            while (true) {
              const {done,value}=await reader.read(); if(done) break;
              size+=value.byteLength;
              if(size>limit){await reader.cancel();return Response.json({error:'Request body is too large.'},{status:413});}
              chunks.push(Buffer.from(value));
            }
          }
          body=Buffer.concat(chunks);
          headers['Content-Type']=request.headers.get('Content-Type') || '';
        }
        const response=await fetch(`http://127.0.0.1:${endpoint.port}${route.path}`, {
          method:request.method,headers,body,signal:request.signal,
        });
        // Python closes each HTTP/1.0 response. Passing its live Undici stream
        // to Electron can leave the parser paused when EOF arrives and assert
        // outside this handler's catch. Drain it before renderer backpressure.
        const content=await response.arrayBuffer();
        return new Response(content,{status:response.status,headers:{
          'Content-Type':response.headers.get('Content-Type') || 'application/json',
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        }});
      }
      const startupFiles={'/startup.html':'startup.html','/desktop-startup.js':'startup.js'};
      const file = startupFiles[route.path] ? path.join(desktop,startupFiles[route.path]) : await assetPath(dist,route.path);
      return new Response(await fs.readFile(file),{headers:{
        'Content-Type':TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache',
      }});
    } catch {
      return Response.json({error:'The application request could not be completed.'},{status:400});
    }
  };
}
module.exports={createProtocol,CSP};
