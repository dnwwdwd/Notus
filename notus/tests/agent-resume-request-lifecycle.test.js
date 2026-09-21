const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const workspace = fs.readFileSync(require.resolve('../components/AgentWorkspace/FileAgentWorkspace'), 'utf8');
const controllerSource = fs.readFileSync(require.resolve('../hooks/useAgentLoopController'), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise,resolve,reject}; };
async function main() {
  const calls = []; const warnings = [];
  const context = {
    useCallback: fn => fn, resumeAgentTaskInFlightRef: {current:new Map()},
    agentLoop: {getAgentSession: id => ({id,conversation_id:7,control_tickets:{resume:'resume',read:'read'}}), startAgentLoop: (input,options) => {const request=deferred();calls.push({input,options,...request});return request.promise;}},
    restoredAgentSessions: [], selectedLlmConfigId:'model', toast: message => warnings.push(message),
  };
  vm.createContext(context);
  vm.runInContext(workspace.slice(workspace.indexOf('  const resumeFailedAgentTask ='),workspace.indexOf('  const handleConversationRewritten ='))+'\nglobalThis.resume=resumeFailedAgentTask;',context);
  const first=context.resume(1);
  await context.resume(1);
  assert.equal(calls.length,1,'受理前同任务去重');
  const other=context.resume(2);
  assert.equal(calls.length,2,'其他任务不被全局锁阻止');
  calls[0].options.onAccepted();
  const next=context.resume(1);
  assert.equal(calls.length,3,'旧 SSE 未结束也可再次继续');
  calls[0].resolve(); await first;
  await context.resume(1);
  assert.equal(calls.length,3,'旧请求 finally 不能清除新请求锁');
  calls[2].reject(new Error('继续请求失败')); await next;
  assert.deepEqual(warnings,['继续请求失败']);
  const retry=context.resume(1); calls[3].resolve(); await retry;
  calls[1].resolve(); await other;

  const streams=[]; const requests=[]; const accepted=[];
  const hookContext={
    useCallback:fn=>fn,useEffect:()=>{},useRef:current=>({current}),
    useState:initial=>{let value=typeof initial==='function'?initial():initial;return [value,next=>{value=typeof next==='function'?next(value):next;}];},
    refreshAgentSessionAccess:async()=>({control_tickets:{read:'read',resume:'resume'}}),
    getAgentToolLabel:v=>v,getAgentToolDisplayName:v=>v,getAgentLoopReasonLabel:v=>v,dispatchAgentResourceChange:()=>{},
    AbortController,TextDecoder,TextEncoder,console,window:{},setTimeout,clearTimeout,
    fetch:async(url,options={})=>{
      requests.push(url);
      if(url==='/api/agent/loop/start') return {ok:true,json:async()=>({session_id:JSON.parse(options.body).session_id,conversation_id:7,status:'queued',event_cursor:0})};
      if(url.includes('/events?')) {
        let emitted=false;
        return {ok:true,body:{getReader:()=>({read:async()=>{
          if(!emitted){emitted=true;streams.push(options.signal);return {done:false,value:new TextEncoder().encode('data: '+JSON.stringify({type:'artifact',artifact_type:'limit_confirmation',reason:'hard_limit_reached'})+'\n\n')};}
          if(options.signal.aborted) throw new DOMException('Aborted','AbortError');
          return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
        }})}};
      }
      throw Error('Unexpected request '+url);
    },
  };
  vm.createContext(hookContext);
  vm.runInContext(controllerSource.replace(/^import .*;\n/gm,'').replaceAll('export function','function')+'\nglobalThis.hook=useAgentLoopController;',hookContext);
  const hook=hookContext.hook();
  const timeout=setTimeout(()=>{console.error('SSE 暂停未结算');process.exit(1);},2000);
  await hook.startAgentLoop({session_id:1,conversation_id:7},{resume:true,onAccepted:()=>accepted.push(1)});
  assert.equal(accepted.length,1);
  assert.equal(streams.length,1);
  assert.equal(streams[0].aborted,true,'限额暂停断开订阅，避免继续 Promise 悬挂');
  await Promise.all([2,3].map(session_id=>hook.startAgentLoop({session_id,conversation_id:7},{resume:true})));
  clearTimeout(timeout);
  assert.equal(streams.length,3);
  assert.ok(streams.every(signal=>signal.aborted),'前台和后台限额订阅均结算');
  assert.ok(!requests.some(url=>url.includes('/cancel')),'解除订阅不能取消后台任务');
  console.log('agent resume request lifecycle tests passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
