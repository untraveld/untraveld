const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '0', 10) || 0;
const _hits = {};
function rateOk(ip) {
  if (!DAILY_LIMIT) return true;
  const day = new Date().toISOString().slice(0, 10);
  const k = ip + '|' + day;
  _hits[k] = (_hits[k] || 0) + 1;
  return _hits[k] <= DAILY_LIMIT;
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function buildSystem(lang) {
  const outLang = lang === 'en' ? 'English' : 'Spanish';
  return [
    'You are the itinerary planner for "untraveld", a travel app.',
    'You receive a JSON request and MUST reply with ONLY a valid JSON object — no markdown, no prose, no code fences.',
    'The request has these fields:',
    '- mode: "generate" or "adjust" or "chat".',
    '- trip: { days, pace, company, interests[] }.',
    '- days: array of { index, date, region, base:{name,lat,lng}, prios:[] }.',
    '- pois: array of candidate points { id, cat, name, desc, lat, lng }. cat is one of: monuments, nature, food, ocio.',
    '- slots: ordered time slots, e.g. ["Mañana","Comer","Tarde","Noche"].',
    'HARD RULES:',
    '1. Only use points that appear in pois[]. Reference them by their exact "id". Never invent a place or id.',
    '2. Stops per day by pace: tranquilo~2, equilibrado~3, intenso~4 real POI stops.',
    '3. Respect each day.prios when present; otherwise use trip.interests.',
    '4. For "Comer" pick a cat "food" POI close to that day; if none fits use a note.',
    '5. Group each day geographically (use lat/lng). 6. Do not reuse a poiId across days.',
    'CHAT MODE (mode === "chat"): you also get "message", "hasAgenda" and "current". Act as a friendly travel assistant and decide:',
    '- brand-new plan -> "action":"generate" and the FULL trip in days[] (indices 0..days-1).',
    '- change existing -> "action":"adjust" and ONLY the changed day(s) with their real "index".',
    '- just answer/chat -> "action":"none" and no days.',
    'ALWAYS include a warm "reply" (1-3 sentences) in ' + outLang + '. Same POI-only rules apply.',
    'Write every title, reason, note, reply and summary in ' + outLang + '.',
    'OUTPUT JSON: {"reply":"...","action":"generate|adjust|none","days":[{"index":0,"title":"...","stops":[{"slot":"...","poiId":"...","reason":"..."},{"slot":"...","note":"..."}],"note":"..."}],"summary":"..."}'
  ].join('\n');
}
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Falta ANTHROPIC_API_KEY' }) };
  const body = event.body || '';
  if (body.length > 200000) return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Petición demasiado grande.' }) };
  let payload;
  try { payload = JSON.parse(body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON inválido.' }) }; }
  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '')) || 'anon';
  if (!rateOk(ip)) return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Límite diario alcanzado.' }) };
  const lang = payload.lang === 'en' ? 'en' : 'es';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3500, system: buildSystem(lang), messages: [ { role: 'user', content: JSON.stringify(payload) }, { role: 'assistant', content: '{' } ] })
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'La API de IA devolvió un error.', detail: data }) };
    let text = '{' + ((data.content && data.content[0] && data.content[0].text) || '');
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} } }
    if (!obj) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Respuesta no interpretable.', raw: text.slice(0, 500) }) };
    return { statusCode: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: JSON.stringify(obj) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
