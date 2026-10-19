const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-cross-model-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET:'web', NOTUS_DATA_ROOT:root, NOTES_DIR:path.join(root,'notes'), DB_PATH:path.join(root,'db.sqlite'), LOG_DIR:path.join(root,'logs') });
const requests=[];
let mode='old';
let compactRequests=0;
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req) raw+=chunk;
  const body=JSON.parse(raw);requests.push({url:req.url,body});
  await new Promise(resolve=>setTimeout(resolve,25));
  if(mode==='compact' && compactRequests++===0) {
    res.writeHead(400,{'Content-Type':'application/json','x-request-id':'request-before-compact'});
    res.end(JSON.stringify({error:{message:'maximum context length exceeded',code:'context_length_exceeded'}}));return;
  }
  if(mode==='old' && requests.length>1 || mode==='incompatible') {
    res.writeHead(mode==='old'?402:400,{'Content-Type':'application/json','x-request-id':`request-${mode}`});
    res.end(JSON.stringify({error:{message:mode==='old'?'Payment required':'Invalid request for selected model; api_key=test-only',code:'invalid_model',type:'invalid_request_error',param:'model'},ignored:'request-body-must-not-be-logged'}));return;
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
  const {createSession,updateSessionStatus,loadMessagesCheckpoint,listRunLogs,listRunEvents}=require('../lib/agentSession');
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
  assert(log.includes('http_status'));assert(!log.includes('test-only'));assert(log.includes('Invalid request for selected model'));
  assert(!log.includes('request-body-must-not-be-logged'));
  const failures=listRunLogs(sessionId).filter(log=>log.tool_name==='__llm_request__');
  assert.equal(failures.length,2);
  assert(!require('../lib/agentResearch').getTaskActivity(sessionId).tool_records.some(log=>log.tool_name==='__llm_request__'),'模型失败不能算作已执行的文件工具');
  const diagnostic=failures[1].tool_result.diagnostics;
  assert.equal(diagnostic.http_status,400);assert.equal(diagnostic.model,'incompatible-model');assert.equal(diagnostic.protocol,'anthropic');
  assert.equal(diagnostic.provider_code,'invalid_model');assert.equal(diagnostic.provider_param,'model');
  assert.equal(diagnostic.provider_request_id,'request-incompatible');
  assert(diagnostic.provider_message.includes('Invalid request for selected model'));
  assert.equal(diagnostic.request.max_output,1024);assert.equal(diagnostic.request.context_window,60000);
  assert.equal(diagnostic.request.tool_call_count,1);assert.equal(diagnostic.request.tool_result_count,1);
  assert.equal(diagnostic.request.unmatched_tool_result_count,0);assert.equal(diagnostic.request.pending_tool_call_count,0);
  assert(diagnostic.request.duration_ms>=20);assert.equal(failures[1].duration_ms,diagnostic.request.duration_ms);
  assert(diagnostic.request.endpoint.endsWith('/v1/messages'));
  assert(!JSON.stringify(failures).includes('test-only'));
  assert.equal(events.find(e=>e.artifact_type==='run_error'&&e.diagnostics?.http_status===400).diagnostics.provider_request_id,'request-incompatible');
  const timeline=listRunEvents(sessionId);
  assert(JSON.stringify(timeline).includes('Invalid request for selected model'),'刷新读取执行事件时诊断仍存在');
  assert(!JSON.stringify(timeline).includes('test-only'));
  const timelineDiagnostic=timeline.find(row=>row.payload.diagnostics?.http_status===400).payload.diagnostics;
  assert.equal(timelineDiagnostic.request.max_output,1024);assert.equal(timelineDiagnostic.request.context_window,60000);
  mode='compact';
  const {sessionId:compactSession}=createSession({conversationId:cid,goal:'给出简短总结',authorizedPaths:[],authorizedOps:[]});
  updateSessionStatus(compactSession,'running');
  const compactResult=await runAgentLoop({sessionId:compactSession,llmConfig:{...config,llmConfigId:4,llmModel:'compact-model',llmApiProtocol:'anthropic'},llmRetryWait:async()=>{}});
  assert.equal(compactResult.status,'completed');
  const compactLogs=listRunLogs(compactSession).filter(row=>row.tool_name==='__llm_request__');
  assert.equal(compactLogs.length,1,'成功压缩后的首次400也必须入库且不重复');
  assert.equal(compactLogs[0].tool_result.diagnostics.provider_request_id,'request-before-compact');
  console.log('cross-model real HTTP resume passed: 402 → 400 → new Anthropic model, no tool replay');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.close();require('../lib/db').getDb().close();fs.rmSync(root,{recursive:true,force:true});});
