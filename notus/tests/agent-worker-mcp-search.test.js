const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const Module=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'notus-worker-mcp-'));
Object.assign(process.env,{NOTUS_RUNTIME_TARGET:'web',NOTUS_DATA_ROOT:root,NOTES_DIR:path.join(root,'notes'),ASSETS_DIR:path.join(root,'assets'),DB_PATH:path.join(root,'db.sqlite'),LOG_DIR:path.join(root,'logs'),NOTUS_AGENT_RUNTIME_MODE:'enforced'});
let calls=0,discoveries=0,modelCalls=0;
function mock(name,exports){const file=require.resolve(name);require.cache[file]={id:file,filename:file,loaded:true,exports};}
const tool={name:'mcp_search',description:'Search public web',input_schema:{type:'object',properties:{query:{type:'string'}},required:['query']},mcp:{serverId:'server',toolName:'web_search'}};
mock('../lib/llmConfigs',{resolveLlmRuntimeConfig:()=>({llmContextWindowTokens:60000})});
mock('../lib/llm',{completeToolChat:async request=>{modelCalls++;assert.ok(request.tools.some(t=>t.name==='mcp_search'));return modelCalls===1?{stop_reason:'tool_use',content:[{type:'tool_use',id:'search-1',name:'mcp_search',input:{query:'今天的新闻'}}]}:{stop_reason:'end_turn',content:[{type:'text',text:'已通过 MCP 查询。'}]};}});
mock('../lib/mcp',{...require('../lib/mcp'),prepareMcpTools:async(selection,goal,permissions,options)=>{assert.equal(options.forceRefresh,true);discoveries++;if(selection.mode==='off')return {tools:[],map:{},instructions:[]};return {tools:[tool],map:{mcp_search:tool.mcp},instructions:[]};},callMcpTool:async()=>{calls++;return {content:[{type:'text',text:JSON.stringify({results:[{url:'https://example.com/news',title:'新闻',content:'查询返回的新闻正文'}]})}]};}});
(async()=>{
 const {getDb}=require('../lib/db');const db=getDb();const {ensureConversation}=require('../lib/conversations');const {createSession,getSession}=require('../lib/agentSession');const {createTask,getTaskBySession}=require('../lib/agentTaskQueue');
 const cid=ensureConversation({kind:'agent',title:'MCP search'}).id;
 const sid=createSession({goal:'联网搜索今天的新闻',conversationId:cid,authorizedPaths:[''],webSearchEnabled:false,mcpSelection:{mode:'auto'}}).sessionId;
 const task=createTask({sessionId:sid,conversationId:cid,input:{user_query:'联网搜索今天的新闻'}});
 const filename=require.resolve('../lib/agentTaskWorker');const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.executeForTest=execute;',filename);
 await mod.exports.executeForTest(task);
 if (!calls) console.error(getTaskBySession(sid).last_error);
 assert.equal(discoveries,1,'Worker 与 Loop 必须共用一次发现结果');assert.equal(calls,1,'内置搜索关闭时仍可实际调用已授权 MCP');assert.ok(modelCalls>=2);assert.equal(getTaskBySession(sid).status,'completed');assert.equal(getSession(sid).status,'completed');
 const {hasSuccessfulResearch}=require('../lib/agentCompletionEvaluator');
 assert.equal(hasSuccessfulResearch(sid,'web'),true,'结构化 MCP 网页来源须被完成检查识别');
 const offId=createSession({goal:'联网搜索今天的新闻',conversationId:cid,authorizedPaths:[''],webSearchEnabled:false,mcpSelection:{mode:'off'}}).sessionId;
 const offTask=createTask({sessionId:offId,conversationId:cid,input:{user_query:'联网搜索今天的新闻'}});
 const before=modelCalls;await mod.exports.executeForTest(offTask);assert.equal(modelCalls,before);assert.equal(getTaskBySession(offId).status,'failed');
 const {recordMcpWebEvidence}=require('../lib/agentResearch');
 for(const [toolName,result] of [['list_notes',{results:[{url:'https://example.com',content:'local note'}]}],['web_search',{isError:true,results:[{url:'https://example.com',content:'error'}]}],['web_search',{results:[{url:'https://example.com'}]}]]) recordMcpWebEvidence({session:getSession(offId),toolName,result});
 assert.equal(hasSuccessfulResearch(offId,'web'),false,'普通 MCP/失败/无正文 URL 不计作联网证据');
 mod.exports.stopAgentTaskWorker();require('../lib/skills').stopSkillWatchers();db.close();fs.rmSync(root,{recursive:true,force:true});console.log('worker MCP search fallback with built-in search disabled passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
