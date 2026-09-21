const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../components/AgentWorkspace/AgentWorkspace'), 'utf8');
const start = source.indexOf('  const handleResendMessage = useCallback(');
const end = source.indexOf('\n  return (', start);
const context = {
  useCallback: (fn) => fn, dedupeAgentMedia: (media) => media, isImageMedia: (m) => m.source_kind === 'image',
  activeSearchProvider: 'current-provider', activeWebSearchEnabled: true, mcpSelection: {mode:'auto'},
  selectedModelId: 'model', searchConfig: {enabled:true}, isSearchProviderReady: () => true,
  requireSearchConfig: () => {throw Error('unexpected config prompt');}, toast: (message) => {throw Error(message);},
  sourceMessages: [], onConversationRewritten: () => {},
  setRewrittenMessages: () => {}, setRemovingMessageIds: () => {}, setHiddenMessageIds: () => {},
  fetch: async () => ({ok:true,json:async()=>({})}),
};
let sent;
context.onSend = async (text, options) => { sent = {text,options}; };
vm.createContext(context);
vm.runInContext(source.slice(start,end)+'\nglobalThis.resend=handleResendMessage;',context);
(async()=>{
  for (const reason of ['retry','rewrite']) for (const enabled of [true,false]) {
    context.activeWebSearchEnabled = enabled;context.mcpSelection = {mode:enabled?'auto':'off'};
    const attachment={name:'keep.txt'};
    const original = {id:1,conversationId:1,content:'original',attachments:[attachment],meta:{web_search_enabled:!enabled,search_provider:'old-provider',mcp_selection:{mode:enabled?'off':'auto'}}};
    assert.equal(await context.resend(original,{reason,content:reason==='rewrite'?'new prompt':undefined}),true);
    assert.equal(sent.options.webSearchEnabled,enabled);
    assert.equal(sent.options.searchProvider,enabled?'current-provider':null);
    assert.equal(sent.options.mcpSelection.mode,enabled?'auto':'off');
    assert.equal(sent.options.attachments[0],attachment);
    assert.equal(sent.text,reason==='rewrite'?'new prompt':'original');
  }
  console.log('retry/rewrite current preference behavior tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
