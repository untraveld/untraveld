// ==========================================================================
//  untraveld — Netlify Function: ruta a pie hacia un POI (navegación guiada)
//  Proxya OpenRouteService (perfil foot-walking) manteniendo la clave EN
//  SECRETO en el servidor. El HTML nunca ve la clave: solo llama a
//  /.netlify/functions/walk-route.
//
//  Variables de entorno (Netlify → Site settings → Environment variables):
//    ORS_API_KEY         (obligatoria)  clave gratuita de openrouteservice.org
//    ROUTE_DAILY_LIMIT   (opcional)     nº máx. de peticiones por IP y día (0 = sin límite)
//
//  Entrada  (POST JSON): { start:[lat,lng], end:[lat,lng], lang:"es"|"en" }
//  Salida   (JSON):      { coords:[[lat,lng]...], distance, duration,
//                          steps:[{instruction, distance, name, idx}] }
//    - coords:   geometría de la ruta ya en [lat,lng] (lista para Leaflet)
//    - distance: metros totales   · duration: segundos totales (a pie)
//    - steps[].idx: índice dentro de coords donde ocurre la maniobra
// ==========================================================================

const DAILY_LIMIT = parseInt(process.env.ROUTE_DAILY_LIMIT || '0', 10) || 0;

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

function num(x) { return typeof x === 'number' && isFinite(x); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ORS_API_KEY;
  if (!key)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Falta ORS_API_KEY en el entorno del sitio.' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const start = payload.start, end = payload.end;
  if (!Array.isArray(start) || !Array.isArray(end) || !num(start[0]) || !num(start[1]) || !num(end[0]) || !num(end[1]))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Coordenadas start/end inválidas ([lat,lng]).' }) };

  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '')) || 'anon';
  if (!rateOk(ip))
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Límite diario de rutas alcanzado. Inténtalo mañana.' }) };

  const lang = payload.lang === 'en' ? 'en' : 'es';
  // ORS espera [lng, lat]
  const body = {
    coordinates: [[start[1], start[0]], [end[1], end[0]]],
    instructions: true,
    language: lang,
    units: 'm'
  };

  try {
    const resp = await fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
      method: 'POST',
      headers: {
        'Authorization': key,
        'Content-Type': 'application/json',
        'Accept': 'application/geo+json'
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (!resp.ok)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'El servicio de rutas devolvió un error.', detail: data && data.error }) };

    const feat = data.features && data.features[0];
    if (!feat || !feat.geometry || !Array.isArray(feat.geometry.coordinates))
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No se pudo calcular la ruta a pie.' }) };

    const coords = feat.geometry.coordinates.map(c => [c[1], c[0]]); // -> [lat,lng]
    const props = feat.properties || {};
    const summary = props.summary || {};
    const steps = [];
    (props.segments || []).forEach(seg => {
      (seg.steps || []).forEach(s => {
        steps.push({
          instruction: s.instruction || '',
          distance: s.distance || 0,
          name: (s.name && s.name !== '-') ? s.name : '',
          idx: Array.isArray(s.way_points) ? s.way_points[0] : 0
        });
      });
    });

    const out = {
      coords: coords,
      distance: summary.distance || 0,
      duration: summary.duration || 0,
      steps: steps
    };
    return { statusCode: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
