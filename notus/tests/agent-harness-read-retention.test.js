const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'notus-read-retention-'));
Object.assign(process.env,{NOTUS_RUNTIME_TARGET:'web',NOTUS_DATA_ROOT:root,NOTES_DIR:path.join(root,'notes'),DB_PATH:path.join(root,'db.sqlite'),LOG_DIR:path.join(root,'logs')});
(async()=>{
  require('../lib/indexer').triggerIncrementalIndex=async()=>({});
  const {createFile,updateFile,getFileById}=require('../lib/files');
  const {ensureConversation}=require('../lib/conversations');
  const {createSession,updateSessionStatus}=require('../lib/agentSession');
  const cid=ensureConversation({kind:'canvas',title:'读取保留'}).id;
  const {sessionId}=createSession({conversationId:cid,goal:'从历史快照恢复文章图片，保留新正文。',authorizedPaths:['article.md'],authorizedOps:['modify']});
  const src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const file=createFile('article.md',`# 文章\n![图](${src})`);
  const preview=await require('../lib/fileRevisions').previewFileRevision({file_path:file.path,draft_content:'# 新正文\n![图](https://example.com/wrong.png)',allow_image_changes:true},sessionId);
  updateFile(file.id,'# 新正文\n![图](https://example.com/wrong.png)');
  let turns=0,visionCalls=0,ref='';
  const tools=[];
  const llm=require('../lib/llm');
  llm.completeToolChat=async request=>{
    if(request.taskType==='agent_image_recognition'){visionCalls++;return{content:[{type:'text',text:'图片事实：原始配图可读取。'}]};}
    turns++;
    const results=request.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').map(b=>JSON.parse(b.content));
    const call=(name,input)=>{tools.push(name);return{content:[{type:'tool_use',id:`call-${turns}`,name,input}],stopReason:'tool_use'};};
    if(turns===1)return call('list_file_images',{path:file.path,operation_set_id:preview.operation_set_id,version:'before'});
    if(turns===2){ref=results.find(r=>r.items?.[0]?.ref)?.items[0].ref;assert(ref);return call('inspect_image',{ref,path:file.path});}
    if(turns>=3&&turns<=7)return call('list_materials',{offset:turns,limit:1});
    if(turns===8){
      assert(results.some(r=>r.items?.some(i=>i.ref===ref)),'经过五轮其他读取后快照图片目录仍在');
      assert(results.some(r=>r.observation==='图片事实：原始配图可读取。'),'视觉摘要直接可见且仍保留');
      return call('preview_file_revision',{file_path:file.path,draft_content:`# 新正文\n![图](${ref})`,allow_image_changes:true});
    }
    assert(turns<=10,'不能无进展循环');
    return{content:[{type:'text',text:'已恢复图片链接并保留新正文。'}],stopReason:'end_turn'};
  };
  delete require.cache[require.resolve('../lib/agentLoop')];
  updateSessionStatus(sessionId,'running');
  const result=await require('../lib/agentLoop').runAgentLoop({sessionId,approvalMode:'auto_confirm',llmConfig:{llmContextWindowTokens:60000}});
  assert.equal(result.status,'completed');
  assert.equal(visionCalls,1);
  assert.equal(tools.filter(t=>t==='list_file_images').length,1);
  assert(!tools.includes('read_tool_result'),'无需为短视觉摘要再发读取');
  assert(getFileById(file.id).content.includes(src));
  assert(getFileById(file.id).content.includes('新正文'));
  const {buildToolResultReceipt}=require('../lib/agentToolResultStore');
  const artifact={status:'ready',result_ref:'tool-result://test',relative_path:'test'};
  const receipt=buildToolResultReceipt({toolName:'inspect_image',result:{content:'token=do-not-leak '+ '图'.repeat(5000)},artifact});
  assert(!receipt.observation.includes('do-not-leak'));assert(receipt.observation_truncated);assert(receipt.observation.length<=4000);
  assert(!buildToolResultReceipt({toolName:'inspect_image',result:{content:'不应回退'},artifact:{status:'failed'}}).observation);
  console.log('Harness retention: snapshot list once + vision once → five intervening rounds → applied restoration, no redundant reads');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{require('../lib/db').getDb().close();fs.rmSync(root,{recursive:true,force:true});});
