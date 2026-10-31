import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { activitySummary, confirmationFingerprint, hasNewActivities, approveActivities, activityDetail, CloseHandshake } = require('../desktop/support.cjs');
const origin = 'http://127.0.0.1:51234';
const job = (id, kind = 'command', count = 1) => ({ id, pluginId: 'feature-' + kind, kind, count });
const summary = activities => activitySummary({ activities });

async function harness({ state = { sessions: [], activities: [] }, dirty = false, dirtyRevision, rendererRunning = false, answer = () => 1, onFlush, onSave, onClose, onDispose } = {}) {
  const steps = [], dialogs = [], messages = [], ended = [], handlers = new Map(); let stateCalls = 0;
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, getPath: () => tmpdir(), setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), getVersion: () => 'test', setAboutPanelOptions() {}, quit: () => steps.push('quit'), exit: () => steps.push('exit') });
  const electron = { app, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, dialog: { async showMessageBox(...args) { const options = args.at(-1); dialogs.push(options); steps.push('confirm'); return { response: await answer(options, dialogs.length) }; } }, Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, screen: {}, BrowserWindow: class {}, shell: {} };
  const scopedRequire = createRequire(new URL('../desktop/main.cjs', import.meta.url));
  const source = await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'), module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports={installIpc,requestTransition,inject:value=>{mainWindow=value.win;origin=value.origin;host=value.host;store=value.store;closeReady=true;closeState=value.closeState;locale="en";},state:()=>({...closeState})};', { require: id => id === 'electron' ? electron : scopedRequire(id), module, __dirname: fileURLToPath(new URL('../desktop/', import.meta.url)), process, setTimeout, clearTimeout, setImmediate, URL, console });
  const frame = { url: origin + '/' };
  const win = { isDestroyed: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 1512, height: 886 }), isMaximized: () => false, isFullScreen: () => false, reload: () => steps.push('reload'), webContents: { mainFrame: frame, send(channel, payload) {
    if (channel === 'dsh:transition-ended') { ended.push(payload); return; }
    if (channel !== 'dsh:before-close') return; messages.push({ ...payload });
    setImmediate(async () => { steps.push('flush'); const allow = await onFlush?.(payload, messages.length); handlers.get('dsh:close-complete')({ sender: win.webContents, senderFrame: frame }, { requestId: payload.requestId, allow: allow !== false }); });
  } } };
  module.exports.inject({ win, origin, closeState: { dirty, running: rendererRunning, ...(dirtyRevision !== undefined ? { dirtyRevision } : {}) }, host: { state() { stateCalls++; return typeof state === 'function' ? state() : state; }, close() { steps.push('host-close'); return onClose?.(); }, engine: { async dispose() { steps.push('engine-dispose'); return onDispose?.(); } } }, store: { async save() { steps.push('save-window'); await onSave?.(); }, async flush() { steps.push('flush-window'); } } });
  module.exports.installIpc(); return { steps, dialogs, messages, ended, transition: module.exports.requestTransition, closeState: module.exports.state, stateCalls: () => stateCalls, setCloseState: value => handlers.get('dsh:close-state')({ sender: win.webContents, senderFrame: frame }, value) };
}

test('summary counts every model session and trusted background kind without exposing titles or prompts', () => {
  const state = { sessions: [{ id: 'selected', running: false }, { id: 'other-chat', running: true }, { id: 'other-chat', running: true }], activities: [job('pty-uuid', 'terminal'), job('child-pid', 'command', 1234), { ...job('run-id', 'automation'), title: 'private prompt must not appear' }, job('provider-unverified', 'unknown')] };
  const value = activitySummary(state, { rendererRunning: true });
  assert.deepEqual([value.model, value.terminal, value.command, value.automation, value.unknown], [1, 1, 1234, 1, 1]);
  assert.equal(activityDetail(value, 'en').includes('1,234'), true); assert.equal(activityDetail(value, 'zh-CN').includes('后台命令'), true);
  assert.equal(activityDetail(value, 'en').includes('private prompt'), false);
  assert.equal(activitySummary({ sessions: [] }, { rendererRunning: true }).model, 1);
  assert.equal(activitySummary({ activities: [{ kind: 'command', count: -1 }] }).unknown, 1);
  assert.equal(activitySummary({ activities: {} }).unknown, 1);
});

