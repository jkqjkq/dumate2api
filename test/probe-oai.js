const http = require('http');
function post(path, body, headers, cb) {
  const data = JSON.stringify(body);
  const req = http.request({host:'127.0.0.1',port:9080,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...headers}}, (res)=>{
    let out=''; res.on('data',c=>out+=c); res.on('end',()=>cb(res.statusCode, out, res.headers['content-type']));
  });
  req.on('error',e=>cb(0,String(e),''));
  req.write(data); req.end();
}
post('/v1/chat/completions', {model:'gpt-4o',stream:true,messages:[{role:'user',content:'hi'}]}, {}, (s,o,ct)=>{
  console.log('=== OpenAI stream status', s, 'ct', ct);
  console.log(o);
});
