// Netlify Function: /.netlify/functions/chat  (bersyon na LIBRE: Google Gemini)
// Ang key ay nasa Netlify environment variable na GEMINI_API_KEY, hindi sa frontend.
//
// BAGO: Suporta na sa malalaking file (video, PDF, atbp.) gamit ang Gemini Files API.
// Ang maliliit na file (hanggang ~3MB) ay pwede pa ring i-send inline (base64) gaya ng dati.
// Ang malalaking file ay ina-upload ng browser DIRECT sa Google (hindi dumadaan sa Netlify,
// kaya hindi tinatamaan ng 6MB limit), tapos reference lang (file uri) ang ipinapadala dito.
//
// Mga action ng function na ito (field na "action" sa JSON body):
//   (wala o "chat")  -> normal na chat
//   "start-upload"   -> gumagawa ng upload URL para sa malaking file
//   "file-status"    -> tinitingnan kung ACTIVE (handa na) ang na-upload na file

// Kung may error na "model not found", palitan ito ng pangalan na nakalista sa aistudio.google.com
const MODEL = 'gemini-2.5-flash';

const API = 'https://generativelanguage.googleapis.com';
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB, limit ng Gemini Files API kada file

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

// Ginagawang Gemini format ang mga mensahe (text, picture, PDF, at malalaking file)
function toGemini(messages) {
  return messages.map(m => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const parts = blocks.map(b => {
      // Malaking file na na-upload na sa Gemini Files API
      if (b.type === 'file') {
        return { fileData: { mimeType: b.media_type, fileUri: b.uri } };
      }
      // Maliit na file na kasama mismo (base64)
      if (b.type === 'image' || b.type === 'document') {
        return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
      }
      return { text: b.text || '' };
    });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

// Tinitiyak na galing sa Google ang file uri (para hindi ma-abuso)
function validFileBlocks(messages) {
  for (const m of messages) {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'file') {
        if (typeof b.uri !== 'string' || !b.uri.startsWith(API + '/') || typeof b.media_type !== 'string') return false;
      }
    }
  }
  return true;
}

// Ibinibilang ang request sa limit ng IP. true = pasok pa, false = lampas na.
function withinLimit(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) { hits.set(ip, recent); return false; }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

// Hakbang 1 ng malaking upload: kumuha ng upload URL mula sa Google
async function startUpload(body) {
  const size = Number(body.size);
  const mimeType = String(body.mimeType || '');
  const name = String(body.name || 'file').slice(0, 100);

  if (!Number.isFinite(size) || size <= 0) return json(400, { error: 'Invalid file size' });
  if (size > MAX_FILE_BYTES) return json(413, { error: 'Masyadong malaki ang file. Hanggang 2GB lang ang kaya ng Gemini.' });
  if (!mimeType) return json(400, { error: 'Missing file type' });

  const res = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: name } })
  });

  if (res.status === 429) return json(429, { error: 'Naubos na ang libreng limit ng Gemini sa ngayon. Subukan ulit mamaya.' });
  if (!res.ok) {
    let msg = 'Hindi nakagawa ng upload URL';
    try { const d = await res.json(); msg = d.error?.message || msg; } catch (e) {}
    return json(res.status, { error: msg });
  }

  const uploadUrl = res.headers.get('x-goog-upload-url');
  if (!uploadUrl) return json(500, { error: 'Walang upload URL na ibinigay ang Google' });
  return json(200, { uploadUrl });
}

// Tinitingnan kung handa na (ACTIVE) ang file. Ang video ay kailangan munang i-process.
async function fileStatus(body) {
  const name = String(body.name || '');
  if (!/^files\/[a-z0-9-]+$/.test(name)) return json(400, { error: 'Invalid file name' });

  const res = await fetch(`${API}/v1beta/${name}`, {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
  });
  const data = await res.json();
  if (!res.ok) return json(res.status, { error: data.error?.message || 'API error' });
  return json(200, { state: data.state, uri: data.uri, mimeType: data.mimeType });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!process.env.GEMINI_API_KEY) {
    return json(500, { error: 'Wala pang GEMINI_API_KEY sa Netlify. Ilagay ito sa Environment variables, tapos i-deploy ulit.' });
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action || 'chat';

    if (action === 'file-status') {
      return await fileStatus(body);
    }

    if (!withinLimit(ip)) {
      return json(429, { error: 'Naubos mo na ang limit na 30 tanong kada oras. Balik ka mamaya!' });
    }

    if (action === 'start-upload') {
      return await startUpload(body);
    }

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'No messages' });
    if (!validFileBlocks(messages)) return json(400, { error: 'Invalid file reference' });

    const res = await fetch(`${API}/v1beta/models/${MODEL}:generateContent`, {
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