test('approvals follow task identity and count: reordering and completed work do not trigger repeated consent', () => {
  const approved = new Map(), first = summary([job('one'), job('two', 'terminal')]);
  assert.equal(hasNewActivities(first, approved), true); approveActivities(first, approved);
  assert.equal(confirmationFingerprint(first), confirmationFingerprint(summary([job('two', 'terminal'), job('one')])));
  assert.equal(hasNewActivities(summary([job('one')]), approved), false);
  assert.equal(hasNewActivities(summary([job('replacement')]), approved), true);
  assert.equal(hasNewActivities(summary([job('one', 'command', 2)]), approved), true);
  approveActivities(summary([job('one', 'command', 2)]), approved); assert.equal(hasNewActivities(summary([job('one')]), approved), false);
});

test('recovery activity covers managed retry waits and service restarts with stable identities', () => {
  const state={sessions:[
    {id:'retry',runRecovery:{id:'run-one',status:'waiting',managed:true,userStopped:false}},
    {id:'stopped',runRecovery:{status:'waiting',managed:true,userStopped:true}},
    {id:'unmanaged',runRecovery:{status:'waiting',managed:false}},
    {id:'uncertain',runRecovery:{status:'uncertain',managed:true}},
    {id:'running',running:true,activeTurnId:'turn',runRecovery:{status:'waiting',managed:true}}
  ],engine:{id:'codex',recovery:{status:'waiting',attempt:1}}};
  const first=activitySummary(state),approved=new Map();approveActivities(first,approved);
  assert.equal(first.model,1);assert.equal(first.recovery,2);assert.equal(first.total,3);
  assert.match(activityDetail(first,'en'),/Tasks and services awaiting recovery: 2/);
  assert.match(activityDetail(first,'zh-CN'),/等待恢复的任务或服务：2/);
  state.engine.recovery={status:'restarting',attempt:2};state.sessions[0].runRecovery.nextRetryAt='later';
  assert.equal(hasNewActivities(activitySummary(state),approved),false);
  state.sessions[0].runRecovery.id='run-two';assert.equal(hasNewActivities(activitySummary(state),approved),true);
  state.sessions[0].runRecovery.userStopped=true;state.engine.recovery.status='idle';
  assert.equal(activitySummary(state).recovery,0);
});

test('quit during backoff confirms recovery and cancellation keeps the host alive', async () => {
  const value=await harness({state:{sessions:[{id:'retry',running:false,runRecovery:{id:'run',status:'waiting',managed:true,userStopped:false}}],engine:{id:'codex',recovery:{status:'restarting'}}},answer:()=>0});
  assert.equal(await value.transition('quit'),false);assert.equal(value.dialogs.length,1);
  assert.match(value.dialogs[0].detail,/Tasks and services awaiting recovery: 2/);
  assert.deepEqual(value.steps,['confirm']);assert.equal(value.messages.length,0);
});

test('a queued turn in the same chat needs fresh consent while stable turns and legacy chat identities do not repeat', () => {
  const approved = new Map();
  const first = activitySummary({ sessions: [{ id: 'chat-one', running: true, activeTurnId: 'turn-one' }, { id: 'chat-two', running: true, activeTurnId: 'other-turn' }] });
  approveActivities(first, approved);
  const unchanged = activitySummary({ sessions: [{ id: 'chat-one', running: true, activeTurnId: 'turn-one' }] });
  assert.equal(hasNewActivities(unchanged, approved), false);
  const nextTurn = activitySummary({ sessions: [{ id: 'chat-one', running: true, activeTurnId: 'turn-two' }] });
  assert.equal(nextTurn.model, unchanged.model); assert.equal(hasNewActivities(nextTurn, approved), true);
  const legacy = activitySummary({ sessions: [{ id: 'legacy-chat', running: true }] }); approveActivities(legacy, approved);
  assert.equal(hasNewActivities(activitySummary({ sessions: [{ id: 'legacy-chat', running: true, activeTurnId: null }] }), approved), false);
  assert.equal(hasNewActivities(activitySummary({ sessions: [{ id: 'legacy-chat', running: true, activeTurnId: ' ' }] }), approved), false);
});

