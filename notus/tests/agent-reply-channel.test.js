const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require.resolve('../hooks/useAgentLoopController.js'), 'utf8');
const start = source.indexOf('export function buildRestoredAgentTimeline');
const end = source.indexOf('const FILE_MUTATION_TOOL_NAMES', start);
const context = { buildEventStep: () => null, upsertStep: (steps) => steps, completeSteps: (steps) => steps, finishRunningStep: (step) => step };
vm.createContext(context);
vm.runInContext(source.slice(start, end).replaceAll('export function', 'function'), context);
const { applyAgentTimelineEvent: apply, buildRestoredAgentTimeline: restore } = context;
const event = (payload) => ({ payload });
const draft = { type: 'assistant_text_replace', text: 'Draft answer' };
for (const status of ['completed', 'failed', 'cancelled', 'rolled_back']) {
  assert.strictEqual(restore({ status, run_events: [event(draft)] }).draft, '');
}
assert.strictEqual(restore({ status: 'waiting_model_recovery', run_events: [event(draft)] }).draft, 'Draft answer');
assert.strictEqual(restore({ status: 'waiting_model_recovery', run_events: [event(draft), event({type:'final',text:'Answer'})] }).draft, '');
assert.strictEqual(restore({ status: 'running', run_events: [event(draft), event({...draft,text:''})] }).draft, '');
assert.strictEqual(restore({ status: 'running', run_events: [event({type:'progress',stage:'thinking',text:'Private'})] }).draft, '');
let state = apply({}, {type:'progress',stage:'model_progress',text:'Execution prelude'});
assert.strictEqual(state.streamText, '');
state = apply(state, {type:'thinking',text:'Private'});
assert.strictEqual(state.streamText, '');
state = apply(state, draft);
assert.strictEqual(state.streamText, 'Draft answer');
state = apply(state, {type:'assistant_text_delta',text:' addition'});
assert.strictEqual(state.streamText, 'Draft answer addition');
assert.strictEqual(restore({status:'waiting_model_recovery',run_events:[event(draft),event({type:'assistant_text_delta',text:' addition'})]}).draft, 'Draft answer addition');
state = apply(state, {type:'final',text:'Answer'});
assert.strictEqual(state.streamText, '');
assert.ok(!source.includes('streamTextBeforeEvent'), 'Final fallbacks must not promote progress/drafts');
const { buildAgentSubscriptionSnapshot: seed } = context;
const persisted = [
  {id:10,payload:draft},
  {id:11,payload:{type:'assistant_text_delta',text:' middle'}},
  {id:12,payload:{type:'assistant_text_delta',text:' end'}},
];
const seeded = seed({run_events:persisted},11);
assert.strictEqual(seeded.cursor,11);
assert.strictEqual(seeded.draft,'Draft answer middle');
assert.strictEqual(apply({streamText:seeded.draft},persisted[2].payload).streamText,'Draft answer middle end');
assert.strictEqual(seed({run_events:[...persisted,{id:13,payload:{type:'final',text:'Final'}}]},13).cursor,12);
const stepContext = { finishRunningStep: (step) => ({...step,status:'done'}) };
vm.createContext(stepContext);
vm.runInContext(source.slice(source.indexOf('function completeSteps'),source.indexOf('function toolLabel')), stepContext);
const errorStep = {kind:'llm_error',status:'error',action:'resume_agent'};
assert.strictEqual(stepContext.completeSteps([errorStep],{resolveModelErrors:true}).length,0);
assert.strictEqual(stepContext.completeSteps([errorStep]).length,1);
const { redactStreamingText } = require('../lib/agentToolPolicy');
const { sanitizeRunEvent } = require('../lib/agentSession');
for (const secret of ['Ab12'.repeat(12), 'sk-' + 'Cd34'.repeat(7)]) {
  let raw = 'Result: ';
  let published = '';
  let persisted = '';
  for (const chunk of [secret.slice(0, 12), secret.slice(12, 28), secret.slice(28), ' done.']) {
    raw += chunk;
    const safe = redactStreamingText(raw);
    assert.ok(safe.startsWith(published));
    persisted += sanitizeRunEvent({type:'assistant_text_delta',text:safe.slice(published.length)}).text;
    published = safe;
    assert.ok(!persisted.includes(secret.slice(0, 12)), 'Partial credential cannot be published');
  }
  assert.ok(persisted.includes('[REDACTED]'));
  assert.strictEqual(redactStreamingText(secret, {complete:true}), '[REDACTED]');
}
assert.strictEqual(redactStreamingText('Hello wor'), 'Hello ');
assert.strictEqual(redactStreamingText('Hello world', {complete:true}), 'Hello world');
console.log('agent reply channel tests passed');
