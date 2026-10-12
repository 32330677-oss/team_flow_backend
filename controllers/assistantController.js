// controllers/assistantController.js
// In-app Help Center and AI assistant. See services/assistantService.js.

const db = require('../config/db');
const assistant = require('../services/assistantService');

// Logging is best effort: a missing table (migration not run yet) or a DB
// error never breaks the answer. The warning is printed once.
let logWarned = false;
async function logQuestion(row) {
  try {
    await db.execute(
      `INSERT INTO assistant_logs
         (user_id, role, question, answer, screens, found_in_guide, error_code,
          input_tokens, output_tokens, cache_read_tokens, latency_ms, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.user_id, row.role, row.question, row.answer, row.screens,
        row.found_in_guide, row.error_code,
        row.input_tokens, row.output_tokens, row.cache_read_tokens, row.latency_ms, row.model,
      ]
    );
  } catch (e) {
    if (!logWarned) {
      logWarned = true;
      console.warn(`Assistant log not saved (${e.code || e.message}). Run migrations/2026_10_assistant/01_ddl.sql.`);
    }
  }
}

// GET /api/assistant/status
async function getStatus(req, res) {
  res.status(200).json({
    success: true,
    enabled: assistant.isEnabled(),
    suggestions: assistant.suggestionsForRole(req.user.role),
  });
}

// GET /api/assistant/guide  (Help Center: no AI, works without an API key)
async function getGuide(req, res) {
  try {
    const data = assistant.helpCenterForRole(req.user.role);
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    const status = e instanceof assistant.AssistantError ? e.status : 500;
    if (status === 500) console.error('Help Center error:', e);
    return res.status(status).json({ success: false, message: status === 500 ? 'Could not load the help topics.' : e.message });
  }
}

// POST /api/assistant/chat  { question, history?: [{role, content}], context_screen? }
async function chat(req, res) {
  const started = Date.now();
  const { question, history, context_screen: contextScreen } = req.body || {};
  const base = {
    user_id: req.user.user_id,
    role: req.user.role,
    question: typeof question === 'string' ? question.slice(0, 600) : '',
  };
  try {
    const r = await assistant.ask({ role: req.user.role, question, history, contextScreen });
    const u = r.usage || {};
    logQuestion({
      ...base,
      question: r.question,
      answer: r.answer.slice(0, 4000),
      screens: r.screens.map((s) => s.id).join(',') || null,
      found_in_guide: r.found_in_guide ? 1 : 0,
      error_code: null,
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_tokens: u.cache_read_input_tokens ?? null,
      latency_ms: Date.now() - started,
      model: r.model,
    });
    return res.status(200).json({
      success: true,
      answer: r.answer,
      screens: r.screens,
      found_in_guide: r.found_in_guide,
    });
  } catch (e) {
    const status = e instanceof assistant.AssistantError ? e.status : 500;
    const code = e instanceof assistant.AssistantError ? e.code : 'ASSISTANT_ERROR';
    if (!(e instanceof assistant.AssistantError)) console.error('Assistant error:', e);
    if (code !== 'QUESTION_REQUIRED') {
      logQuestion({
        ...base, answer: null, screens: null, found_in_guide: null, error_code: code,
        input_tokens: null, output_tokens: null, cache_read_tokens: null,
        latency_ms: Date.now() - started, model: null,
      });
    }
    return res.status(status).json({
      success: false,
      code,
      message: e instanceof assistant.AssistantError ? e.message : 'The assistant could not answer. Please try again.',
    });
  }
}

module.exports = { getStatus, getGuide, chat };
