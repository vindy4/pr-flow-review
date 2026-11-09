const {test}=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const {createProtocol}=require('../../desktop/protocol.cjs');
test('proxy injects its private secret and preserves API errors without accepting renderer authorization',async()=>{
  const server=http.createServer((req,res)=>{
    assert.equal(req.headers['x-pr-flow-secret'],'private');assert.equal(req.headers.authorization,undefined);
    res.writeHead(409,{'Content-Type':'application/json'});res.end('{"error":"stale snapshot"}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const handler=createProtocol({backend:{endpoint:{port:server.address().port,secret:'private'}}});
    const response=await handler(new Request('app://flow-review/api/reviews/submit',{method:'POST',body:'{}',headers:{'Content-Type':'application/json','X-PR-Flow-Secret':'evil',Authorization:'evil'}}));
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'stale snapshot'});
    const large=await handler(new Request('app://flow-review/api/analyze',{method:'POST',body:'x'.repeat(65537)}));
    assert.equal(large.status,413);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('slow renderer reads survive a large HTTP/1.0 response followed by socket EOF',async()=>{
  const body=JSON.stringify({data:'x'.repeat(256*1024)});
  const server=net.createServer(socket=>{
    socket.on('error',()=>{});
    socket.once('data',()=>socket.end(`HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const handler=createProtocol({backend:{endpoint:{port:server.address().port,secret:'private'}}});
    for(let attempt=0;attempt<3;attempt++){
      const response=await handler(new Request('app://flow-review/api/health'));
      const reader=response.body.getReader();const chunks=[];
      while(true){
        const {done,value}=await reader.read();if(done)break;
        chunks.push(Buffer.from(value));
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(response.status,200);
      assert.equal(Buffer.concat(chunks).toString(),body);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