test('quit confirms non-current model chats plus terminals, commands, automation and unverified work', async () => {
  const value = await harness({ state: { sessions: [{ id: 'non-current', running: true }], activities: [job('pty', 'terminal'), job('pid'), job('run', 'automation'), job('fault', 'unknown')] } });
  assert.equal(await value.transition('quit'), true); assert.equal(value.dialogs.length, 1);
  for (const name of ['Model chats: 1', 'Terminals: 1', 'Background commands: 1', 'Automation runs: 1', 'Unverified background tasks: 1']) assert.ok(value.dialogs[0].detail.includes(name), name);
  assert.deepEqual(value.steps, ['confirm', 'flush', 'save-window', 'flush-window', 'host-close', 'quit']);
  assert.equal(value.messages[0].discardDocument, false);
});

test('cancel of a mixed dirty/background confirmation does not flush, close or kill resources', async () => {
  const value = await harness({ dirty: true, state: { activities: [job('pty', 'terminal')] }, answer: () => 0 });
  assert.equal(await value.transition('quit'), false); assert.deepEqual(value.steps, ['confirm']); assert.equal(value.messages.length, 0);
  assert.match(value.dialogs[0].detail, /document/); assert.match(value.dialogs[0].detail, /Terminals: 1/);
});

test('new work during the first dialog requires a second approval and cancellation preserves the host', async () => {
  const state = { activities: [job('old')] };
  const value = await harness({ state, answer: (_options, count) => { if (count === 1) { state.activities.push(job('new', 'terminal')); return 1; } return 0; } });
  assert.equal(await value.transition('quit'), false); assert.equal(value.dialogs.length, 2);
  assert.equal(value.steps.includes('host-close'), false); assert.equal(value.steps.includes('engine-dispose'), false); assert.equal(value.steps.includes('quit'), false);
});

test('work created during renderer persistence is confirmed before a single host shutdown', async () => {
  const state = { activities: [job('old')] };
  const value = await harness({ state, onFlush: () => state.activities.push(job('new-run', 'automation')) });
  assert.equal(await value.transition('quit'), true); assert.equal(value.dialogs.length, 2); assert.match(value.dialogs[1].detail, /Automation runs: 1/);
  assert.equal(value.steps.filter(step => step === 'host-close').length, 1);
  assert.ok(value.steps.lastIndexOf('confirm') < value.steps.indexOf('host-close'));
});

test('a task finishing during confirmation and unchanged activity signatures do not cause duplicate dialogs', async () => {
  const state = { activities: [job('finishes'), job('remains', 'terminal')] };
  const value = await harness({ state, answer: () => { state.activities.shift(); return 1; } });
  assert.equal(await value.transition('quit'), true); assert.equal(value.dialogs.length, 1);
  assert.equal(value.steps.filter(step => step === 'host-close').length, 1);
});

test('reload only confirms dirty documents and keeps all host work alive', async () => {
  const state = { sessions: [{ id: 'other', running: true }], activities: [job('pty', 'terminal'), job('run', 'automation'), job('command')] };
  const clean = await harness({ state, rendererRunning: true });
  assert.equal(await clean.transition('reload'), true); assert.equal(clean.dialogs.length, 0); assert.equal(clean.stateCalls(), 0); assert.equal(clean.closeState().running, true);
  assert.deepEqual(clean.steps, ['flush', 'save-window', 'flush-window', 'reload']);
  const dirty = await harness({ state, dirty: true });
  assert.equal(await dirty.transition('reload'), true); assert.equal(dirty.dialogs.length, 1); assert.match(dirty.dialogs[0].detail, /continue running/); assert.doesNotMatch(dirty.dialogs[0].detail, /will stop/);
  assert.equal(dirty.messages[0].discardDocument, true); assert.equal(dirty.steps.includes('host-close'), false);
});

test('force quit cannot silently approve work created during the shutdown-failure dialog', async () => {
  const state = { activities: [job('old')] };
  const value = await harness({ state, onClose: () => { throw new Error('cleanup failed'); }, answer: (options, count) => {
    if (options.message.includes('shutting down')) { state.activities.push(job('new', 'automation')); return 1; }
    return count === 1 ? 1 : 0;
  } });
  assert.equal(await value.transition('quit'), false); assert.equal(value.dialogs.length, 3);
  assert.match(value.dialogs.at(-1).detail, /Automation runs: 1/); assert.equal(value.steps.includes('exit'), false); assert.equal(value.steps.includes('engine-dispose'), false);
});

