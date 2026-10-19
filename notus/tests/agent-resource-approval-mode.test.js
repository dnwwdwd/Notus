const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-approval-mode-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'notus.db'), ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session') });
function stub(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
stub('../lib/runtime', { ensureRuntime: () => ({ ok: true }) });
stub('../lib/agentTaskWorker', { wakeAgentTaskWorker: () => {} });
stub('../lib/indexer', { triggerIncrementalIndex: async () => {}, removeFile: () => {} });
let effects = 0, failInstall = false, plan = [], calls = 0;
stub('../lib/llm', { completeToolChat: async () => { calls++; return { content: plan.length ? [plan.shift()] : [{ type: 'text', text: '已处理可执行步骤，资源结果以确认卡回执为准。' }], stopReason: plan.length ? 'tool_use' : 'end_turn', usage: { total_tokens: 1 } }; } });
const skills = require('../lib/skills');
const skill = { id: 'skill-test', name: 'test-skill', enabled: true, managed: true };
skills.installFromGit = async () => { effects++; if (failInstall) throw Object.assign(new Error('测试仓库无法访问'), { code: 'GIT_UNAVAILABLE' }); return { skills: [skill] }; };
skills.getSkill = () => skill;
skills.getSkillDraft = (id) => ({ id: 'draft-test', name: skill.name, validation: [], metadata: id === 'revision-test' ? {operation:'update'} : {}, files: [{ path: 'SKILL.md' }] });
skills.installSkillDraft = () => { effects++; return skill; };
skills.updateSkillFromGit = async () => { effects++; return { skill, jobId: 'job-test' }; };
skills.setSkillEnabled = () => { effects++; return skill; };
skills.deleteSkill = () => { effects++; };
const mcp = require('../lib/mcp');
const server = { id: 'server-test', name: 'Test Server', transport: 'streamable_http', enabled: true, config: { http: { url: 'https://example.com/mcp' } } };
mcp.getServer = () => server;
mcp.cachedTools = () => [];
mcp.saveServer = async () => { effects++; return server; };
mcp.removeServer = async () => { effects++; };
mcp.testServer = async () => ({ tool_count: 0 });
mcp.callMcpTool = async () => { effects++; return { content: [{type:'text',text:'done'}] }; };
const globals = require('../lib/globalAgentFiles');
globals.agentUpdateAllowed = () => true;
globals.saveFile = () => { effects++; return { saved: true }; };
const { ensureConversation } = require('../lib/conversations');
const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
const queue = require('../lib/agentTaskQueue');
const interactions = require('../lib/conversationInteractions');
const tools = require('../lib/agentTools');
const { issueCapability } = require('../lib/agentControlPlane');
const { getDb } = require('../lib/db');
function task(mode) { const c = ensureConversation({ kind: 'agent', title: 'approval test' }); const s = createSession({ goal: '安装并维护 Skill 和 MCP，检查资源', conversationId: c.id, authorizedPaths: ['*'], authorizedOps: ['create','modify'] }); queue.createTask({ sessionId: s.sessionId, conversationId: c.id, approvalMode: mode }); return getSession(s.sessionId); }
function loadRoute(relative) { const filename = path.resolve(__dirname, relative); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(fs.readFileSync(filename, 'utf8').replace('export default async function handler', 'module.exports = async function handler'), filename); return mod.exports; }
const respond = loadRoute('../pages/api/interactions/[id]/respond.js');
async function decision(card, action = 'confirm', ticket = null) { const req = { method: 'POST', query: { id: card.id }, headers: {}, body: { action, resume_ticket: ticket || issueCapability({ sessionId: card.payload.agent_session_id, interactionId: card.id, action: 'respond' }) } }; const res = { statusCode: 200, setHeader() {}, getHeader() {}, on() {}, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } }; await respond(req,res); return res; }
const cases = [
 ['install_skill_from_git', { repository_url: 'https://github.com/example/skill' }],
 ['install_skill_draft', { draft_id: 'draft-test' }],
 ['install_skill_draft', { draft_id: 'revision-test' }],
 ['update_skill_from_git', { skill_id: skill.id }],
 ['set_skill_enabled', { skill_id: skill.id, enabled: false }],
 ['set_skill_enabled', { skill_id: skill.id, enabled: true }],
 ['uninstall_skill', { skill_id: skill.id }],
 ['add_mcp_server', { name: 'Test', transport: 'streamable_http', http: { url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'private-test-credential' }] } }],
 ['update_mcp_server', { server_id: server.id, name: 'Changed' }],
 ['set_mcp_server_enabled', { server_id: server.id, enabled: false }],
 ['set_mcp_server_enabled', { server_id: server.id, enabled: true }],
 ['remove_mcp_server', { server_id: server.id }],
 ['update_global_agent_file', { file: 'memory', content: '用户喜欢中文', expected_hash: 'hash', evidence: '以后使用中文' }],
];
async function invoke(s, name, input) { return tools.executeToolSafely({ name, input }, getSession(s.id), undefined, { skipResultLimit: true }); }
(async () => {
 for (const mode of ['auto_confirm','manual_confirm']) for (const [name,input] of cases) {
  const s=task(mode), before=effects;
  const result=await invoke(s,name,input); assert(!result.error, `${name}: ${JSON.stringify(result)}`);
  if (mode==='auto_confirm') { assert.equal(effects,before+1,name); assert(!result.approval_required,name); }
  else {
   assert.equal(effects,before,name); assert(result.approval_required,name);
   assert(!JSON.stringify(result).includes('private-test-credential'));
   const replay=await invoke(s,name,input); assert.equal(replay.interaction_id,result.interaction_id, 'pending request deduplicated');
   updateSessionStatus(s.id,'waiting_interaction'); queue.settleTaskRun(s.id,'waiting_interaction');
   const done=await decision(result.interaction); assert.equal(done.statusCode,200,name); assert.equal(done.body.resolution_status,'resolved',JSON.stringify(done.body)); assert.equal(effects,before+1,name);
   assert.equal(getSession(s.id).status,'queued_resume');
   await decision(result.interaction); assert.equal(effects,before+1, 'no duplicate effect');
  }
 }
 // Cancel each mutation without an effect, and reject an empty decision.
 for (const [name,input] of cases) { const s=task('manual_confirm'), before=effects; const r=await invoke(s,name,input); assert.equal((await decision(r.interaction,'')).statusCode,400); assert.equal((await decision(r.interaction,'cancel')).body.resolution_status,'cancelled'); assert.equal(effects,before); const repeated=await invoke(s,name,input); assert(!repeated.approval_required); assert(repeated.cancelled); }
 // Failure settles the card and schedules the original waiting task exactly once.
 const s=task('manual_confirm'); const r=await invoke(s,...cases[0]); updateSessionStatus(s.id,'waiting_interaction'); queue.settleTaskRun(s.id,'waiting_interaction'); failInstall=true;
 const failed=await decision(r.interaction); assert.equal(failed.body.resolution_status,'failed'); assert.equal(failed.body.interaction.status,'failed'); assert.equal(getSession(s.id).status,'queued_resume');
 assert(require('../lib/agentSession').listRunEvents(s.id).some(event => event.payload?.artifact_type === 'resource_resolution' && event.payload?.status === 'failed'));
 const before=effects; await decision(r.interaction); assert.equal(effects,before); failInstall=false;
 // M9: replaying a failed card must never wake the session. Only the request that
 // actually performed pending→failed may auto-resume (covered above at 'queued_resume').
 const replayProbe=task('manual_confirm'); const replayCard=await invoke(replayProbe,...cases[0]); failInstall=true;
 const firstFail=await decision(replayCard.interaction);
 assert.equal(firstFail.body.resolution_status,'failed');
 assert.equal(firstFail.body.should_continue,false,'首次失败时 session 尚未等待交互，不应 resume');
 assert.equal(getSession(replayProbe.id).status,'created');
 updateSessionStatus(replayProbe.id,'waiting_interaction'); queue.settleTaskRun(replayProbe.id,'waiting_interaction');
 const replayFailed=await decision(replayCard.interaction);
 assert.equal(replayFailed.body.resolution_status,'failed');
 assert.equal(replayFailed.body.should_continue,false,'重放 failed 卡不得唤醒 session');
 assert.ok(!replayFailed.body.resume_job, '重放 failed 卡不得返回恢复任务');
 assert.equal(getSession(replayProbe.id).status,'waiting_interaction','重放后 session 必须保持等待交互状态');
 failInstall=false;
 // Legacy failed resource card is recovered by the queue without replaying the installer.
 const legacy=task('manual_confirm'); const legacyBefore=effects; const old=await invoke(legacy,...cases[0]); interactions.updateInteraction(old.interaction_id,{status:'failed',response:{error:'GIT_UNAVAILABLE',message:'仓库失败'}}); updateSessionStatus(legacy.id,'waiting_interaction'); queue.settleTaskRun(legacy.id,'waiting_interaction'); queue.recoverOrphanedTasks(); assert.equal(getSession(legacy.id).status,'queued_resume'); assert.equal(effects,legacyBefore);
 // Nonblocking card: another model/tool round executes before the task waits.
 const loopTask=task('manual_confirm'); plan=[{type:'tool_use',id:'install-card',name:cases[0][0],input:cases[0][1]},{type:'tool_use',id:'read-list',name:'list_skills',input:{}}]; const events=[]; const initialCalls=calls;
 const result=await require('../lib/agentLoop').runAgentLoop({sessionId:loopTask.id,approvalMode:'manual_confirm',llmConfig:{llmContextWindowTokens:60000},onStream:event=>events.push(event)});
 assert.equal(result.status,'waiting_interaction'); assert(calls-initialCalls>=3); assert(events.some(event=>event.non_blocking && event.interaction?.kind==='resource_approval')); assert(events.some(event=>event.tool_name==='list_skills'));
 // External MCP: server-declared readOnly hints are untrusted, so manual mode confirms every external call; auto mode is direct.
 for (const mode of ['manual_confirm','auto_confirm']) for (const readOnly of [true,false,undefined]) {
  const s=task(mode); getDb().prepare('UPDATE agent_sessions SET mcp_selection_json = ? WHERE id = ?').run(JSON.stringify({mode:'auto'}),s.id);
  const before=effects;
  const r=await tools.executeToolSafely({name:'mcp_test',input:{secret:'private-test-credential'}},getSession(s.id),undefined,{skipResultLimit:true,mcpToolMap:{mcp_test:{serverId:server.id,toolName:'example',readOnly}},toolDefinitions:[{name:'mcp_test',input_schema:{type:'object',properties:{secret:{type:'string'}}}}]});
  if(mode==='manual_confirm') { assert(r.approval_required); assert.equal(effects,before); assert(!JSON.stringify(r).includes('private-test-credential')); assert.equal((await decision(r.interaction)).body.resolution_status,'resolved'); }
  assert.equal(effects,before+1);
 }
 // Pending approvals cannot revive a cancelled task or apply its resource change.
 const cancelled=task('manual_confirm'); const card=await invoke(cancelled,...cases[0]); updateSessionStatus(cancelled.id,'cancelled'); const beforeCancel=effects; assert.equal((await decision(card.interaction)).statusCode,409); assert.equal(effects,beforeCancel);
 // A new message with pending manual Diff is rejected before cancelling the old task.
 const fileTask=task('manual_confirm');
 const preview=await tools.executeCreateNote({path:'pending.md',content:'# Pending'},fileTask.id);
 updateSessionStatus(fileTask.id,'waiting_operation_confirmation'); queue.settleTaskRun(fileTask.id,'waiting_operation_confirmation');
 const start=loadRoute('../pages/api/agent/loop/start.js');
 const response={statusCode:200,setHeader(){},getHeader(){},on(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
 await start({method:'POST',headers:{},body:{goal:'新的消息',conversation_id:fileTask.conversation_id}},response);
 assert.equal(response.statusCode,409); assert.equal(response.body.code,'MANUAL_DIFF_PENDING'); assert.equal(getSession(fileTask.id).status,'waiting_operation_confirmation'); assert(!require('../lib/files').getFileByPath('pending.md'));
 assert.equal(require('../lib/agentOperationGuards').findPendingManualOperation(fileTask.conversation_id).id,preview.operation_set_id);
 console.log('approval mode tests passed: 26 mode cases, 13 cancellation cases, 6 external MCP cases, deduplication, failure, legacy recovery, independent continuation, cancelled task and pending Diff guards');
 getDb().close(); fs.rmSync(root,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
