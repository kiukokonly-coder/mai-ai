// Netlify Function: /.netlify/functions/chat  (bersyon na LIBRE: Google Gemini)
// Ang key ay nasa Netlify environment variable na GEMINI_API_KEY, hindi sa frontend.

// Kung may error na "model not found", palitan ito ng pangalan na nakalista sa aistudio.google.com
const MODEL = 'gemini-3.8-flash';

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

  if (!process.env.GEMINI_API_KEY) {
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

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: toGemini(messages.slice(-20)),
        generationConfig: { maxOutputTokens: 2048 }
      })
    });

    const data = await res.json();
    if (res.status === 429) return json(429, { error: 'Naubos na ang libreng limit ng Gemini sa ngayon. Subukan ulit mamaya.' });
    if (!res.ok) return json(res.status, { error: data.error?.message || 'API error' });

    const parts = data.candidates?.[0]?.content?.parts || [];
    const reply = parts.map(p => p.text || '').join('');
    if (!reply) return json(200, { reply: 'Walang naisagot. Subukan mong itanong sa ibang paraan.' });
    return json(200, { reply });
  } catch (err) {
    return json(500, { error: 'Server error' });
  }
};