test('force exit rechecks after asynchronous engine disposal rather than reusing its prior consent', async () => {
  const state = { activities: [job('old')] };
  const value = await harness({ state, onClose: () => { throw new Error('cleanup failed'); }, onDispose: () => state.activities.push(job('new-after-dispose', 'terminal')), answer: (options, count) => options.message.includes('shutting down') || count === 1 ? 1 : 0 });
  assert.equal(await value.transition('quit'), false); assert.equal(value.steps.includes('engine-dispose'), true); assert.equal(value.steps.includes('exit'), false); assert.match(value.dialogs.at(-1).detail, /Terminals: 1/);
});

test('a failed activity snapshot asks about unverified work instead of exiting without confirmation', async () => {
  const value = await harness({ state: () => { throw new Error('provider failed'); }, answer: () => 0 });
  assert.equal(await value.transition('quit'), false); assert.match(value.dialogs[0].detail, /Unverified background tasks: 1/); assert.deepEqual(value.steps, ['confirm']);
});

test('renderer discard permission comes from the approved request rather than a later dirty boolean', async () => {
  const messages = [], handshake = new CloseHandshake({ send: message => messages.push(message), timeoutMs: 1000 });
  const first = handshake.request('reload', { discardDocument: false }); handshake.finish({ requestId: messages[0].requestId, allow: true }); await first; assert.equal(messages[0].discardDocument, false);
  const second = handshake.request('quit', { discardDocument: true }); handshake.finish({ requestId: messages[1].requestId, allow: true }); await second; assert.equal(messages[1].discardDocument, true);
});

test('an edit during the first dirty confirmation needs approval for its own revision before any discard handshake', async () => {
  let value;
  value = await harness({ dirty: true, dirtyRevision: 1, answer: (_options, count) => { if (count === 1) value.setCloseState({ dirty: true, running: false, dirtyRevision: 2 }); return 1; } });
  assert.equal(await value.transition('quit'), true); assert.equal(value.dialogs.length, 2); assert.equal(value.messages.length, 1);
  assert.equal(value.messages[0].expectedDirtyRevision, 2); assert.equal(value.messages[0].discardDocument, true); assert.equal(value.ended.length, 1);
});

test('new edits during flush invalidate the previous approval and require a new renderer handshake', async () => {
  let value;
  value = await harness({ dirty: true, dirtyRevision: 7, onFlush: (_payload, count) => { if (count === 1) { value.setCloseState({ dirty: true, running: false, dirtyRevision: 8 }); return false; } } });
  assert.equal(await value.transition('quit'), true); assert.equal(value.dialogs.length, 2);
  assert.deepEqual(value.messages.map(message => message.expectedDirtyRevision), [7, 8]); assert.ok(value.messages.every(message => message.discardDocument));
  assert.equal(value.steps.filter(step => step === 'host-close').length, 1); assert.ok(value.steps.lastIndexOf('flush') < value.steps.indexOf('host-close'));
});

test('an edit after flush reopens dirty consent; cancelling restores the renderer without closing the host', async () => {
  let value;
  value = await harness({ dirty: true, dirtyRevision: 3, onSave: () => value.setCloseState({ dirty: true, running: false, dirtyRevision: 4 }), answer: (_options, count) => count === 1 ? 1 : 0 });
  assert.equal(await value.transition('quit'), false); assert.equal(value.dialogs.length, 2); assert.equal(value.steps.includes('host-close'), false); assert.equal(value.steps.includes('engine-dispose'), false);
  assert.equal(value.messages[0].expectedDirtyRevision, 3); assert.equal(value.ended.length, 1);
});

test('close-state revisions reject malformed values while legacy boolean clients still flush', async () => {
  const value = await harness();
  for (const dirtyRevision of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) assert.throws(() => value.setCloseState({ dirty: true, running: false, dirtyRevision }), /DESKTOP_INVALID_CLOSE_STATE/);
  value.setCloseState({ dirty: true, running: false }); assert.equal(await value.transition('reload'), true); assert.equal(value.messages[0].expectedDirtyRevision, undefined); assert.equal(value.ended.length, 1);
});
