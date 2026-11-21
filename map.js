// Footclaim live map. Reads public game data from Supabase with the publishable key (read-only for visitors:
// the database shows them exactly what any player sees) and draws it on Google Maps in the app's navy style.
'use strict';

const SUPABASE_URL = 'https://zacyvbrvvdwkqngygvas.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_ZtmO4_4SefobCFn9m4sTmA_LQd_O6PU';
// Browser key, restricted to footclaim.app in Google Cloud: it is meant to be public.
const GOOGLE_MAPS_KEY = 'AIzaSyDI-wpdPMnV7EqMAna6oYxM2sNhydwNxWs';
const SITE = 'https://footclaim.app';
const LIMASSOL = { lat: 34.6786, lng: 33.0413 };
const RADIUS_KM = 100;
const WARNING_MS = 3 * 86400000; // the reminder push goes out 3 days before a zone ends
// Same palette and rule as the app: a zone takes the colour its owner picked, else one from their id.
const PLAYER_COLORS = ['#FFD83D', '#3DD6FF', '#9B7BFF', '#5B8CFF', '#FF7A59', '#FF9A3D'];
const NAVY_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1A2045' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#A9B0D6' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#141936' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2A3260' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3D4778' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0E1230' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#1F2650' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1E2A40' }] },
  { featureType: 'poi', elementType: 'labels.icon', stylers: [{ saturation: -40 }, { lightness: -10 }] },
  { featureType: 'transit', stylers: [{ visibility: 'simplified' }] },
];

const $ = (id) => document.getElementById(id);
const state = { map: null, zones: new Map(), pins: new Map(), rows: [], selected: null, tab: 'global', boardSeq: 0, zoneSeq: 0, tick: null };
const M_PER_DEG = 111320;
const PIN_MAX = 30;
let Pin = null; // the pin overlay class, made once Google Maps has loaded

const logoUrl = (path) => `${SUPABASE_URL}/storage/v1/object/public/zone-logos/${path}`;

// ---------- data ----------

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

// ---------- colours: the same rules as the app (mobile/src/lib/colors.ts) ----------

const NAVY = '#141936';
const OWN_GREEN = '#A7D457';
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c);
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const linear = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function lab(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  const f = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883]
    .map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
/** A picked colour shows only if it stands out on the navy map and is not close to the "your zone" green. */
function colourOk(hex) {
  if (!isHex(hex)) return false;
  const [hi, lo] = [luminance(hex), luminance(NAVY)].sort((a, b) => b - a);
  if ((hi + 0.05) / (lo + 0.05) < 1.9) return false;
  const [l1, a1, b1] = lab(hex);
  const [l2, a2, b2] = lab(OWN_GREEN);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) >= 25;
}

function zoneColor(ownerId, picked) {
  if (picked && colourOk(String(picked))) return String(picked).toUpperCase();
  let h = 0;
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) >>> 0;
  return PLAYER_COLORS[h % PLAYER_COLORS.length];
}

// Whole m², thousands split by a no-break space, as in the app: 266 424 m².
const formatArea = (m2) => `${String(Math.round(m2)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} m²`;

function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const pad = (n) => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

// ---------- notices ----------

function notice(text) {
  const el = $('notice');
  el.textContent = text || '';
  el.hidden = !text;
}

// ---------- zone card ----------

