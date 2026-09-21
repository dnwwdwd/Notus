const assert = require('assert');
const { compactMessages } = require('../lib/agentMessageProjection');
const { completeToolChat } = require('../lib/llm');
const { resolveLlmBudget, estimateChatRequestTokens } = require('../lib/llmBudget');
const messages = [{ role:'user', content:'保留目标：比较已读材料。' }];
for(let i=0;i<24;i++) messages.push(
  {role:'assistant',content:[{type:'tool_use',id:`read-${i}`,name:'read_tool_result',input:{result_ref:`tool-result://${i}`}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:`read-${i}`,content:JSON.stringify({content:('材料'+i+'。').repeat(180),result_ref:`tool-result://${i}`})}]}
);
const before = JSON.stringify(messages);
const tools = [{name:'read_tool_result',description:'读取工具结果。'.repeat(100),input_schema:{type:'object',properties:{result_ref:{type:'string'}}}}];
const originalFetch = global.fetch;
let sent=0, overflow=false;
global.fetch=async()=>{
  sent++;
  if(overflow){overflow=false;return{ok:false,status:400,text:async()=>JSON.stringify({error:{message:'maximum context length exceeded'}})};}
  return{ok:true,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}],content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:2,prompt_tokens:100,completion_tokens:2}})};
};
(async()=>{
  for(const protocol of ['openai','anthropic']) {
    for(const size of [60000,6000]) {
      const config={llmApiKey:'local-test',llmBaseUrl:'https://example.invalid/v1',llmModel:'budget-test',llmApiProtocol:protocol,llmContextWindowTokens:size,llmMaxOutputTokens:1000};
      const modes=[];
      const budget=resolveLlmBudget(config,'agent_loop');
      const result=await completeToolChat({system:'系统规则。'.repeat(100),messages,tools,llmConfig:config,
        compact:({messages:input,budget:b,mode})=>{modes.push(mode);return{messages:compactMessages(input,Math.floor(b.hardInputBudgetTokens*(mode==='hard'?0.6:0.75)))};}
      });
      assert(result.content.length);
      if(size===60000)assert.equal(modes.length,0,'大模型预算充足时保留材料');
      else assert(modes.length,'换小模型必须触发实际压缩');
      assert.equal(JSON.stringify(messages),before,'请求投影不能修改恢复历史');
      const callsBefore=sent;
      await assert.rejects(completeToolChat({system:'不可压缩系统正文。'.repeat(12000),messages,tools,llmConfig:config,
        compact:()=>({messages:[messages[0]]})}),error=>error.code==='CONTEXT_BUDGET_EXCEEDED');
      assert.equal(sent,callsBefore,'连系统正文都超预算时禁止发送，不得绕过硬预算');
      assert(budget.hardInputBudgetTokens<size-999,'输出与安全余量仍预留');
    }
    overflow=true;
    const modes=[];
    const config={llmApiKey:'local-test',llmBaseUrl:'https://example.invalid/v1',llmModel:'budget-test',llmApiProtocol:protocol,llmContextWindowTokens:6000,llmMaxOutputTokens:1000};
    const start=sent;
    await completeToolChat({messages,tools,llmConfig:config,compact:({messages:input,budget:b,mode})=>{modes.push(mode);return{messages:compactMessages(input,Math.floor(b.hardInputBudgetTokens*(mode==='hard'?0.6:0.75)))};},maxRetries:1});
    assert.equal(sent-start,2);assert(modes.includes('hard'),'上游超限时强制压缩一次');
  }
  const large=structuredClone(messages);
  large[2].content[0].content=JSON.stringify({content:'长材料。'.repeat(4000)});
  const {evictOldReadWindows}=require('../lib/agentMessageProjection');
  const originalCost=estimateChatRequestTokens({messages:large});
  const reduced=evictOldReadWindows(large,originalCost-1000);
  assert.equal(reduced.flatMap(m=>m.content||[]).filter(b=>b.type==='tool_result'&&b.content.includes('read_window_evicted')).length,1,'满足预算即停止逐项回收');
  console.log('retention budget boundaries passed: both protocols, large→small model, system/schema overhead, unsendable request rejection, provider overflow, immutable checkpoints, stop eviction at budget');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=originalFetch;});
