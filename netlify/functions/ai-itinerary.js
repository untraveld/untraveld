// ==========================================================================
//  untraveld — Netlify Function: generador/ajustador de itinerarios con IA
//  Llama a la API de Anthropic (Claude Haiku) manteniendo la clave EN SECRETO
//  en el servidor. El HTML de la app NUNCA ve la clave: solo llama a
//  /.netlify/functions/ai-itinerary.
//
//  Variables de entorno (Netlify → Site settings → Environment variables):
//    ANTHROPIC_API_KEY   (obligatoria)  tu clave de console.anthropic.com
//    CLAUDE_MODEL        (opcional)     por defecto "claude-haiku-4-5"
//    AI_DAILY_LIMIT      (opcional)     nº máx. de peticiones por IP y día (0 = sin límite)
// ==========================================================================

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '0', 10) || 0;

// Límite de tasa muy básico, en memoria (se reinicia con la función; suficiente
// como red de seguridad para la beta — no es un contador exacto entre instancias).
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
    '',
    'The request has these fields:',
    '- mode: "generate" (build the whole trip) or "adjust" (change one day).',
    '- trip: { days, pace ("tranquilo"|"equilibrado"|"intenso"), company, interests[] }.',
    '- days: array of { index, date, region, base:{name,lat,lng}, prios:[] } (prios are category keys the user prioritised that day).',
    '- pois: array of candidate points { id, cat, name, desc, lat, lng }. cat is one of: monuments, nature, food, ocio.',
    '- slots: ordered list of time slots to use, e.g. ["Mañana","Comer","Tarde","Noche"].',
    '- (adjust only) dayIndex, current: the current stops of that day, and request: the user instruction in natural language.',
    '',
    'HARD RULES:',
    '1. You may ONLY use points that appear in pois[]. Reference them by their exact "id". NEVER invent a place or an id.',
    '2. Choose stops per day according to pace: tranquilo≈2, equilibrado≈3, intenso≈4 real POI stops (excluding pure notes).',
    '3. Respect each day.prios when present (pick POIs whose cat is in prios); otherwise lean on trip.interests. It is fine to include variety.',
    '4. For the "Comer" slot, pick a POI with cat "food" that is geographically close to that day\'s other stops. If none fits, use a note instead of a poiId.',
    '5. Group each day so stops are near each other (use lat/lng) to keep travel short. Start conceptually from base.',
    '6. Do NOT reuse the same poiId on more than one day.',
    '7. In "adjust" mode, return ONLY the single day (index === dayIndex) with the requested change applied, still choosing from pois[].',
    '',
    'Write every "title", "reason", "note" and "summary" in ' + outLang + '. Keep reasons short (one sentence).',
    '',
    'OUTPUT SCHEMA (return exactly this shape):',
    '{',
    '  "days": [',
    '    { "index": <number>, "title": "<short day title>",',
    '      "stops": [ { "slot": "<one of slots>", "poiId": "<id from pois>", "reason": "<why>" },',
    '                 { "slot": "<one of slots>", "note": "<free text, only when no poiId fits>" } ],',
    '      "note": "<optional short note for the day>" }',
    '  ],',
    '  "summary": "<one short sentence about the plan>"',
    '}'
  ].join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Falta ANTHROPIC_API_KEY en el entorno del sitio.' }) };

  const body = event.body || '';
  if (body.length > 200000)
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Petición demasiado grande.' }) };

  let payload;
  try { payload = JSON.parse(body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '')) || 'anon';
  if (!rateOk(ip))
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Has alcanzado el límite diario de generaciones. Inténtalo mañana.' }) };

  const lang = payload.lang === 'en' ? 'en' : 'es';
  const system = buildSystem(lang);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: system,
        messages: [
          { role: 'user', content: JSON.stringify(payload) },
          { role: 'assistant', content: '{' }   // prefill: fuerza salida JSON pura
        ]
      })
    });

    const data = await resp.json();
    if (!resp.ok)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'La API de IA devolvió un error.', detail: data }) };

    let text = (data.content && data.content[0] && data.content[0].text) || '';
    text = '{' + text;   // reponemos la llave del prefill

    let obj = null;
    try { obj = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!obj)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No se pudo interpretar la respuesta de la IA.', raw: text.slice(0, 500) }) };

    return { statusCode: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: JSON.stringify(obj) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