function showZone(z) {
  state.selected = z;
  $('panel').classList.add('has-zone');
  $('zone').hidden = false;
  // The card wears the zone: a band in its colour, its logo (else its owner's avatar) stuck over the edge.
  const owner = z.blocked ? 'Blocked player' : `@${z.owner_handle}`;
  $('zone-band').style.backgroundColor = zoneColor(z.owner_id, z.style && z.style.color);
  $('zone-badge').textContent = owner;
  const pic = pinPicture(z);
  const logo = $('zone-logo');
  if (pic) logo.src = logoUrl(pic.path);
  logo.classList.toggle('avatar', !!pic && pic.kind === 'avatar');
  logo.hidden = !pic;
  $('zone').classList.toggle('has-picture', !!pic);
  $('zone-name').textContent = z.name;
  $('zone-meta').textContent = `by ${owner}`;
  $('zone-area').textContent = formatArea(z.area_m2);
  const text = $('zone-text');
  text.textContent = z.text || '';
  text.hidden = !z.text;
  const link = $('zone-link');
  if (z.link_url) {
    link.href = z.link_url;
    $('zone-link-text').textContent = z.link_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  $('zone-report').href = `mailto:hello@footclaim.app?subject=${encodeURIComponent('Report zone ' + z.id)}&body=${encodeURIComponent('Zone: ' + SITE + '/map?z=' + z.id + '\n\nWhat is wrong with it:\n')}`;
  tickTimer();
  clearInterval(state.tick);
  state.tick = setInterval(tickTimer, 1000);
  history.replaceState(null, '', `map?z=${z.id}`);
  restyle();
  drawPins();
}

function hideZone() {
  state.selected = null;
  clearInterval(state.tick);
  $('zone').hidden = true;
  $('panel').classList.remove('has-zone');
  history.replaceState(null, '', 'map');
  restyle();
  drawPins();
}

function tickTimer() {
  const z = state.selected;
  if (!z) return;
  const left = Date.parse(z.expires_at) - Date.now();
  $('timer-label').textContent = left > 0 ? 'Burns out in' : '';
  const clock = $('timer-clock');
  clock.textContent = left > 0 ? formatCountdown(left) : 'Burnt out';
  clock.classList.toggle('urgent', left > 0 && left < WARNING_MS);
  $('timer-left').hidden = left <= 0;
}

async function share() {
  const z = state.selected;
  if (!z) return;
  const url = `${SITE}/map?z=${z.id}`;
  const title = `${z.name} on Footclaim`;
  try {
    if (navigator.share) {
      await navigator.share({ title, text: `${z.name}: ${formatArea(z.area_m2)} claimed on foot`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    $('zone-share-label').textContent = 'Link copied';
    setTimeout(() => ($('zone-share-label').textContent = 'Share'), 2000);
  } catch {
    // Share sheet dismissed: nothing to do.
  }
}

// ---------- leaderboard ----------

function setTab(tab) {
  state.tab = tab;
  $('tab-global').setAttribute('aria-selected', String(tab === 'global'));
  $('tab-local').setAttribute('aria-selected', String(tab === 'local'));
  $('board-caption').textContent =
    tab === 'global'
      ? 'Everyone, ranked by the ground they hold right now.'
      : `Players with zones within ${RADIUS_KM} km of the centre of the map.`;
  loadBoard();
}

async function loadBoard() {
  const seq = ++state.boardSeq;
  let body = {};
  if (state.tab === 'local') {
    const c = state.map ? state.map.getCenter() : null;
    const at = c ? { lat: c.lat(), lng: c.lng() } : LIMASSOL;
    body = { p_lon: Math.round(at.lng * 100) / 100, p_lat: Math.round(at.lat * 100) / 100 };
  }
  try {
    const rows = await rpc('leaderboard', body);
    if (seq === state.boardSeq) renderBoard(rows);
  } catch {
    if (seq === state.boardSeq) renderBoard(null);
  }
}

function renderBoard(rows) {
  const list = $('board-list');
  list.replaceChildren();
  if (!rows || rows.length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = rows
      ? state.tab === 'local'
        ? `No one holds ground within ${RADIUS_KM} km of here yet.`
        : 'No one holds ground yet.'
      : 'Can’t load the leaderboard right now.';
    li.append(span);
    list.append(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    const place = document.createElement('span');
    place.className = 'place' + (r.place <= 3 ? ' top' : '');
    place.textContent = r.place;
    let sw;
    if (r.avatar_path) {
      sw = document.createElement('img');
      sw.src = logoUrl(r.avatar_path);
      sw.alt = '';
    } else {
      sw = document.createElement('span');
      sw.textContent = (r.display_name || '?').trim().charAt(0).toUpperCase();
      sw.style.background = zoneColor(r.player_id, r.color);
    }
    sw.className = 'avatar';
    sw.setAttribute('aria-hidden', 'true');
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.display_name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `@${r.handle} · ${r.zones} ${r.zones === 1 ? 'zone' : 'zones'}`;
    who.append(name, meta);
    const area = document.createElement('span');
    area.className = 'area';
    area.append(String(Math.round(r.area_m2)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = ' m²';
    area.append(unit);
    li.append(place, sw, who, area);
    li.setAttribute('aria-label', `Place ${r.place}, ${r.display_name}, ${formatArea(r.area_m2)}, ${r.zones} ${r.zones === 1 ? 'zone' : 'zones'}`);
    list.append(li);
  }
}

// ---------- map ----------

function restyle() {
  if (!state.map) return;
  state.map.data.setStyle((f) => {
    const color = f.getProperty('color');
    const on = state.selected && f.getId() === state.selected.id;
    return { fillColor: color, fillOpacity: on ? 0.45 : 0.28, strokeColor: color, strokeWeight: on ? 3 : 2, clickable: true };
  });
}

async function loadZones() {
  const b = state.map.getBounds();
  if (!b) return;
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  const seq = ++state.zoneSeq;
  try {
    const rows = await rpc('zones_in_view', { min_lon: sw.lng(), min_lat: sw.lat(), max_lon: ne.lng(), max_lat: ne.lat() });
    if (seq !== state.zoneSeq) return;
    const seen = new Set();
    for (const z of rows) {
      seen.add(z.id);
      state.zones.set(z.id, z);
      if (!state.map.data.getFeatureById(z.id)) {
        state.map.data.addGeoJson({
          type: 'Feature',
          id: z.id,
          geometry: z.geojson,
          properties: { color: zoneColor(z.owner_id, z.style && z.style.color) },
        });
      }
    }
    state.map.data.forEach((f) => {
      const id = f.getId();
      if (!seen.has(id) && !(state.selected && state.selected.id === id)) {
        state.map.data.remove(f);
        state.zones.delete(id);
      }
    });
    state.rows = rows;
    drawPins();
    notice('');
  } catch {
    notice('Can’t load zones right now. Check your connection.');
  }
}

// ---------- pins: the same rules as the app (mobile/src/lib/pins.ts) ----------

/** A zone's logo, else its owner's avatar, else no pin. */
function pinPicture(z) {
  if (z.logo_path) return { kind: 'logo', path: z.logo_path };
  if (z.avatar_path) return { kind: 'avatar', path: z.avatar_path };
  return null;
}

/** 36 px for a 1 000 m² zone, +12 for every ten times more ground, up to 72. */
const pinSize = (area) => Math.round(Math.min(72, 36 + 12 * Math.log10(Math.max(area, 1000) / 1000)));

function makePinClass() {
  return class extends google.maps.OverlayView {
    constructor(zone, picture, size) {
      super();
      this.at = new google.maps.LatLng(zone.logo_lat, zone.logo_lon);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `pin ${picture.kind}`;
      el.style.setProperty('--size', `${size}px`);
      el.setAttribute('aria-label', `${zone.name}, @${zone.owner_handle}`);
      const img = document.createElement('img');
      img.src = logoUrl(picture.path);
      img.alt = '';
      el.append(img);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showZone(state.zones.get(zone.id) || zone);
      });
      this.el = el;
    }
    onAdd() {
      this.getPanes().overlayMouseTarget.append(this.el);
    }
    draw() {
      const p = this.getProjection().fromLatLngToDivPixel(this.at);
      if (!p) return;
      this.el.style.left = `${p.x}px`;
      this.el.style.top = `${p.y}px`;
    }
    onRemove() {
      this.el.remove();
    }
  };
}

/**
 * Pins for the zones in view, biggest first: a zone at least about 1/60 of the map's height gets one, a pin that
 * would cover a bigger zone's pin is left out, at most 30. The selected zone always keeps its pin.
 */
function drawPins() {
  if (!Pin || !state.map) return;
  const b = state.map.getBounds();
  if (!b) return;
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  const box = $('map').getBoundingClientRect();
  const latSpan = ne.lat() - sw.lat();
  const lngSpan = (ne.lng() - sw.lng() + 360) % 360 || 360;
  const visibleM = latSpan * M_PER_DEG;
  const selectedId = state.selected && state.selected.id;
  const rows = state.rows.slice();
  if (state.selected && !rows.some((z) => z.id === selectedId)) rows.push(state.selected);
  const candidates = rows
    .filter((z) => z.logo_lat !== null && z.logo_lon !== null && pinPicture(z))
    .filter((z) => z.id === selectedId || (z.logo_half_m / 0.62) * 2 >= visibleM / 60)
    .sort((a, b) => (b.id === selectedId) - (a.id === selectedId) || b.area_m2 - a.area_m2);
  const placed = [];
  const want = new Map();
  for (const z of candidates) {
    if (want.size >= PIN_MAX) break;
    const size = pinSize(z.area_m2);
    const x = ((z.logo_lon - sw.lng()) / lngSpan) * box.width;
    const y = ((ne.lat() - z.logo_lat) / latSpan) * box.height;
    if (z.id !== selectedId) {
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < 0.8 * ((p.size + size) / 2))) continue;
      placed.push({ x, y, size });
    }
    const picture = pinPicture(z);
    want.set(`${z.id}|${picture.path}|${size}`, { z, picture, size });
  }
  for (const [key, pin] of state.pins) {
    if (!want.has(key)) {
      pin.setMap(null);
      state.pins.delete(key);
    }
  }
  for (const [key, { z, picture, size }] of want) {
    if (!state.pins.has(key)) {
      const pin = new Pin(z, picture, size);
      pin.setMap(state.map);
      state.pins.set(key, pin);
    }
    state.pins.get(key).el.classList.toggle('on', z.id === selectedId);
  }
}

function boundsOf(geojson) {
  const b = new google.maps.LatLngBounds();
  const rings = geojson.type === 'Polygon' ? geojson.coordinates : geojson.coordinates.flat();
  for (const ring of rings) for (const [lng, lat] of ring) b.extend({ lat, lng });
  return b;
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function loadGoogle() {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_MAPS_KEY) return reject(new Error('no key'));
    window.__footclaimMapReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&v=weekly&callback=__footclaimMapReady&loading=async`;
    s.async = true;
    s.onerror = reject;
    document.head.append(s);
  });
}

async function startMap(shared) {
  try {
    await loadGoogle();
  } catch {
    const fb = $('map-fallback');
    fb.textContent = 'The map can’t load here right now. The zone card and the leaderboard still work.';
    fb.hidden = false;
    $('locate').hidden = true;
    return;
  }
  state.map = new google.maps.Map($('map'), {
    center: LIMASSOL,
    zoom: 13,
    styles: NAVY_STYLE,
    backgroundColor: '#1A2045',
    disableDefaultUI: true,
    zoomControl: true,
    // Top right, clear of the "around me" button in the bottom corner.
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
    gestureHandling: 'greedy',
    clickableIcons: false,
  });
  restyle();
  Pin = makePinClass();
  state.map.data.addListener('click', (e) => {
    const z = state.zones.get(e.feature.getId());
    if (z) showZone(z);
  });
  state.map.addListener('click', () => state.selected && hideZone());
  const refresh = debounce(() => {
    loadZones();
    if (state.tab === 'local') loadBoard();
  }, 300);
  state.map.addListener('idle', refresh);
  if (shared) {
    state.zones.set(shared.id, shared);
    // Frame the zone in the part of the map the panel does not cover: right of the column, above the sheet.
    const phone = window.matchMedia('(max-width: 760px)').matches;
    const pad = phone
      ? { top: 24, right: 24, left: 24, bottom: Math.round(window.innerHeight * 0.5) }
      : { top: 48, right: 72, bottom: 48, left: 408 };
    state.map.fitBounds(boundsOf(shared.geojson), pad);
    showZone(shared);
  }
}

function locate() {
  if (!navigator.geolocation || !state.map) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.map.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      state.map.setZoom(15);
    },
    () => notice('Location is off for this site. Allow it in your browser to jump to where you are.'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

async function main() {
  $('zone-close').addEventListener('click', hideZone);
  $('zone-share').addEventListener('click', share);
  $('tab-global').addEventListener('click', () => setTab('global'));
  $('tab-local').addEventListener('click', () => setTab('local'));
  $('locate').addEventListener('click', locate);

  // A shared link opens straight on its zone: footclaim.app/map?z=<id>
  const id = new URLSearchParams(location.search).get('z');
  let shared = null;
  if (id && /^[0-9a-f-]{36}$/i.test(id)) {
    try {
      [shared] = await rpc('zone_by_id', { p_id: id });
    } catch {
      // Falls through to the notice below.
    }
    if (!shared) notice('This zone has burnt out or was taken over. Here is the map as it stands now.');
  }
  loadBoard();
  await startMap(shared || null);
  if (shared && !state.map) showZone(shared);
}

main();
