// Hawkama AI Assistant - Netlify Function (Gemini, free tier)
// Needs env var GEMINI_API_KEY (set in Netlify > Site configuration > Environment variables)
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const SYSTEM = `You are the Hawkama AI Governance Assistant for small UAE businesses.
Explain AI-use risks, policy clauses and next steps in plain English, using the context provided.
Rules: you do not approve, decide or certify anything; you never claim legal compliance;
always remind the user that a qualified human must review. This is not legal advice. Keep answers under 150 words.`;

const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  const key0 = process.env.GEMINI_API_KEY;
  if (event.httpMethod === "GET") {
    if (!key0) return { statusCode: 200, headers, body: JSON.stringify({ version: "v7", key: "MISSING" }) };
    const lr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key0 } });
    const ld = await lr.json();
    const names = (ld.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace("models/", ""));
    return { statusCode: 200, headers, body: JSON.stringify({ version: "v7", key: "set", models: names }, null, 1) };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const key = process.env.GEMINI_API_KEY;
  if (!key) return { statusCode: 503, headers, body: JSON.stringify({ error: "no_key", detail: "GEMINI_API_KEY is not set on Netlify" }) };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const question = (body.question || body.prompt || "Explain my results and top next steps.").slice(0, 2000);
  const context = JSON.stringify(body.context || {}).slice(0, 6000);

  const prompt = `Context (dashboard answers):\n${context}\n\nQuestion: ${question}`;
  const call = async (fast, model) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1500, 8500 - (Date.now() - started)));
    const gen = { temperature: 0.4, maxOutputTokens: 350 };
    if (fast) gen.thinkingConfig = { thinkingBudget: 0 };
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: gen
        })
      });
      return { r, data: await r.json() };
    } finally { clearTimeout(t); }
  };
  // Try the main model, then backups, while staying under Netlify's 10-second limit
  let models = [MODEL, ...(process.env.GEMINI_BACKUP_MODELS || "gemini-3.8-flash,gemini-3.8-flash-lite").split(",")]
    .map(m => m.trim()).filter((m, i, a) => m && a.indexOf(m) === i);
  const started = Date.now();
  try {
    const lr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const ld = await lr.json();
    const found = (ld.models || []).filter(x => (x.supportedGenerationMethods || []).includes("generateContent"))
      .map(x => x.name.replace("models/", "")).filter(n => /flash/i.test(n) && !/^gemini-(1|2)\./.test(n) && !/image|tts|audio|live|embed/i.test(n));
    found.forEach(n => { if (!models.includes(n)) models.push(n); });
  } catch (e) {}
  const tried = [];
  let last = "no model answered";
  try {
    for (const m of models) {
      if (Date.now() - started > 7000) break;
      tried.push(m);
      let res;
      try { res = await call(true, m); if (res.r.status === 400) res = await call(false, m); }
      catch (e) { last = e.name === "AbortError" ? "timeout" : String(e); continue; }
      const { r, data } = res;
      if (r.ok) {
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
        if (text) return { statusCode: 200, headers, body: JSON.stringify({ answer: text, reply: text, text, model: m }) };
        last = "empty reply"; continue;
      }
      const msg = data.error?.message || ("HTTP " + r.status);
      if (!/no longer available|not found/i.test(msg)) last = msg;
      if (/demand|overloaded/i.test(msg)) await new Promise(z => setTimeout(z, 800));
      // busy (429/503) or retired model (404): try the next one; anything else (e.g. bad key) stop
      if (![404, 429, 500, 503].includes(r.status) && !/demand|overloaded|no longer available|not found/i.test(last)) break;
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: "upstream_error", detail: last + " | tried: " + tried.join(", ") }) };
  } catch (e) {
    if (e.name === "AbortError") return { statusCode: 504, headers, body: JSON.stringify({ error: "timeout", detail: "Gemini took too long. Try a shorter question." }) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: "function_error", detail: String(e) }) };
  }
};
