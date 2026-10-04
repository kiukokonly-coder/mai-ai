// Netlify Function: /.netlify/functions/chat  (LIBRE: Google Gemini)
// Ang key ay nasa Netlify environment variable na GEMINI_API_KEY, hindi sa frontend.
// AWTOMATIKONG pipili ng model na available (hindi mo na kailangang palitan ang pangalan kapag nagbago ang Google).

const KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK = ['gemini-3.8-flash', 'gemini-3.5-flash-lite']; // gagamitin lang kung hindi makuha ang listahan

const SYSTEM = `You are MAI-ai, an AI assistant that only helps with programming and software development.
- Answer coding questions, debug errors, explain code, and write clean, working code.
- Put all code in fenced code blocks with the language name.
- If the user asks about something unrelated to coding, politely say you only help with code and steer back.
- The user may attach screenshots, PDFs, code files, or frames taken from a video (no audio). Look at them carefully and help with the code or error they show.
- Reply in the same language the user writes in (Tagalog, Taglish, or English). Keep explanations short and clear.`;

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
      .sort((a, b) => (a.lite - b.lite) || (b.v - a.v))
      .map(o => o.n)
      .slice(0, 5);
    if (found.length) { cache = { at: Date.now(), models: found }; return found; }
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!KEY) {
    return json(500, { error: 'Wala pang GEMINI_API_KEY sa Netlify. Ilagay ito sa Environment variables, tapos i-deploy ulit.' });
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) {
    return json(429, { error: 'Naubos mo na ang limit na 30 tanong kada oras. Balik ka mamaya!' });
  }
  recent.push(now);
  hits.set(ip, recent);

  try {
    const { messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'No messages' });

    const deadline = Date.now() + 8500; // 10 segundo ang limit ng Netlify
    const models = await pickModels();
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: toGemini(messages.slice(-20)),
      generationConfig: { maxOutputTokens: 2048 }
    });

    let last = { status: 500, msg: 'API error' }, sawBusy = false, sawQuota = false;

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
          sawBusy = true;
          break; // subukan ang susunod na model
        }
        clearTimeout(timer);

        if (res.ok) {
          const parts = data.candidates?.[0]?.content?.parts || [];
          const reply = parts.map(p => p.text || '').join('');
          return json(200, { reply: reply || 'Walang naisagot. Subukan mong itanong sa ibang paraan.' });
        }

        last = { status: res.status, msg: data.error?.message || 'API error' };
        if (res.status === 503 || res.status === 500) { sawBusy = true; await sleep(700); continue; } // busy: ulitin ng isang beses
        if (res.status === 429) sawQuota = true;
        break; // 429, 404, 400: subukan ang susunod na model
      }
    }

    if (sawBusy) return json(503, { error: 'Busy ang Google Gemini ngayon. Subukan ulit pagkalipas ng ilang segundo.' });
    if (sawQuota) return json(429, { error: 'Naubos na ang libreng limit ng Gemini sa ngayon. Subukan ulit mamaya.' });
    return json(last.status, { error: last.msg });
  } catch (err) {
    return json(500, { error: 'Server error' });
  }
};
