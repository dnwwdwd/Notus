const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../hooks/useAgentLoopController.js'), 'utf8');
const start = source.indexOf('    const publishTimeline =');
const end = source.indexOf('    const notifyTaskAccepted =', start);
assert(start >= 0 && end > start);
function publishFixture(isResume) {
  const context = vm.createContext({
    isResume,
    timeline: { sessionId: 'test', loading: true, startedAt: '2026-09-21T01:00:00Z' },
    onSessionTimeline: () => {},
    applyAgentTimelineEvent: (previous, event) => ({ ...previous, loading: event.running, finishedAt: '2099-01-01T00:00:00Z' }),
  });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.publish = publishTimeline;`, context);
  return context;
}
const live = publishFixture(false);
const finished = live.publish({ running: false });
assert(Date.now() - new Date(finished.finishedAt).getTime() < 1000, '实时结束不能混用超前的服务端时间');
assert.equal(finished.startedAt, '2026-09-21T01:00:00Z');
assert.equal(live.publish({ running: false }).finishedAt, finished.finishedAt, '重复终态不得推进计时');
assert.equal(publishFixture(true).publish({ running: false }).finishedAt, '2099-01-01T00:00:00Z', '续跑保留服务端时间体系');
const status = fs.readFileSync(path.join(__dirname, '../components/AgentWorkspace/TraceStatus.js'), 'utf8');
const label = vm.runInNewContext(`(${status.slice(status.indexOf('function elapsedLabel'), status.indexOf('export const TraceStatus')).trim()})`);
assert.equal(label(0, true), '');
assert.equal(label(999, true), '');
assert.equal(label(1000, true), '1 秒');
assert.equal(label(2000, true), '2 秒');
assert.equal(label(61000, true), '1 分 1 秒');
assert.equal(label(200, false), '1 秒');
console.log('agent live clock tests passed');
