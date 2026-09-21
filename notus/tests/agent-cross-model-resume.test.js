const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-cross-model-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET:'web', NOTUS_DATA_ROOT:root, NOTES_DIR:path.join(root,'notes'), DB_PATH:path.join(root,'db.sqlite'), LOG_DIR:path.join(root,'logs') });
const requests=[];
let mode='old';
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req) raw+=chunk;
  const body=JSON.parse(raw);requests.push({url:req.url,body});
  if(mode==='old' && requests.length>1 || mode==='incompatible') {
    res.writeHead(mode==='old'?402:400,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:mode==='old'?'Payment required':'Invalid request for selected model'}}));return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=x=>res.write(`data: ${JSON.stringify(x)}\n\n`);
  if(mode==='old') {
    emit({choices:[{delta:{tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read_file',arguments:'{"path":"resume.md"}'}}]},finish_reason:'tool_calls'}]});
    res.end('data: [DONE]\n\n');
  } else {
    emit({type:'message_start',message:{usage:{input_tokens:20,output_tokens:0}}});
    emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'已读取文章，从保存的进度完成总结。'}});
    emit({type:'content_block_stop',index:0});
    emit({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:10}});
    emit({type:'message_stop'});res.end();
  }
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {createFile}=require('../lib/files');
  const {ensureConversation}=require('../lib/conversations');
  const {createSession,updateSessionStatus,loadMessagesCheckpoint}=require('../lib/agentSession');
  const {runAgentLoop}=require('../lib/agentLoop');
  const {listExecutionSegments}=require('../lib/agentExecutionSegments');
  createFile('resume.md','# 已完成的读取\n正文');
  const cid=ensureConversation({kind:'agent',title:'跨协议恢复'}).id;
  const {sessionId}=createSession({conversationId:cid,goal:'读取 resume.md 并总结',authorizedPaths:['resume.md'],authorizedOps:['modify']});
  const config={llmApiKey:'test-only',llmBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,llmContextWindowTokens:60000,llmMaxOutputTokens:1024};
  const events=[];
  const run=async(llmConfig)=>{updateSessionStatus(sessionId,'running');return runAgentLoop({sessionId,llmConfig:{...config,...llmConfig},llmRetryWait:async()=>{},onStream:e=>events.push(e)});};
  assert.equal((await run({llmConfigId:1,llmModel:'old-model',llmApiProtocol:'openai'})).status,'waiting_model_recovery');
  assert(loadMessagesCheckpoint(sessionId));
  mode='incompatible';
  assert.equal((await run({llmConfigId:2,llmModel:'incompatible-model',llmApiProtocol:'anthropic'})).status,'waiting_model_recovery');
  assert(loadMessagesCheckpoint(sessionId),'HTTP400 must retain the checkpoint');
  mode='new';
  assert.equal((await run({llmConfigId:3,llmModel:'new-model',llmApiProtocol:'anthropic'})).status,'completed');
  assert.equal(events.filter(e=>e.stage==='tool_start').length,1,'completed read is never replayed');
  const last=requests.at(-1);
  assert.equal(last.body.model,'new-model');assert.equal(last.url,'/v1/messages');
  const blocks=last.body.messages.flatMap(m=>m.content);
  assert(blocks.some(b=>b.type==='tool_use'&&b.id==='call_read'));
  assert(blocks.some(b=>b.type==='tool_result'&&b.tool_use_id==='call_read'));
  assert.equal(requests.filter(r=>r.body.model==='incompatible-model').length,1,'400 must not auto-loop');
  const windows=listExecutionSegments(sessionId).flatMap(s=>s.request_windows);
  assert.deepEqual(windows.map(w=>w.llm_config_id),[1,1,2,3]);
  const log=fs.readdirSync(path.join(root,'logs')).map(f=>fs.readFileSync(path.join(root,'logs',f),'utf8')).join('');
  assert(log.includes('http_status'));assert(!log.includes('test-only'));assert(!log.includes('Invalid request for selected model'));
  console.log('cross-model real HTTP resume passed: 402 → 400 → new Anthropic model, no tool replay');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.close();require('../lib/db').getDb().close();fs.rmSync(root,{recursive:true,force:true});});
