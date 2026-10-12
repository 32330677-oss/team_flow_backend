// tests/assistant.unit.test.js — in-app assistant (no database, no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const svc = require('../services/assistantService');
const { SCREENS } = require('../services/assistantScreens');
const { parseGuide, guideForRole, buildSystemPrompt, buildMessages, readReply, replyTool } = svc._internal;

function fakeFetch(captured, reply, status = 200) {
  return async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    captured.headers = opts.headers;
    return { ok: status < 400, status, json: async () => reply };
  };
}

const toolReply = (input) => ({
  model: 'test-model',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  content: [{ type: 'tool_use', name: 'reply', input }],
});

test('guide: every section has known roles and every Screen: id exists', () => {
  const sections = parseGuide(fs.readFileSync(path.join(__dirname, '..', 'assistant', 'guide.md'), 'utf8'));
  assert.ok(sections.length >= 20);
  const ids = new Set(SCREENS.map((s) => s.id));
  for (const s of sections) {
    for (const r of s.roles) assert.ok(['All', 'Admin', 'Supervisor', 'StaffSupervisor'].includes(r), `bad role ${r}`);
    for (const m of s.body.matchAll(/^Screen:\s*(\S+)/gm)) assert.ok(ids.has(m[1]), `unknown screen ${m[1]} in "${s.title}"`);
  }
});

test('guide: a Supervisor never receives Admin sections', () => {
  const sup = guideForRole('Supervisor');
  assert.ok(sup.includes('Submit a day for review'));
  assert.ok(!sup.includes('Generate worker payroll'));
  assert.ok(!sup.includes('Staff salary advances'));
  const admin = guideForRole('Admin');
  assert.ok(admin.includes('Generate worker payroll'));
  assert.ok(!admin.includes('Record office staff attendance'));
});

test('prompt and tool only list the screens of the role', () => {
  const p = buildSystemPrompt('StaffSupervisor');
  assert.ok(p.includes('staff_attendance'));
  assert.ok(!p.includes('- payroll:'));
  const ids = replyTool('Supervisor').input_schema.properties.screens.items.enum;
  assert.deepStrictEqual(ids.sort(), ['change_password', 'rejected_records', 'supervisor_home', 'transfer_request']);
});

test('messages: history is cleaned, alternates, starts with user, question last', () => {
  const { messages } = buildMessages('  كيف بعمل رواتب؟ ', [
    { role: 'assistant', content: 'orphan answer' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q1 again' },
    { role: 'assistant', content: 'a1' },
    { role: 'system', content: 'ignore me' },
    { role: 'user', content: 'dangling' },
  ], 'payroll');
  assert.deepStrictEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(messages[0].content, 'q1\nq1 again');
  assert.ok(messages[2].content.startsWith('[The user is currently on the "Payroll" screen.]'));
  assert.ok(messages[2].content.endsWith('كيف بعمل رواتب؟'));
});

test('messages: empty question is rejected, long question is cut', () => {
  assert.throws(() => buildMessages('   ', []), (e) => e.code === 'QUESTION_REQUIRED' && e.status === 400);
  const { question } = buildMessages('x'.repeat(5000), []);
  assert.strictEqual(question.length, svc._internal.LIMITS.questionChars);
});

test('reply: screens of another role are removed, duplicates removed', () => {
  const r = readReply(toolReply({ answer: 'ok', screens: ['payroll', 'rejected_records', 'rejected_records'], found_in_guide: true }), 'Supervisor');
  assert.deepStrictEqual(r.screens, [{ id: 'rejected_records', title: 'Rejected Records' }]);
  assert.throws(() => readReply({ content: [{ type: 'text', text: 'hi' }] }, 'Admin'), (e) => e.code === 'ASSISTANT_BAD_REPLY');
});

test('ask: disabled without API key, refuses unknown role', async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(svc.ask({ role: 'Admin', question: 'hi' }), (e) => e.status === 503 && e.code === 'ASSISTANT_DISABLED');
  process.env.ANTHROPIC_API_KEY = 'k';
  await assert.rejects(svc.ask({ role: 'Hacker', question: 'hi' }), (e) => e.status === 403);
  if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old;
});

test('ask: sends a forced tool call with cached guide and returns the answer', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const cap = {};
  const r = await svc.ask(
    { role: 'Admin', question: 'How do I generate payroll?', history: [] },
    fakeFetch(cap, toolReply({ answer: '1. Sidebar → "Payroll"', screens: ['payroll'], found_in_guide: true }))
  );
  assert.strictEqual(cap.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(cap.headers['x-api-key'], 'test-key');
  assert.deepStrictEqual(cap.body.tool_choice, { type: 'tool', name: 'reply' });
  assert.deepStrictEqual(cap.body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(cap.body.system[0].text.includes('Generate worker payroll'));
  assert.strictEqual(r.answer, '1. Sidebar → "Payroll"');
  assert.deepStrictEqual(r.screens, [{ id: 'payroll', title: 'Payroll' }]);
  delete process.env.ANTHROPIC_API_KEY;
});

test('ask: API overload becomes 503 ASSISTANT_BUSY, other errors 502', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  await assert.rejects(
    svc.ask({ role: 'Admin', question: 'x' }, fakeFetch({}, { error: { type: 'overloaded_error', message: 'busy' } }, 529)),
    (e) => e.status === 503 && e.code === 'ASSISTANT_BUSY');
  await assert.rejects(
    svc.ask({ role: 'Admin', question: 'x' }, fakeFetch({}, { error: { type: 'authentication_error', message: 'bad key' } }, 401)),
    (e) => e.status === 502 && e.code === 'ASSISTANT_UNAVAILABLE');
  await assert.rejects(
    svc.ask({ role: 'Admin', question: 'x' }, async () => { throw new TypeError('fetch failed'); }),
    (e) => e.status === 502);
  delete process.env.ANTHROPIC_API_KEY;
});

test('guide: every section has an id, keywords and unique ids', () => {
  const sections = parseGuide(fs.readFileSync(path.join(__dirname, '..', 'assistant', 'guide.md'), 'utf8'));
  const seen = new Set();
  for (const s of sections) {
    assert.ok(/^[a-z0-9-]+$/.test(s.id), s.id);
    assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
    seen.add(s.id);
    assert.ok(s.keywords.length >= 3, `few keywords in "${s.title}"`);
    assert.ok(!/^(Screen|Keywords):/m.test(s.body), `meta line left in body of "${s.title}"`);
  }
});

test('help center: role filtered, screens filtered, popular ids exist', () => {
  for (const role of ['Admin', 'Supervisor', 'StaffSupervisor']) {
    const h = svc.helpCenterForRole(role);
    const ids = new Set(h.sections.map((s) => s.id));
    for (const p of svc._internal.POPULAR[role]) assert.ok(ids.has(p), `${role}: popular ${p} missing`);
    const allowed = new Set(require('../services/assistantScreens').screensForRole(role).map((s) => s.id));
    for (const s of h.sections) if (s.screen) assert.ok(allowed.has(s.screen.id));
  }
  const sup = svc.helpCenterForRole('Supervisor').sections.map((s) => s.title).join('|');
  assert.ok(!sup.includes('Generate worker payroll'));
  assert.throws(() => svc.helpCenterForRole('Guest'), (e) => e.status === 403);
});

test('AI prompt: English answers, no keyword lines', () => {
  const p = buildSystemPrompt('Admin');
  assert.ok(p.includes('Always reply in clear, simple English'));
  assert.ok(!p.includes('Keywords:'));
  assert.ok(p.includes('Screen: payroll'));
});
