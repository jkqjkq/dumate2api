const http = require('http');
const body = JSON.stringify({model:'claude-3-5-sonnet-20241022',max_tokens:100,stream:true,messages:[{role:'user',content:'hi'}]});
const req = http.request({host:'127.0.0.1',port:9080,path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'x-api-key':'nokey','anthropic-version':'2023-06-01'}},(res)=>{
  let out=''; res.on('data',c=>out+=c); res.on('end',()=>{ console.log('=== Anthropic stream status',res.statusCode,'ct',res.headers['content-type']); console.log(out); });
});
req.on('error',e=>console.log('ERR',e));
req.write(body); req.end();
