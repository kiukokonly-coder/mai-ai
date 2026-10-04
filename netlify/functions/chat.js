// Netlify Function: /.netlify/functions/chat
// Ang API key ay nasa Netlify environment variable (ANTHROPIC_API_KEY), hindi sa frontend.

const SYSTEM = `You are MAI-ai, an AI assistant that only helps with programming and software development.
- Answer coding questions, debug errors, explain code, and write clean, working code.
- Put all code in fenced code blocks with the language name.
- If the user asks about something unrelated to coding, politely say you only help with code and steer back.
- The user may attach screenshots, PDFs, code files, or frames taken from a video (no audio). Look at them carefully and help with the code or error they show.
- Reply in the same language the user writes in (Tagalog, Taglish, or English). Keep explanations short and clear.`;

// Simpleng limit: 30 tanong bawat oras bawat IP (best-effort, nare-reset kapag nag-restart ang function)
const hits = new Map();
const LIMIT = 30, WINDOW = 60 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Naubos mo na ang limit na 30 tanong kada oras. Balik ka mamaya!' }) };
  }
  recent.push(now);
  hits.set(ip, recent);

  try {
    const { messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No messages' }) };
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: messages.slice(-20) // last 20 messages lang para hindi lumaki
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    const reply = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};