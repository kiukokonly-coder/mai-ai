// Vercel Function: /api/chat  (LIBRE: Google Gemini)
// Ang key ay nasa Vercel environment variable na GEMINI_API_KEY, hindi sa frontend.
// AWTOMATIKONG pipili ng model na available (hindi mo na kailangang palitan ang pangalan kapag nagbago ang Google).

const KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK = ['gemini-3.8-flash', 'gemini-3.5-flash-lite']; // gagamitin lang kung hindi makuha ang listahan

const DOCS = require('../netlify/functions/gtps-docs.js');

const SYSTEM = `You are MAI-ai, an AI assistant that specializes in writing GTPS Cloud Lua scripts for Growtopia private servers (https://gtps.cloud).
Your only job is helping users write, fix, explain, and improve Lua scripts that run on GTPS Cloud.

Rules for scripts:
- Use ONLY the classes, callbacks, global functions, and utilities listed in the REFERENCE below. Never invent functions, methods, or parameters. If something the user wants is not in the reference, say clearly that the API does not provide it and suggest the closest alternative that does exist.
- Scripts are written in Lua. Register behavior through the callbacks in the reference (for example onPlayerCommandCallback, onPlayerLoginCallback, onPlayerChatCallback, onPlayerDialogCallback, onHTTPRequest) and use the dialog string syntax from the reference for dialogs.
- Give the COMPLETE, ready-to-paste script in one fenced \`\`\`lua code block, with short comments. Then add a brief explanation of how it works and anything the user must set up (item IDs, role IDs, etc.). Keep the explanation short.
- When fixing a script, find the actual bug, show the corrected full script, and say what was wrong.
- If the request is unclear, make a sensible assumption, state it in one line, and still write the script.
- Do not write malware, scripts that steal accounts or passwords, or anything meant to attack other servers or players.
- If the user asks about something unrelated to GTPS Lua scripting, politely say you only help with GTPS Cloud Lua scripts.
- The user may attach screenshots, files, or frames from a video (no audio). Look at them carefully and help with the script or error they show.
- Reply in the same language the user writes in (Tagalog, Taglish, or English). Keep code identifiers and comments in English.

REFERENCE (official GTPS Cloud Lua API):
` + DOCS;

// Simpleng limit: 30 tanong bawat oras bawat IP
const hits = new Map();
const LIMIT = 30, WINDOW = 60 * 60 * 1000;

const json = (statusCode, obj) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tinatanong si Google kung anong mga model ang available, tapos pinipili ang pinakabago (flash muna, flash-lite pagkatapos)
let cache = { at: 0, models: [] };
async function pickModels() {
  if (cache.models.length && Date.now() - cache.at < 60 * 60 * 1000) return cache.models;
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    const found = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .map(n => {
        const x = n.match(/^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/);
        return x ? { n, v: Number(x[1]) * 100 + Number(x[2] || 0), lite: !!x[3] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.v - a.v);
    const flash = found.filter(o => !o.lite).map(o => o.n), lite = found.filter(o => o.lite).map(o => o.n);
    const order = [];
    for (let i = 0; i < 3; i++) { if (flash[i]) order.push(flash[i]); if (lite[i]) order.push(lite[i]); }
    if (order.length) { cache = { at: Date.now(), models: order }; return order; }
  } catch (e) { /* gamitin ang FALLBACK */ }
  return FALLBACK;
}

// Ginagawang Gemini format ang mga mensahe (text, picture, PDF)
function toGemini(messages) {
  return messages.map(m => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const parts = blocks.map(b => {
      if (b.type === 'image' || b.type === 'document') {
        return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
      }
      return { text: b.text || '' };
    });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

const run = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!KEY) {
    return json(500, { error: 'GEMINI_API_KEY is not set in Vercel. Add it under Settings > Environment Variables, then redeploy.' });
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) {
    return json(429, { error: 'You have reached the limit of 30 questions per hour. Please come back later.' });
  }
  recent.push(now);
  hits.set(ip, recent);

  try {
    const { messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'No messages' });

    const deadline = Date.now() + 25000; // 30 segundo ang max duration (tingnan ang vercel.json)
    const models = await pickModels();
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: toGemini(messages.slice(-20)),
      generationConfig: { maxOutputTokens: 2048 }
    });

    let last = { status: 500, msg: 'API error' }, sawBusy = false, sawQuota = false, tried = [];

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() > deadline) break;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
        let res, data;
        try {
          res = await fetch(`${BASE}/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
            body,
            signal: ctrl.signal
          });
          data = await res.json();
        } catch (e) {
          clearTimeout(timer);
          sawBusy = true; tried.push(model + ' timeout');
          break; // subukan ang susunod na model
        }
        clearTimeout(timer);

        if (res.ok) {
          const parts = data.candidates?.[0]?.content?.parts || [];
          const reply = parts.map(p => p.text || '').join('');
          return json(200, { reply: reply || 'No answer came back. Try rephrasing your question.' });
        }

        last = { status: res.status, msg: data.error?.message || 'API error' };
        tried.push(model + ' ' + res.status);
        if (res.status === 503 || res.status === 500) { sawBusy = true; await sleep(700); continue; } // busy: ulitin ng isang beses
        if (res.status === 429) sawQuota = true;
        break; // 429, 404, 400: subukan ang susunod na model
      }
    }

    if (sawBusy) return json(503, { error: 'Google Gemini is busy right now. Please try again in a few seconds. (' + tried.join(', ') + ')' });
    if (sawQuota) return json(429, { error: 'The free Gemini limit has been used up for now. Please try again later.' });
    return json(last.status, { error: last.msg });
  } catch (err) {
    return json(500, { error: 'Server error' });
  }
};

// Adapter: ginagawang Vercel (req, res) ang handler sa itaas
module.exports = async (req, res) => {
  const event = {
    httpMethod: req.method,
    headers: req.headers || {},
    body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
  };
  const out = await run(event);
  res.status(out.statusCode).setHeader('content-type', 'application/json');
  res.send(out.body);
};
