// =============================================================================
// Red Alert LED Map PWA — app.js
// =============================================================================
'use strict';

// ── GEO constants (Israel SVG coordinate system) ──────────────────────────
const GEO={W:34.228663,N:33.434207,E:35.935383,S:29.496766,svgW:294.62534,svgH:792.60406};
function ll2svg(lat,lon){return{x:(lon-GEO.W)/(GEO.E-GEO.W)*GEO.svgW,y:(GEO.N-lat)/(GEO.N-GEO.S)*GEO.svgH};}

// ── Homography math ───────────────────────────────────────────────────────
function gaussElim(A,b){
  const n=b.length,M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<n;c++){
    let mp=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[mp][c]))mp=r;
    [M[c],M[mp]]=[M[mp],M[c]];const piv=M[c][c];if(Math.abs(piv)<1e-12)continue;
    for(let r=c+1;r<n;r++){const f=M[r][c]/piv;for(let j=c;j<=n;j++)M[r][j]-=f*M[c][j];}
  }
  const x=new Array(n).fill(0);
  for(let i=n-1;i>=0;i--){x[i]=M[i][n];for(let j=i+1;j<n;j++)x[i]-=M[i][j]*x[j];x[i]/=M[i][i];}
  return x;
}
function computeH(src,dst){
  const A=[];
  for(let i=0;i<4;i++){
    const[sx,sy]=[src[i].x,src[i].y],[dx,dy]=[dst[i].x,dst[i].y];
    A.push([-sx,-sy,-1,0,0,0,dx*sx,dx*sy,dx]);A.push([0,0,0,-sx,-sy,-1,dy*sx,dy*sy,dy]);
  }
  const h=gaussElim(A.map(r=>r.slice(0,8)),A.map(r=>-r[8]));return[...h,1];
}
function applyH(H,x,y){
  const w=H[6]*x+H[7]*y+H[8];if(Math.abs(w)<1e-9)return{x:0,y:0};
  return{x:(H[0]*x+H[1]*y+H[2])/w,y:(H[3]*x+H[4]*y+H[5])/w};
}

// ── i18n ──────────────────────────────────────────────────────────────────
let LANG = localStorage.getItem('ra_lang') || 'en';
function t(enStr, heStr){ return LANG==='he' ? (heStr||enStr) : enStr; }
function applyLang(){
  document.querySelectorAll('[data-en]').forEach(el=>{
    const val = LANG==='he' ? (el.dataset.he||el.dataset.en) : el.dataset.en;
    if(el.tagName==='INPUT'&&el.type!=='hidden') el.placeholder = val;
    else el.textContent = val;
  });
  document.getElementById('lang-btn').textContent = LANG==='he' ? 'EN' : 'HE';
  document.documentElement.dir = LANG==='he' ? 'rtl' : 'ltr';
}

// ── Theme ─────────────────────────────────────────────────────────────────
let THEME = localStorage.getItem('ra_theme') || 'dark';
function applyTheme(){
  document.documentElement.setAttribute('data-theme', THEME);
}

// ═══════════════════════════════════════════════════════════════════════════
// App — connection manager, polling, nav
// ═══════════════════════════════════════════════════════════════════════════
const App = (() => {
  let _base = '';      // http://redalertmap.local or http://192.168.4.1
  let _status = null;  // latest status JSON
  let _pollTimer = null;
  let _showLabels = false;
  const POLL_MS = 2000;

  // ── Connection ────────────────────────────────────────────────────────
  async function connect(){
    const addr = document.getElementById('setup-addr').value.trim() || 'redalertmap.local';
    const base = addr.startsWith('http') ? addr : `http://${addr}`;
    setMsg('Connecting…','');
    try {
      const r = await fetch(`${base}/status`,{signal:AbortSignal.timeout(4000)});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const d = await r.json();
      _base = base;
      localStorage.setItem('ra_device', base);
      hidConnScreen();
      startPolling();
      updateFromStatus(d);
    } catch(e){
      setMsg('Could not connect: '+e.message,'color:var(--red)');
    }
  }

  async function connectAuto(){
    setMsg('Auto-detecting…','');
    const candidates = ['http://redalertmap.local','http://192.168.4.1'];
    const saved = localStorage.getItem('ra_device');
    if(saved && !candidates.includes(saved)) candidates.unshift(saved);
    for(const c of candidates){
      try{
        const r = await fetch(`${c}/status`,{signal:AbortSignal.timeout(3000)});
        if(r.ok){
          document.getElementById('setup-addr').value = c.replace('http://','');
          await connect(); return;
        }
      }catch(e){}
    }
    setMsg('No device found. Enter address manually.','color:var(--yellow)');
  }

  function setMsg(msg, style){
    const el = document.getElementById('conn-msg');
    el.textContent = msg; el.style.cssText = style||'';
  }

  function showConnScreen(){
    document.getElementById('conn-screen').style.display='flex';
    const saved = localStorage.getItem('ra_device');
    if(saved) document.getElementById('setup-addr').value = saved.replace('http://','');
  }

  function hidConnScreen(){
    document.getElementById('conn-screen').style.display='none';
  }

  // ── API helpers ───────────────────────────────────────────────────────
  async function api(path, opts={}){
    if(!_base) throw new Error('Not connected');
    const r = await fetch(_base+path, {signal:AbortSignal.timeout(8000), ...opts});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r;
  }
  async function apiJSON(path){ return (await api(path)).json(); }
  async function apiText(path){ return (await api(path)).text(); }
  async function apiPost(path, body){
    return api(path,{method:'POST', body});
  }

  function getBase(){ return _base; }
  function getStatus(){ return _status; }

  // ── Status polling ────────────────────────────────────────────────────
  function startPolling(){
    if(_pollTimer) clearInterval(_pollTimer);
    poll();
    _pollTimer = setInterval(poll, POLL_MS);
  }

  async function poll(){
    try {
      const d = await apiJSON('/status');
      _status = d;
      updateFromStatus(d);
      setConn(true);
    } catch(e){
      setConn(false);
    }
  }

  function updateFromStatus(d){
    // Header
    const cnt = d.activeAlerts||0;
    const ac = document.getElementById('active-count');
    ac.textContent = cnt;
    ac.style.display = cnt>0 ? 'inline-block' : 'none';
    document.getElementById('conn-lbl').textContent = d.ip||'';

    // Live map stats
    _s('stat-alerts', cnt);
    _s('stat-leds',   d.mapLeds||d.ledPin||'--');
    _s('stat-poll',   d.pollMsg ? d.pollMsg.substring(0,12) : '--');
    _s('stat-state',  (d.state||'--').toUpperCase());

    // Device tab stats
    _s('d-fw',      d.version||'--');
    _s('d-leds',    d.mapLeds||'--');
    _s('d-cities',  d.mapCities||'--');
    _s('d-fails',   d.pollCFails||0);

    // Alert banner
    const banner = document.getElementById('alert-banner');
    if(cnt>0){
      banner.style.display='block';
      banner.querySelector('#alert-banner-text').textContent =
        t(`${cnt} ALERT${cnt>1?'S':''} ACTIVE`, `${cnt} התראות פעילות`);
    } else {
      banner.style.display='none';
    }

    // Raw status
    const rs = document.getElementById('raw-status');
    if(rs) rs.textContent = JSON.stringify(d,null,2);

    // Notify live map
    LiveMap.update(d);

    // Notify scenes if loaded
    if(typeof Scenes !== 'undefined') Scenes.onStatus(d);
  }

  function _s(id,val){
    const el=document.getElementById(id); if(el) el.textContent=val;
  }

  function setConn(ok){
    const dot = document.getElementById('dot');
    dot.className = 'dot'+(ok?' on':' err');
  }

  // ── Navigation ────────────────────────────────────────────────────────
  let _activeTab = 'live';
  function showTab(id){
    _activeTab = id;
    document.querySelectorAll('.tab-panel').forEach(p=>{
      p.classList.toggle('active', p.id==='tab-'+id);
    });
    document.querySelectorAll('.tab-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.tab===id);
    });
    if(id==='history') History.refresh();
    if(id==='device')  Device.refreshSyslog();
    if(id==='scenes')  Scenes.load();
    if(id==='settings') Settings.loadFromStatus();
    if(id==='calibrator') Calib.onShow();
  }

  function toggleTheme(){
    THEME = THEME==='dark' ? 'light' : 'dark';
    localStorage.setItem('ra_theme', THEME);
    applyTheme();
  }
  function toggleLang(){
    LANG = LANG==='en' ? 'he' : 'en';
    localStorage.setItem('ra_lang', LANG);
    applyLang();
  }

  function clearAllAlerts(){
    api('/testall?mode=clear').catch(()=>{});
  }
  function toggleMapLabels(){
    _showLabels = !_showLabels;
    LiveMap.setLabels(_showLabels);
  }

  // Boot
  function init(){
    applyTheme(); applyLang();
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/sw.js').catch(()=>{});
    }
    const saved = localStorage.getItem('ra_device');
    if(saved){
      _base = saved;
      hidConnScreen();
      startPolling();
    } else {
      showConnScreen();
    }
  }

  return { connect, connectAuto, showConnScreen, showTab,
           toggleTheme, toggleLang, clearAllAlerts, toggleMapLabels,
           api, apiJSON, apiText, apiPost, getBase, getStatus, init };
})();

// ═══════════════════════════════════════════════════════════════════════════
// LiveMap — real-time LED overlay on the Israel SVG
// ═══════════════════════════════════════════════════════════════════════════
const LiveMap = (() => {
  let _cityLUT = [];   // [{heb,eng,lat,lon,led}] — built from calibrator CITIES + LUT
  let _ledDots = new Map(); // led# → SVG circle element
  let _labels  = false;
  let _lastStatus = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const THREAT_COLORS = [
    '#e81c2a','#ff6820','#ffd020','#00c8ff',
    '#00d878','#c8001e','#ff00c8','#e81c2a'
  ];

  function init(){
    // Inject LED overlay group into the map SVG
    const svg = document.getElementById('map-svg');
    if(!svg) return;
    let g = document.getElementById('led-overlay');
    if(!g){
      g = document.createElementNS(SVG_NS,'g');
      g.id = 'led-overlay';
      svg.appendChild(g);
    }
  }

  function buildLUT(cities, ledPositions){
    // ledPositions: array of {i, svgX, svgY} or null
    // cities: CITIES array from calibrator
    _cityLUT = cities.map(c => {
      const pos = ll2svg(c.lat, c.lon);
      return { heb:c.heb, eng:c.eng, lat:c.lat, lon:c.lon,
               svgX:pos.x, svgY:pos.y, led:-1 };
    });
  }

  function setLabels(v){ _labels = v; renderOverlay(_lastStatus); }

  function update(status){
    _lastStatus = status;
    renderOverlay(status);
    renderAlertList(status);
  }

  function renderOverlay(status){
    if(!status) return;
    const svg = document.getElementById('map-svg');
    if(!svg) return;
    let g = document.getElementById('led-overlay');
    if(!g){ init(); g=document.getElementById('led-overlay'); }
    g.innerHTML = '';

    // If we have a city LUT, draw LED positions
    if(_cityLUT.length === 0) {
      // No LUT yet — just show a note
      return;
    }

    _cityLUT.forEach(city => {
      if(city.led < 0) return;
      const active = isLedActive(status, city.led);
      if(!active && !_labels) return; // only draw lit LEDs unless labels on

      const c = document.createElementNS(SVG_NS,'circle');
      c.setAttribute('cx', city.svgX);
      c.setAttribute('cy', city.svgY);
      c.setAttribute('r',  active ? '4' : '2');
      const color = active ? getThreatColor(status, city.led) : 'rgba(255,255,255,0.15)';
      c.setAttribute('fill', color);
      if(active){
        c.setAttribute('stroke','rgba(255,255,255,0.6)');
        c.setAttribute('stroke-width','0.8');
        const title = document.createElementNS(SVG_NS,'title');
        title.textContent = city.eng + ' / ' + city.heb;
        c.appendChild(title);
      }
      g.appendChild(c);

      if(_labels && active){
        const txt = document.createElementNS(SVG_NS,'text');
        txt.setAttribute('x', city.svgX+5);
        txt.setAttribute('y', city.svgY+4);
        txt.setAttribute('font-size','5');
        txt.setAttribute('fill','rgba(255,255,255,0.85)');
        txt.textContent = LANG==='he' ? city.heb.split(' ')[0] : city.eng.split(' ')[0];
        g.appendChild(txt);
      }
    });
  }

  function isLedActive(status, led){
    // Status doesn't include per-LED detail — we infer from activeAlerts > 0
    // The ESP32 /status doesn't expose per-LED state; we rely on the calibrator
    // LUT matching city names. For a richer per-LED display we'd need a /leds endpoint.
    // For now: if status.activeAlerts > 0 we highlight LEDs that match active cities.
    return false; // placeholder — full implementation uses city name matching below
  }

  function getThreatColor(status, led){
    return THREAT_COLORS[0];
  }

  function renderAlertList(status){
    const el = document.getElementById('alert-list');
    if(!el) return;
    if(!status || status.activeAlerts === 0){
      el.innerHTML = `<div style="font-size:11px;color:var(--txt3)">${t('No active alerts','אין התראות פעילות')}</div>`;
      return;
    }
    el.innerHTML = `<div style="font-size:11px;color:var(--red)">${status.activeAlerts} ${t('alert(s) active — see system log for city names','התראות פעילות')}</div>`;
  }

  function setCityLUT(lut){ _cityLUT = lut; }

  return { init, update, setLabels, setCityLUT, buildLUT };
})();

// ═══════════════════════════════════════════════════════════════════════════
// Scenes — idle animation + threat colors + presets
// ═══════════════════════════════════════════════════════════════════════════
const Scenes = (() => {
  const THREAT_NAMES = [
    ['Rockets / Missiles','טילים / רקטות'],
    ['UAV / Drone','כטב"מ / רחפן'],
    ['Earthquake','רעידת אדמה'],
    ['Tsunami','צונאמי'],
    ['Hazmat / Chemical','חומרים מסוכנים'],
    ['Infiltration','חדירה'],
    ['Radiological','רדיולוגי'],
    ['Unknown','לא ידוע'],
  ];
  const DEFAULTS = [
    '#ff0000','#ff7800','#ffdc00','#00c8ff',
    '#00d200','#c8001e','#ff00c8','#ff0000'
  ];
  let _colors = [...DEFAULTS];
  let _animMode = 0;
  let _loaded = false;

  async function load(){
    if(_loaded) return;
    try {
      const d = await App.apiJSON('/scenes');
      _animMode = d.idleAnimMode || 0;
      if(d.threatColors) _colors = d.threatColors;
      _loaded = true;
    } catch(e) {}
    render();
  }

  function onStatus(d){
    if(d.idleAnimMode !== undefined) _animMode = d.idleAnimMode;
  }

  function render(){
    renderAnimGrid();
    renderThreatGrid();
    renderPresets();
  }

  function renderAnimGrid(){
    for(let i=0;i<5;i++){
      const el = document.getElementById('anim-'+i);
      if(el) el.classList.toggle('active-scene', i===_animMode);
    }
  }

  function renderThreatGrid(){
    const g = document.getElementById('threat-grid');
    if(!g) return;
    g.innerHTML = '';
    THREAT_NAMES.forEach(([en,he],i)=>{
      const div = document.createElement('div');
      div.className = 'threat-item';
      const swatch = document.createElement('div');
      swatch.className = 'threat-swatch';
      swatch.style.background = _colors[i]||'#ff0000';
      swatch.title = t(en,he);
      // Click swatch to open color picker
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = _colors[i]||'#ff0000';
      picker.style.cssText = 'position:absolute;opacity:0;width:0;height:0';
      picker.addEventListener('input', e=>{
        _colors[i] = e.target.value;
        swatch.style.background = e.target.value;
      });
      swatch.addEventListener('click', ()=>picker.click());
      const name = document.createElement('div');
      name.className = 'threat-name';
      name.textContent = t(en,he);
      div.appendChild(swatch);
      div.appendChild(picker);
      div.appendChild(name);
      g.appendChild(div);
    });
  }

  function renderPresets(){
    const g = document.getElementById('preset-grid');
    if(!g) return;
    const stored = JSON.parse(localStorage.getItem('ra_presets')||'[]');
    const builtIn = [
      {name:t('Default','ברירת מחדל'),    colors:[...DEFAULTS], anim:0},
      {name:t('Night Mode','מצב לילה'),   colors:DEFAULTS.map(()=>'#220044'), anim:1},
      {name:t('Shabbat','שבת'),           colors:DEFAULTS.map(()=>'#ffffff'), anim:3},
      {name:t('Off (idle)','כבוי בהמתנה'),colors:[...DEFAULTS], anim:4},
    ];
    const all = [...builtIn, ...stored];
    g.innerHTML = '';
    all.forEach(p=>{
      const card = document.createElement('div');
      card.className = 'scene-card';
      card.innerHTML = `<div class="scene-name">${p.name}</div><div class="scene-desc">${t('Tap to apply','לחץ להחיל')}</div>`;
      card.addEventListener('click',()=>applyPreset(p));
      g.appendChild(card);
    });
  }

  async function applyPreset(p){
    _colors = [...p.colors];
    _animMode = p.anim;
    await saveThreatColors();
    renderAnimGrid();
    renderThreatGrid();
  }

  async function setAnim(mode){
    _animMode = mode;
    renderAnimGrid();
    try {
      const fd = new FormData();
      fd.append('idleAnimMode', mode);
      await App.apiPost('/scenes', fd);
    } catch(e){}
  }

  async function saveThreatColors(){
    try {
      const fd = new FormData();
      fd.append('idleAnimMode', _animMode);
      _colors.forEach((c,i) => fd.append('tc'+i, c));
      await App.apiPost('/scenes', fd);
    } catch(e){ alert(t('Save failed: ','שמירה נכשלה: ')+e.message); }
  }

  function resetThreatColors(){
    _colors = [...DEFAULTS];
    renderThreatGrid();
    saveThreatColors();
  }

  function savePreset(){
    const name = prompt(t('Preset name:','שם פריסה:'));
    if(!name) return;
    const stored = JSON.parse(localStorage.getItem('ra_presets')||'[]');
    stored.push({name, colors:[..._colors], anim:_animMode});
    localStorage.setItem('ra_presets', JSON.stringify(stored));
    renderPresets();
  }

  return { load, onStatus, setAnim, saveThreatColors, resetThreatColors, savePreset };
})();

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════
const Settings = (() => {
  let _brightMode = 2;
  let _uiTheme = 2;

  function showSection(id){
    document.querySelectorAll('#tab-settings .inner-panel').forEach(p=>{
      p.classList.toggle('active', p.id==='sec-'+id);
    });
    document.querySelectorAll('#tab-settings .inner-tab').forEach((t,i)=>{
      const ids=['polling','brightness','colors','hardware','solid'];
      t.classList.toggle('active', ids[i]===id);
    });
    if(id==='solid') loadSolid();
  }

  function loadFromStatus(){
    const d = App.getStatus();
    if(!d) return;
    _set('s-poll',    d.pollInterval);
    _set('s-dur',     d.alertDur);
    _set('s-blink',   d.blinkSpeed);
    _setv('s-poll-v', d.pollInterval);
    _setv('s-dur-v',  d.alertDur);
    _setv('s-blink-v',d.blinkSpeed);
    _set('s-bri-day',  d.sysBri);
    _set('s-bri-night',d.nightBri);
    _set('s-bri-idle', d.idleBri);
    _setv('s-bri-day-v',  d.sysBri);
    _setv('s-bri-night-v',d.nightBri);
    _setv('s-bri-idle-v', d.idleBri);
    _set('s-idle-color', d.idleColor);
    _set('s-disc-color', d.discColor);
    _setv('s-idle-hex',  d.idleColor);
    _setv('s-disc-hex',  d.discColor);
    _set('s-led-pin',    d.ledPin);
    _set('s-notif-pin',  d.notifPin);
    _set('s-notif-leds', d.notifLeds);
    _set('s-speaker-pin',d.speakerPin);
    const spk = document.getElementById('s-speaker-en');
    if(spk) spk.checked = !!d.speakerEnabled;
    if(d.nightStartMin!=null) _set('s-night-start', minToHM(d.nightStartMin));
    if(d.nightEndMin!=null)   _set('s-night-end',   minToHM(d.nightEndMin));
    if(d.uiNightStartMin!=null) _set('s-ui-night-start', minToHM(d.uiNightStartMin));
    if(d.uiNightEndMin!=null)   _set('s-ui-night-end',   minToHM(d.uiNightEndMin));
    setBrightMode(d.brightMode ?? 2);
    setUiTheme(d.uiTheme ?? 2);
    _set('s-ssid', d.ssid||'');
  }

  function _set(id,v){ const e=document.getElementById(id); if(e&&v!=null) e.value=v; }
  function _setv(id,v){ const e=document.getElementById(id); if(e&&v!=null) e.textContent=v; }
  function minToHM(m){ const h=Math.floor(m/60),mn=m%60; return String(h).padStart(2,'0')+':'+String(mn).padStart(2,'0'); }

  function setBrightMode(m){
    _brightMode = m;
    for(let i=0;i<3;i++){const b=document.getElementById('bm-'+i);if(b)b.classList.toggle('active',i===m);}
    const nh = document.getElementById('auto-hours-bri');
    if(nh) nh.style.display = m===2?'block':'none';
  }
  function setUiTheme(m){
    _uiTheme = m;
    for(let i=0;i<3;i++){const b=document.getElementById('utm-'+i);if(b)b.classList.toggle('active',i===m);}
    const nh = document.getElementById('auto-hours-ui');
    if(nh) nh.style.display = m===2?'block':'none';
  }

  async function _postSettings(data){
    const fd = new FormData();
    fd.append('action','settings');
    Object.entries(data).forEach(([k,v])=>fd.append(k,v));
    const r = await App.apiPost('/save', fd);
    const txt = await r.text();
    return txt;
  }

  async function savePolling(){
    try {
      const msg = await _postSettings({
        pollInt:  document.getElementById('s-poll').value,
        alertDur: document.getElementById('s-dur').value,
        blinkSpd: document.getElementById('s-blink').value,
      });
      alert(msg);
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function saveBrightness(){
    try {
      const msg = await _postSettings({
        sysBri:    document.getElementById('s-bri-day').value,
        nightBri:  document.getElementById('s-bri-night').value,
        idleBri:   document.getElementById('s-bri-idle').value,
        brightMode:_brightMode,
        nightStart:document.getElementById('s-night-start').value,
        nightEnd:  document.getElementById('s-night-end').value,
      });
      alert(msg);
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function saveUiTheme(){
    try {
      const msg = await _postSettings({
        uiTheme:      _uiTheme,
        uiNightStart: document.getElementById('s-ui-night-start').value,
        uiNightEnd:   document.getElementById('s-ui-night-end').value,
      });
      alert(msg);
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function saveColors(){
    try {
      const msg = await _postSettings({
        idleColor: document.getElementById('s-idle-color').value,
        discColor: document.getElementById('s-disc-color').value,
      });
      alert(msg);
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function saveHardware(){
    try {
      const msg = await _postSettings({
        ledPin:     document.getElementById('s-led-pin').value,
        notifPin:   document.getElementById('s-notif-pin').value,
        notifLeds:  document.getElementById('s-notif-leds').value,
        speakerPin: document.getElementById('s-speaker-pin').value,
        speakerOn:  document.getElementById('s-speaker-en').checked ? '1' : '0',
      });
      alert(msg);
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function saveWifi(){
    try {
      const fd = new FormData();
      fd.append('action','wifi');
      fd.append('ssid', document.getElementById('s-ssid').value);
      fd.append('pass', document.getElementById('s-pass').value);
      const r = await App.apiPost('/save', fd);
      alert(await r.text());
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  // Solid cities
  async function loadSolid(){
    try {
      const d = await App.apiJSON('/solidcities');
      renderSolidChips(d.cities||[]);
    } catch(e){}
  }

  function renderSolidChips(list){
    const el = document.getElementById('solid-chips');
    if(!el) return;
    el.innerHTML = '';
    list.forEach(c=>{
      const chip = document.createElement('div');
      chip.style.cssText='background:var(--bg3);border:1px solid var(--bdr2);border-radius:20px;padding:4px 10px;font-size:12px;display:flex;align-items:center;gap:6px';
      chip.innerHTML = `<span>${c}</span><span style="cursor:pointer;color:var(--red);font-weight:700" onclick="Settings.removeSolid('${c.replace(/'/g,"\\'")}')">×</span>`;
      el.appendChild(chip);
    });
    if(!list.length) el.innerHTML = `<span style="font-size:11px;color:var(--txt3)">${t('No cities added','לא נוספו ערים')}</span>`;
  }

  async function addSolid(){
    const heb = document.getElementById('solid-heb').value;
    if(!heb){ alert(t('Select a city first','בחר עיר תחילה')); return; }
    try {
      const fd = new FormData();
      fd.append('action','add'); fd.append('heb',heb);
      const r = await App.apiPost('/solidcities',fd);
      const d = await r.json();
      alert(d.msg||'');
      if(d.ok){ loadSolid(); document.getElementById('solid-search').value=''; document.getElementById('solid-heb').value=''; }
    } catch(e){ alert(t('Error: ','שגיאה: ')+e.message); }
  }

  async function removeSolid(heb){
    const fd = new FormData();
    fd.append('action','remove'); fd.append('heb',heb);
    await App.apiPost('/solidcities',fd).catch(()=>{});
    loadSolid();
  }

  function solidSearch(q){
    const drop = document.getElementById('solid-drop');
    if(!q){ drop.style.display='none'; return; }
    App.apiJSON('/cities?q='+encodeURIComponent(q)).then(d=>{
      drop.innerHTML='';
      if(!d.length){ drop.style.display='none'; return; }
      d.forEach(c=>{
        const item=document.createElement('div');
        item.style.cssText='padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--bdr)';
        item.innerHTML=`<strong>${c.e}</strong> <span style="color:var(--txt3);font-size:11px">${c.h}</span>`;
        item.addEventListener('mousedown',()=>{
          document.getElementById('solid-search').value=c.e;
          document.getElementById('solid-heb').value=c.h;
          drop.style.display='none';
        });
        drop.appendChild(item);
      });
      drop.style.display='block';
    }).catch(()=>{ drop.style.display='none'; });
  }

  return { showSection, loadFromStatus, setBrightMode, setUiTheme,
           savePolling, saveBrightness, saveUiTheme, saveColors, saveHardware,
           saveWifi, addSolid, removeSolid, solidSearch };
})();

// ═══════════════════════════════════════════════════════════════════════════
// History — alert log parsing, charts, stats
// ═══════════════════════════════════════════════════════════════════════════
const History = (() => {
  function parseLog(text){
    const lines = text.split('\n').filter(l=>l.trim());
    const entries = [];
    lines.forEach(l=>{
      // Format: [HH:MM:SS] LED=N  threat=N TypeName  CityName
      const m = l.match(/LED=(\d+)\s+threat=(\d+)\s+(\w+)\s+(.*)/);
      if(m) entries.push({led:+m[1],threat:+m[2],type:m[3].trim(),city:m[4].trim(),raw:l});
    });
    return entries;
  }

  async function refresh(){
    try {
      const txt = await App.apiText('/log');
      const box = document.getElementById('alert-log-box');
      if(box){
        box.innerHTML='';
        txt.split('\n').filter(l=>l.trim()).reverse().forEach(line=>{
          const d=document.createElement('div');
          d.className='log-line log-err';
          d.textContent=line;
          box.appendChild(d);
        });
        box.scrollTop=0;
      }
      const entries = parseLog(txt);
      updateStats(entries);
      drawTimeline(entries);
      drawCityBars(entries);
      drawThreatBars(entries);
    } catch(e){
      const box=document.getElementById('alert-log-box');
      if(box) box.textContent=t('Could not load log','לא ניתן לטעון יומן');
    }
  }

  function updateStats(entries){
    document.getElementById('h-total').textContent = entries.length;
    const cities = new Set(entries.map(e=>e.city));
    document.getElementById('h-cities').textContent = cities.size;
    // Most frequent city
    const freq={};
    entries.forEach(e=>{ freq[e.city]=(freq[e.city]||0)+1; });
    const top = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];
    const el = document.getElementById('h-top');
    if(el) el.textContent = top ? top[0].split(',')[0].substring(0,12) : '--';
  }

  function drawTimeline(entries){
    const canvas = document.getElementById('canvas-timeline');
    if(!canvas) return;
    const w=canvas.offsetWidth||300, h=120;
    canvas.width=w; canvas.height=h;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='rgba(0,0,0,0.3)';
    ctx.fillRect(0,0,w,h);
    const last50 = entries.slice(-50);
    if(!last50.length){ ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.font='11px monospace'; ctx.textAlign='center'; ctx.fillText(t('No data','אין נתונים'),w/2,h/2); return; }
    const bw = Math.max(2,(w-20)/last50.length-1);
    const COLORS=['#e81c2a','#ff6820','#ffd020','#00c8ff','#00d878','#c8001e','#ff00c8','#e81c2a'];
    last50.forEach((e,i)=>{
      const x=10+i*(bw+1);
      ctx.fillStyle=COLORS[e.threat]||'#e81c2a';
      ctx.fillRect(x,10,bw,h-20);
    });
  }

  function drawCityBars(entries){
    const el=document.getElementById('bar-cities'); if(!el) return;
    const freq={};
    entries.forEach(e=>{ freq[e.city]=(freq[e.city]||0)+1; });
    const top10=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10);
    if(!top10.length){ el.textContent=t('No data','אין נתונים'); return; }
    const max=top10[0][1];
    el.innerHTML=top10.map(([city,cnt])=>`
      <div style="margin-bottom:5px">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:2px">${city.substring(0,24)}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="background:var(--red);height:6px;border-radius:3px;width:${Math.round(cnt/max*100)}%"></div>
          <span style="font-size:10px;color:var(--txt3)">${cnt}</span>
        </div>
      </div>`).join('');
  }

  function drawThreatBars(entries){
    const el=document.getElementById('bar-threats'); if(!el) return;
    const NAMES=[t('Rockets','טילים'),t('UAV','כטב"מ'),t('Earthquake','רעש'),t('Tsunami','צונאמי'),t('Hazmat','חומ"ס'),t('Infiltration','חדירה'),t('Radiological','רדיו'),t('Unknown','לא ידוע')];
    const freq={};
    entries.forEach(e=>{ freq[e.threat]=(freq[e.threat]||0)+1; });
    const items=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
    if(!items.length){ el.textContent=t('No data','אין נתונים'); return; }
    const max=items[0][1];
    el.innerHTML=items.map(([t2,cnt])=>`
      <div style="margin-bottom:5px">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:2px">${NAMES[+t2]||t2}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="background:var(--orange);height:6px;border-radius:3px;width:${Math.round(cnt/max*100)}%"></div>
          <span style="font-size:10px;color:var(--txt3)">${cnt}</span>
        </div>
      </div>`).join('');
  }

  async function clear(){
    if(!confirm(t('Clear alert log?','למחוק יומן התראות?'))) return;
    await App.api('/clearalertlog').catch(()=>{});
    refresh();
  }

  return { refresh, clear };
})();

// ═══════════════════════════════════════════════════════════════════════════
// Device — map upload, OTA, syslog
// ═══════════════════════════════════════════════════════════════════════════
const Device = (() => {
  async function uploadMap(){
    const f=document.getElementById('map-file').files[0];
    if(!f){ alert(t('Select a JSON file first','בחר קובץ JSON תחילה')); return; }
    const fd=new FormData(); fd.append('file',f);
    document.getElementById('map-result').textContent=t('Uploading…','מעלה…');
    try {
      const r=await App.apiPost('/uploadmap',fd);
      document.getElementById('map-result').textContent=await r.text();
    } catch(e){ document.getElementById('map-result').textContent=t('Error: ','שגיאה: ')+e.message; }
  }

  async function deleteMap(){
    if(!confirm(t('Delete city map?','למחוק מפת ערים?'))) return;
    try { await App.api('/deletemap'); document.getElementById('map-result').textContent=t('Map deleted','המפה נמחקה'); }
    catch(e){ document.getElementById('map-result').textContent=t('Error: ','שגיאה: ')+e.message; }
  }

  async function uploadOTA(){
    const f=document.getElementById('ota-file').files[0];
    if(!f){ alert(t('Select a .bin file','בחר קובץ .bin')); return; }
    const fd=new FormData(); fd.append('file',f);
    document.getElementById('ota-bar-wrap').style.display='block';
    document.getElementById('ota-result').textContent=t('Uploading…','מעלה…');
    const xhr=new XMLHttpRequest();
    xhr.open('POST', App.getBase()+'/ota');
    xhr.upload.onprogress=e=>{ if(e.lengthComputable) document.getElementById('ota-fill').style.width=Math.round(e.loaded/e.total*100)+'%'; };
    xhr.onload=()=>document.getElementById('ota-result').textContent=xhr.responseText;
    xhr.onerror=()=>document.getElementById('ota-result').textContent=t('Upload error','שגיאת העלאה');
    xhr.send(fd);
  }

  async function refreshSyslog(){
    try {
      const txt=await App.apiText('/syslog');
      const box=document.getElementById('syslog-box');
      if(box){
        box.innerHTML='';
        txt.split('\n').filter(l=>l.trim()).reverse().forEach(line=>{
          const d=document.createElement('div');
          d.className='log-line '+(line.includes('MISS')||line.includes('err')||line.includes('CRASH')?'log-err':'log-inf');
          d.textContent=line;
          box.appendChild(d);
        });
      }
    } catch(e){}
  }

  async function clearSyslog(){
    if(!confirm(t('Clear system log?','למחוק יומן מערכת?'))) return;
    await App.api('/clearsyslog').catch(()=>{});
    refreshSyslog();
  }

  return { uploadMap, deleteMap, uploadOTA, refreshSyslog, clearSyslog };
})();

// ═══════════════════════════════════════════════════════════════════════════
// Calib — full calibrator (port of redalert_map_calibrator_Best.html)
// All canvas, homography, detect, snake, send logic
// ═══════════════════════════════════════════════════════════════════════════
const Calib = (() => {
  // ── State ──────────────────────────────────────────────────────────────
  let photoImg=null, photoW=0, photoH=0;
  const PIN_COLORS=['#e81c2a','#00d878','#2488ff','#ffd020'];
  let svgPins=[ll2svg(33.09,35.10),ll2svg(33.27,35.78),ll2svg(29.56,34.95),ll2svg(31.21,34.22)];
  let photoPins=[{x:80,y:80},{x:620,y:80},{x:620,y:540},{x:80,y:540}];
  let H_photo2svg=null, H_svg2photo=null;
  let detectedLeds=[];
  let snakeOrder=[], snakeHistory=[], snakeStep=0;
  let recalibStartWireIdx=-1;
  let editMode='add';
  let dragLedIdx=-1;
  let dragPinData=null;
  let popupTargetLed=-1;
  let payload=null;
  let _stage=1;

  // ── Stage navigation ──────────────────────────────────────────────────
  function showStage(n){
    _stage=n;
    for(let i=1;i<=6;i++){
      const p=document.getElementById('cs'+i);
      const t=document.getElementById('ctab-'+i);
      if(p) p.classList.toggle('active',i===n);
      if(t) t.classList.toggle('active',i===n);
    }
    if(n===2){initAlignCanvas();renderAlign();}
    if(n===3){syncDetectCanvas();renderDetect();initDetectHandlersOnce();}
    if(n===4){syncNumberCanvas();renderNumber();updateSnakeStats();}
    if(n===5){buildPayload();}
    if(n===6){dbFilter();}
  }

  function onShow(){
    // Populate reference SVG
    const refPaths=document.getElementById('calib-ref-paths');
    const srcSvg=document.getElementById('map-svg');
    if(refPaths && srcSvg && !refPaths.children.length){
      srcSvg.querySelectorAll('path[id]').forEach(p=>{
        const clone=p.cloneNode(true);
        refPaths.appendChild(clone);
      });
    }
    updateCityCount();
    initPhotoHandlers();
  }

  function initPhotoHandlers(){
    const inp=document.getElementById('calib-file');
    if(inp && !inp._bound){
      inp._bound=true;
      inp.addEventListener('change',e=>loadPhoto(e.target.files[0]));
    }
    const drop=document.getElementById('calib-drop');
    if(drop && !drop._bound){
      drop._bound=true;
      drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});
      drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
      drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])loadPhoto(e.dataTransfer.files[0]);});
    }
  }

  function updateCityCount(){
    const n=typeof CITIES!=='undefined'?CITIES.length:0;
    ['calib-city-count','db-count'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=n;});
    refreshCityDots();
  }

  function refreshCityDots(){
    const g=document.getElementById('calib-city-dots');
    if(!g||typeof CITIES==='undefined') return;
    g.innerHTML='';
    const NS='http://www.w3.org/2000/svg';
    CITIES.forEach(city=>{
      const p=ll2svg(city.lat,city.lon);
      const c=document.createElementNS(NS,'circle');
      c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r','1.8');
      c.setAttribute('fill','rgba(232,28,42,0.7)');c.setAttribute('stroke','none');
      const tl=document.createElementNS(NS,'title');
      tl.textContent=city.eng+' / '+city.heb;c.appendChild(tl);
      g.appendChild(c);
    });
  }

  // ── Photo load ────────────────────────────────────────────────────────
  function loadPhoto(file){
    if(!file) return;
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      photoImg=img;photoW=img.naturalWidth;photoH=img.naturalHeight;
      const thumb=document.getElementById('calib-thumb');
      const wrap=document.getElementById('calib-thumb-wrap');
      if(thumb){thumb.src=url;}
      if(wrap)wrap.style.display='block';
      const btn=document.getElementById('btn-to-align');
      if(btn)btn.disabled=false;
      photoPins=[
        {x:photoW*0.05,y:photoH*0.05},{x:photoW*0.95,y:photoH*0.05},
        {x:photoW*0.95,y:photoH*0.95},{x:photoW*0.05,y:photoH*0.95}
      ];
      updateHomography();
    };
    img.src=url;
  }

  // ── Homography ────────────────────────────────────────────────────────
  function updateHomography(){
    if(!photoImg)return;
    H_photo2svg=computeH(photoPins.map(p=>({x:p.x,y:p.y})),svgPins.map(p=>({x:p.x,y:p.y})));
    H_svg2photo=computeH(svgPins.map(p=>({x:p.x,y:p.y})),photoPins.map(p=>({x:p.x,y:p.y})));
  }

  function resetAlignPins(){
    if(!photoImg)return;
    photoPins=[
      {x:photoW*0.05,y:photoH*0.05},{x:photoW*0.95,y:photoH*0.05},
      {x:photoW*0.95,y:photoH*0.95},{x:photoW*0.05,y:photoH*0.95}
    ];
    updateHomography(); renderAlign();
  }

  // ── Align canvas ──────────────────────────────────────────────────────
  function initAlignCanvas(){
    const c=document.getElementById('align-canvas');
    if(!c||!photoImg)return;
    const wrap=c.parentElement;
    const W=Math.min(wrap.clientWidth-16,1200);
    const H=Math.min(Math.round(W*photoH/photoW),Math.round(window.innerHeight*0.6));
    c.width=W; c.height=H;
    updateHomography();
    if(!c._pinDragBound){c._pinDragBound=true;initPinDrag(c);}
  }

  function renderAlign(){
    const c=document.getElementById('align-canvas');
    if(!c)return;
    const ctx=c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.fillStyle='#050809';ctx.fillRect(0,0,c.width,c.height);
    if(!photoImg){ctx.fillStyle='rgba(255,208,32,0.7)';ctx.font='13px monospace';ctx.textAlign='center';ctx.fillText('Upload a photo first',c.width/2,c.height/2);return;}
    ctx.drawImage(photoImg,0,0,c.width,c.height);
    if(document.getElementById('show-warp')?.checked&&H_svg2photo){
      drawWarpOverlay(ctx,c.width,c.height);
    }
    const px=photoPins.map(p=>p.x/photoW*c.width);
    const py=photoPins.map(p=>p.y/photoH*c.height);
    ctx.save();ctx.beginPath();
    ctx.moveTo(px[0],py[0]);ctx.lineTo(px[1],py[1]);ctx.lineTo(px[2],py[2]);ctx.lineTo(px[3],py[3]);
    ctx.closePath();ctx.strokeStyle='rgba(232,28,42,0.85)';ctx.lineWidth=2;ctx.setLineDash([8,5]);ctx.stroke();ctx.setLineDash([]);ctx.restore();
    const LABELS=['NW','NE','SE','SW'],SUBS=['Rosh HaNikra','Golan NE','Eilat','Gaza SW'];
    photoPins.forEach((pin,i)=>{
      const x=px[i],y=py[i],R=20;
      ctx.beginPath();ctx.arc(x,y,R,0,Math.PI*2);ctx.fillStyle='rgba(232,28,42,0.25)';ctx.fill();
      ctx.strokeStyle='#e81c2a';ctx.lineWidth=2;ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-12,y);ctx.lineTo(x+12,y);ctx.moveTo(x,y-12);ctx.lineTo(x,y+12);
      ctx.strokeStyle='rgba(255,255,255,0.8)';ctx.lineWidth=1.5;ctx.stroke();
      ctx.font='bold 10px monospace';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.strokeStyle='rgba(0,0,0,0.9)';ctx.lineWidth=3;ctx.strokeText(LABELS[i],x,y);
      ctx.fillStyle='#fff';ctx.fillText(LABELS[i],x,y);
      const lblY=(i<2)?y+R+12:y-R-4;
      ctx.font='8px monospace';ctx.fillStyle='rgba(232,28,42,0.9)';
      ctx.strokeStyle='rgba(0,0,0,0.8)';ctx.lineWidth=2.5;
      ctx.strokeText(SUBS[i],x,lblY);ctx.fillText(SUBS[i],x,lblY);
    });
  }

  function drawWarpOverlay(ctx,cw,ch){
    if(!H_svg2photo)return;
    const svgEl=document.getElementById('map-svg');if(!svgEl)return;
    svgEl.querySelectorAll('path[id]').forEach(pathEl=>{
      const L=pathEl.getTotalLength(),steps=Math.ceil(L/3);
      ctx.beginPath();
      for(let i=0;i<=steps;i++){
        const pt=pathEl.getPointAtLength((i/steps)*L);
        const pp=applyH(H_svg2photo,pt.x,pt.y);
        const cx=pp.x/photoW*cw,cy=pp.y/photoH*ch;
        if(i===0)ctx.moveTo(cx,cy);else ctx.lineTo(cx,cy);
      }
      ctx.closePath();
      ctx.fillStyle='rgba(60,140,220,0.05)';ctx.fill();
      ctx.strokeStyle='rgba(60,180,255,0.8)';ctx.lineWidth=1.5;ctx.stroke();
    });
  }

  function initPinDrag(ac){
    const HIT=28;
    function ep(e){return e.touches?e.touches[0]:e;}
    function pinHit(cx,cy){
      let best=-1,bestD=HIT;
      photoPins.forEach((pin,i)=>{
        const px=pin.x/photoW*ac.width,py=pin.y/photoH*ac.height;
        const d=Math.hypot(cx-px,cy-py);if(d<bestD){bestD=d;best=i;}
      });return best;
    }
    function getPos(e){const r=ac.getBoundingClientRect(),src=ep(e);return{x:(src.clientX-r.left)*ac.width/r.width,y:(src.clientY-r.top)*ac.height/r.height};}
    ac.addEventListener('mousedown',e=>{if(e.button!==0)return;const p=getPos(e);const h=pinHit(p.x,p.y);if(h>=0){dragPinData={i:h};ac.style.cursor='grabbing';e.preventDefault();}});
    ac.addEventListener('touchstart',e=>{const p=getPos(ep(e));const h=pinHit(p.x,p.y);if(h>=0){dragPinData={i:h};e.preventDefault();}},{passive:false});
    function onMove(e){if(!dragPinData)return;e.preventDefault();const p=getPos(ep(e));photoPins[dragPinData.i]={x:Math.max(0,Math.min(photoW,p.x/ac.width*photoW)),y:Math.max(0,Math.min(photoH,p.y/ac.height*photoH))};updateHomography();renderAlign();}
    function onUp(){dragPinData=null;ac.style.cursor='crosshair';}
    document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
    document.addEventListener('touchmove',e=>{if(dragPinData){e.preventDefault();onMove(e);}},{passive:false});
    document.addEventListener('touchend',onUp);
  }

  // ── Detect canvas ─────────────────────────────────────────────────────
  function syncDetectCanvas(){
    const c=document.getElementById('detect-canvas');if(!c||!photoImg)return;
    const wrap=c.parentElement,W=Math.min(wrap.clientWidth-16,1200);
    const H=Math.min(Math.round(W*photoH/photoW),Math.round(window.innerHeight*0.6));
    c.width=W;c.height=H;
  }

  function renderDetect(){
    const c=document.getElementById('detect-canvas');if(!c)return;
    const ctx=c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.fillStyle='#050809';ctx.fillRect(0,0,c.width,c.height);
    if(!photoImg){ctx.fillStyle='rgba(255,208,32,0.7)';ctx.font='13px monospace';ctx.textAlign='center';ctx.fillText('Upload a photo first',c.width/2,c.height/2);return;}
    ctx.drawImage(photoImg,0,0,c.width,c.height);
    const R=getLedR();
    detectedLeds.forEach(led=>{
      const cx=led.x/photoW*c.width,cy=led.y/photoH*c.height;
      ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);
      ctx.fillStyle='rgba(232,28,42,0.35)';ctx.fill();
      ctx.strokeStyle='#e81c2a';ctx.lineWidth=1.5;ctx.stroke();
    });
    const el=document.getElementById('detect-count');
    if(el) el.textContent=detectedLeds.length+' LEDs';
  }

  function getLedR(){return parseInt(document.getElementById('sl-led-size')?.value)||10;}

  function updateThresh(v){document.getElementById('thresh-val').textContent=v;autoDetect();}
  function updateLedSize(v){document.getElementById('led-size-val').textContent=v;renderDetect();}
  function updateMinDist(v){document.getElementById('min-dist-val').textContent=v;autoDetect();}

  function autoDetect(){
    if(!photoImg)return;
    const thresh=parseInt(document.getElementById('sl-thresh')?.value)||140;
    const minDist=parseInt(document.getElementById('sl-min-dist')?.value)||15;
    const offscreen=new OffscreenCanvas(photoW,photoH);
    const ctx=offscreen.getContext('2d');
    ctx.drawImage(photoImg,0,0);
    const imgd=ctx.getImageData(0,0,photoW,photoH);
    const data=imgd.data;
    const candidates=[];
    for(let y=2;y<photoH-2;y+=2){
      for(let x=2;x<photoW-2;x+=2){
        const i=(y*photoW+x)*4;
        const r=data[i],g=data[i+1],b=data[i+2];
        const bright=(r+g+b)/3;
        if(bright>thresh) candidates.push({x,y,bright});
      }
    }
    // Non-maximum suppression
    candidates.sort((a,b)=>b.bright-a.bright);
    const leds=[];
    const used=new Set();
    candidates.forEach(c=>{
      const key=Math.round(c.x/minDist)+'_'+Math.round(c.y/minDist);
      if(!used.has(key)){used.add(key);leds.push({x:c.x,y:c.y});}
    });
    detectedLeds=leds.slice(0,512);
    snakeOrder=[]; snakeStep=0; recalibStartWireIdx=-1;
    renderDetect();
    const btn=document.getElementById('btn-auto-snake');
    if(btn) btn.disabled=(detectedLeds.length<2);
  }

  let _detectHandlersDone=false;
  function initDetectHandlersOnce(){
    if(_detectHandlersDone)return;_detectHandlersDone=true;
    const c=document.getElementById('detect-canvas');if(!c)return;
    c.addEventListener('click',onDetectClick);
    c.addEventListener('mousedown',onDetectMouseDown);
    document.addEventListener('mousemove',onDetectMouseMove);
    document.addEventListener('mouseup',onDetectMouseUp);
  }

  function onDetectClick(e){
    if(editMode==='move')return;
    const p=getCanvasPos(e,'detect-canvas');
    const R=getLedR()*1.5;
    let best=-1,bestD=R;
    detectedLeds.forEach((led,i)=>{
      const cx=led.x/photoW*document.getElementById('detect-canvas').width;
      const cy=led.y/photoH*document.getElementById('detect-canvas').height;
      const d=Math.hypot(p.x-cx,p.y-cy);if(d<bestD){bestD=d;best=i;}
    });
    if(editMode==='remove'&&best>=0){detectedLeds.splice(best,1);}
    else if(editMode==='add'){
      const c=document.getElementById('detect-canvas');
      const px=p.x/c.width*photoW,py=p.y/c.height*photoH;
      detectedLeds.push({x:px,y:py});
    }
    renderDetect();
  }

  function onDetectMouseDown(e){
    if(editMode!=='move')return;
    const p=getCanvasPos(e,'detect-canvas'),R=getLedR()*1.5;
    let best=-1,bestD=R;
    detectedLeds.forEach((led,i)=>{
      const cx=led.x/photoW*document.getElementById('detect-canvas').width;
      const cy=led.y/photoH*document.getElementById('detect-canvas').height;
      const d=Math.hypot(p.x-cx,p.y-cy);if(d<bestD){bestD=d;best=i;}
    });
    if(best>=0) dragLedIdx=best;
  }
  function onDetectMouseMove(e){
    if(dragLedIdx<0)return;
    const p=getCanvasPos(e,'detect-canvas');
    const c=document.getElementById('detect-canvas');
    detectedLeds[dragLedIdx]={x:p.x/c.width*photoW,y:p.y/c.height*photoH};
    renderDetect();
  }
  function onDetectMouseUp(){ dragLedIdx=-1; }

  function setEditMode(m){
    editMode=m;
    ['add','remove','move'].forEach(id=>{
      const b=document.getElementById('edit-'+id);if(b)b.classList.toggle('active',id===m);
    });
  }

  // ── Number canvas ─────────────────────────────────────────────────────
  function syncNumberCanvas(){
    const c=document.getElementById('number-canvas');if(!c||!photoImg)return;
    const wrap=c.parentElement,W=Math.min(wrap.clientWidth-16,1200);
    const H=Math.min(Math.round(W*photoH/photoW),Math.round(window.innerHeight*0.6));
    c.width=W;c.height=H;
  }

  function renderNumber(){
    const c=document.getElementById('number-canvas');if(!c)return;
    const ctx=c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.fillStyle='#050809';ctx.fillRect(0,0,c.width,c.height);
    if(!photoImg){ctx.fillStyle='rgba(255,208,32,0.7)';ctx.font='13px monospace';ctx.textAlign='center';ctx.fillText('Complete earlier steps first',c.width/2,c.height/2);return;}
    ctx.drawImage(photoImg,0,0,c.width,c.height);
    const R=getLedR();
    const posMap=new Map();snakeOrder.forEach((di,wi)=>posMap.set(di,wi));
    detectedLeds.forEach((led,dotIdx)=>{
      const cx=led.x/photoW*c.width,cy=led.y/photoH*c.height;
      const wireIdx=posMap.has(dotIdx)?posMap.get(dotIdx):-1;
      ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);
      if(wireIdx>=0){
        const hue=Math.round(wireIdx/Math.max(1,detectedLeds.length)*300);
        ctx.fillStyle=`hsla(${hue},100%,55%,0.5)`;ctx.fill();
        ctx.strokeStyle=`hsl(${hue},100%,70%)`;ctx.lineWidth=1.5;ctx.stroke();
        ctx.font=`bold ${Math.max(7,Math.min(11,R))}px monospace`;
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle='#fff';ctx.fillText(wireIdx,cx,cy);
      } else {
        ctx.fillStyle='rgba(255,255,255,0.12)';ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=1;ctx.stroke();
      }
      if(wireIdx===recalibStartWireIdx){
        ctx.beginPath();ctx.arc(cx,cy,R+5,0,Math.PI*2);
        ctx.strokeStyle=LANG==='he'?'#ffd020':'#ffd020';ctx.lineWidth=2;ctx.stroke();
      }
    });
  }

  let _numCanvasHandlerBound=false;
  function initNumberCanvasHandlers(){
    if(_numCanvasHandlerBound)return;_numCanvasHandlerBound=true;
    const c=document.getElementById('number-canvas');if(!c)return;
    c.addEventListener('click',onNumberClick);
    c.addEventListener('contextmenu',onNumberRightClick);
    document.addEventListener('mousedown',e=>{
      const popup=document.getElementById('num-popup');
      if(popup&&popup.style.display!=='none'&&!popup.contains(e.target)&&e.target.id!=='number-canvas')popupCancel();
    });
  }

  function onNumberClick(e){
    if(!_numCanvasHandlerBound){initNumberCanvasHandlers();}
    if(popupTargetLed>=0){popupCancel();return;}
    if(!detectedLeds.length)return;
    const p=getCanvasPos(e,'number-canvas');
    const c=document.getElementById('number-canvas');
    const R=getLedR()*1.6;
    let best=-1,bestD=R;
    detectedLeds.forEach((led,dotIdx)=>{
      const cx=led.x/photoW*c.width,cy=led.y/photoH*c.height;
      const d=Math.hypot(p.x-cx,p.y-cy);if(d<bestD){bestD=d;best=dotIdx;}
    });
    if(best<0)return;
    const posMap=new Map();snakeOrder.forEach((di,wi)=>posMap.set(di,wi));
    if(posMap.has(best)){
      if(e.shiftKey){saveHistory();recalibStartWireIdx=posMap.get(best);const b=document.getElementById('btn-recalib');if(b)b.disabled=false;updateSnakeStats();renderNumber();return;}
      showNumPopup(best,e.clientX,e.clientY);return;
    }
    if(snakeStep>=2&&snakeOrder.length>=detectedLeds.length)return;
    saveHistory();snakeOrder.push(best);
    if(snakeStep===0)snakeStep=1;else if(snakeStep===1)snakeStep=2;
    updateSnakeStats();renderNumber();
  }

  function onNumberRightClick(e){
    e.preventDefault();
    const p=getCanvasPos(e,'number-canvas');
    const c=document.getElementById('number-canvas');
    const R=getLedR()*1.6;
    let best=-1,bestD=R;
    detectedLeds.forEach((led,dotIdx)=>{
      const cx=led.x/photoW*c.width,cy=led.y/photoH*c.height;
      const d=Math.hypot(p.x-cx,p.y-cy);if(d<bestD){bestD=d;best=dotIdx;}
    });
    if(best<0)return;
    const posMap=new Map();snakeOrder.forEach((di,wi)=>posMap.set(di,wi));
    if(posMap.has(best)){saveHistory();recalibStartWireIdx=posMap.get(best);const b=document.getElementById('btn-recalib');if(b)b.disabled=false;updateSnakeStats();renderNumber();}
  }

  function getCanvasPos(e,id){
    const c=document.getElementById(id),r=c.getBoundingClientRect();
    const src=e.touches?e.touches[0]:e;
    return{x:(src.clientX-r.left)*c.width/r.width,y:(src.clientY-r.top)*c.height/r.height};
  }

  function updateSnakeStats(){
    const el=document.getElementById('snake-stats');
    if(!el)return;
    if(snakeStep===0) el.textContent=t('Click LED #0 to start','לחץ על נורית מס\' 0');
    else if(snakeStep===1) el.textContent=t('Click LED #1 to set direction','לחץ על נורית מס\' 1');
    else el.textContent=`${snakeOrder.length}/${detectedLeds.length} ${t('assigned','מוקצים')}`;
    const b=document.getElementById('btn-auto-snake');
    if(b)b.disabled=(snakeStep<2||detectedLeds.length<2);
    initNumberCanvasHandlers();
  }

  function saveHistory(){snakeHistory.push({order:[...snakeOrder],step:snakeStep,recalib:recalibStartWireIdx});}
  function undoSnake(){
    if(!snakeHistory.length)return;
    const h=snakeHistory.pop();snakeOrder=h.order;snakeStep=h.step;recalibStartWireIdx=h.recalib;
    updateSnakeStats();renderNumber();
  }
  function clearSnake(){snakeOrder=[];snakeStep=0;recalibStartWireIdx=-1;updateSnakeStats();renderNumber();}

  function autoSnake(){
    if(snakeOrder.length<2)return;
    saveHistory();
    const assigned=new Set(snakeOrder);
    while(snakeOrder.length<detectedLeds.length){
      const n=snakeOrder.length;
      const last=detectedLeds[snakeOrder[n-1]],prev=detectedLeds[snakeOrder[n-2]];
      let dx=last.x-prev.x,dy=last.y-prev.y;const dl=Math.hypot(dx,dy)||1;dx/=dl;dy/=dl;
      let bestScore=Infinity,bestIdx=-1;
      detectedLeds.forEach((led,i)=>{
        if(assigned.has(i))return;
        const tx=led.x-last.x,ty=led.y-last.y,dist=Math.hypot(tx,ty);
        if(dist<0.1)return;
        const cos=(tx*dx+ty*dy)/dist,score=dist*(1-0.7*cos);
        if(score<bestScore){bestScore=score;bestIdx=i;}
      });
      if(bestIdx<0)break;
      snakeOrder.push(bestIdx);assigned.add(bestIdx);
    }
    snakeStep=2;recalibStartWireIdx=-1;updateSnakeStats();renderNumber();
  }

  function recalibrateFromHere(){
    if(recalibStartWireIdx<0||snakeStep<2)return;
    saveHistory();
    const keepOrder=snakeOrder.slice(0,recalibStartWireIdx+1);
    const keepSet=new Set(keepOrder);
    const pool=new Set();
    for(let i=0;i<detectedLeds.length;i++)if(!keepSet.has(i))pool.add(i);
    snakeOrder=keepOrder.slice();
    while(snakeOrder.length<detectedLeds.length){
      const n=snakeOrder.length;
      const last=detectedLeds[snakeOrder[n-1]];
      const prev=n>1?detectedLeds[snakeOrder[n-2]]:null;
      let dx=prev?last.x-prev.x:1,dy=prev?last.y-prev.y:0;
      const dl=Math.hypot(dx,dy)||1;dx/=dl;dy/=dl;
      let bestScore=Infinity,bestIdx=-1;
      pool.forEach(i=>{
        const led=detectedLeds[i];
        const tx=led.x-last.x,ty=led.y-last.y,dist=Math.hypot(tx,ty);
        if(dist<0.1)return;
        const cos=(tx*dx+ty*dy)/dist,score=dist*(1-0.7*cos);
        if(score<bestScore){bestScore=score;bestIdx=i;}
      });
      if(bestIdx<0)break;
      snakeOrder.push(bestIdx);pool.delete(bestIdx);
    }
    recalibStartWireIdx=-1;updateSnakeStats();renderNumber();
  }

  // ── Number popup ──────────────────────────────────────────────────────
  function showNumPopup(dotIdx,clientX,clientY){
    const posMap=new Map();snakeOrder.forEach((di,wi)=>posMap.set(di,wi));
    popupTargetLed=dotIdx;
    document.getElementById('popup-led-id').textContent=dotIdx;
    document.getElementById('popup-input').value=posMap.has(dotIdx)?posMap.get(dotIdx):'';
    const popup=document.getElementById('num-popup');
    let px=clientX+14,py=clientY-30;
    if(px+210>window.innerWidth)px=clientX-214;if(py<8)py=8;
    popup.style.left=px+'px';popup.style.top=py+'px';popup.style.display='flex';
    setTimeout(()=>document.getElementById('popup-input')?.focus(),40);
  }
  function popupConfirm(){
    const val=parseInt(document.getElementById('popup-input').value);
    if(isNaN(val)||val<0||val>=detectedLeds.length){alert('Enter 0–'+(detectedLeds.length-1));return;}
    saveHistory();
    const newOrder=snakeOrder.filter(i=>i!==popupTargetLed);
    const oldLedAtVal=newOrder[val];
    const finalOrder=oldLedAtVal!==undefined?newOrder.filter(i=>i!==oldLedAtVal):newOrder;
    finalOrder.splice(val,0,popupTargetLed);
    snakeOrder=finalOrder;
    if(snakeStep<2)snakeStep=2;
    popupCancel();
    recalibStartWireIdx=val;
    recalibrateFromHere();
  }
  function popupCancel(){document.getElementById('num-popup').style.display='none';popupTargetLed=-1;}
  function popupKey(e){if(e.key==='Enter')popupConfirm();if(e.key==='Escape')popupCancel();}

  // ── Build payload ─────────────────────────────────────────────────────
  function buildPayload(){
    if(!snakeOrder.length||!detectedLeds.length||!H_photo2svg){
      document.getElementById('calib-map-prev').textContent=t('Complete stages 1–4 first','השלם שלבים 1–4 תחילה');
      payload=null;return;
    }
    const ledSvgCoords=new Array(detectedLeds.length);
    snakeOrder.forEach((dotIdx,wireIdx)=>{
      const led=detectedLeds[dotIdx];
      const sv=applyH(H_photo2svg,led.x,led.y);
      ledSvgCoords[wireIdx]={x:Math.round(sv.x*100)/100,y:Math.round(sv.y*100)/100};
    });
    for(let i=0;i<detectedLeds.length;i++)if(!ledSvgCoords[i])ledSvgCoords[i]={x:-1,y:-1};

    const cityMap=CITIES.map(city=>{
      const cp=ll2svg(city.lat,city.lon);
      let bestLed=0,bestD=Infinity;
      ledSvgCoords.forEach((sv,i)=>{if(sv.x<0)return;const d=Math.hypot(sv.x-cp.x,sv.y-cp.y);if(d<bestD){bestD=d;bestLed=i;}});
      return{eng:city.eng,heb:city.heb,led:bestLed};
    });

    payload={n:ledSvgCoords.length,cityMap};
    const jsonStr=JSON.stringify(payload);
    const kb=(new TextEncoder().encode(jsonStr).length/1024).toFixed(1);

    document.getElementById('calib-n-leds').textContent=payload.n;
    document.getElementById('calib-n-cities').textContent=cityMap.length;
    document.getElementById('calib-payload-kb').textContent=kb;

    // First 60 lines preview
    const prev=cityMap.slice(0,60).map(m=>`LED ${m.led}: ${m.eng}`).join('\n');
    document.getElementById('calib-map-prev').textContent=prev+'…';

    // Preview SVG dots
    const g=document.getElementById('preview-led-dots');
    if(g){
      g.innerHTML='';
      const NS='http://www.w3.org/2000/svg';
      ledSvgCoords.forEach((sv,i)=>{
        if(sv.x<0)return;
        const c=document.createElementNS(NS,'circle');
        c.setAttribute('cx',sv.x);c.setAttribute('cy',sv.y);c.setAttribute('r','3');
        c.setAttribute('fill','rgba(36,136,255,0.75)');
        const tl=document.createElementNS(NS,'title');tl.textContent='LED #'+i;c.appendChild(tl);
        g.appendChild(c);
      });
    }

    // Update live map LUT
    LiveMap.buildLUT(CITIES, ledSvgCoords);

    logSend(t('Payload built: ','מטען נבנה: ')+kb+' KB','ok');
  }

  function buildAndSend(){ buildPayload(); showStage(5); }

  // ── Send to device ────────────────────────────────────────────────────
  function logSend(msg,type='inf'){
    const box=document.getElementById('calib-send-log');if(!box)return;
    const d=document.createElement('div');d.className='log-line log-'+type;
    d.textContent='['+new Date().toLocaleTimeString()+'] '+msg;
    box.appendChild(d);box.scrollTop=box.scrollHeight;
  }

  async function sendToDevice(){
    if(!payload){logSend(t('Build payload first','בנה מטען תחילה'),'err');return;}
    const base=App.getBase();
    if(!base){logSend(t('Not connected to device','לא מחובר למכשיר'),'err');return;}
    const btn=document.getElementById('btn-send-config');
    if(btn){btn.disabled=true;btn.textContent=t('Sending…','שולח…');}
    const pnaWarn=document.getElementById('calib-pna-warn');
    if(pnaWarn)pnaWarn.style.display='none';
    const jsonStr=JSON.stringify(payload);
    const kb=(new TextEncoder().encode(jsonStr).length/1024).toFixed(1);
    logSend(t(`Sending ${payload.n} LEDs + ${payload.cityMap.length} cities (${kb} KB)…`,
              `שולח ${payload.n} נוריות + ${payload.cityMap.length} ערים (${kb} KB)…`),'inf');
    try{
      const blob=new Blob([jsonStr],{type:'application/json'});
      const fd=new FormData();fd.append('file',blob,'config.json');
      const r=await fetch(base+'/uploadmap',{method:'POST',body:fd,signal:AbortSignal.timeout(30000)});
      const txt=await r.text();
      if(r.ok){logSend(t('Saved: ','נשמר: ')+txt,'ok');}
      else{logSend(t('Error: ','שגיאה: ')+txt,'err');}
    }catch(e){
      const pna=e.message?.includes('Failed to fetch')||e.message?.includes('NetworkError');
      if(pnaWarn&&pna)pnaWarn.style.display='block';
      logSend((e.name==='TimeoutError'?t('Timeout','פג זמן'):t('Error: ','שגיאה: ')+e.message),'err');
    }finally{if(btn){btn.disabled=false;btn.textContent=t('Send to Device','שלח למכשיר');}}
  }

  function downloadPayload(){
    if(!payload){alert(t('Build payload first','בנה מטען תחילה'));return;}
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    a.download='redalert_city_map.json';a.click();
    logSend(t('Downloaded','הורד'),'ok');
  }

  function copyPayload(){
    if(!payload){alert(t('Build payload first','בנה מטען תחילה'));return;}
    navigator.clipboard?.writeText(JSON.stringify(payload)).then(()=>logSend(t('Copied to clipboard','הועתק ללוח'),'ok')).catch(()=>logSend(t('Copy failed','העתקה נכשלה'),'err'));
  }

  // ── City DB ───────────────────────────────────────────────────────────
  let _dbFiltered=[], _dbSortKey='idx', _dbSortAsc=true, _dbPage=0;
  const DB_PER=50;

  function dbFilter(){
    const q=(document.getElementById('db-search')?.value||'').toLowerCase().trim();
    if(typeof CITIES==='undefined')return;
    _dbFiltered=CITIES.map((c,i)=>({...c,_i:i})).filter(c=>{
      if(!q)return true;
      return c.eng.toLowerCase().includes(q)||c.heb.includes(q);
    });
    _dbFiltered.sort((a,b)=>{
      let va,vb;
      if(_dbSortKey==='idx'){va=a._i;vb=b._i;}
      else if(_dbSortKey==='lat'){va=a.lat;vb=b.lat;}
      else if(_dbSortKey==='lon'){va=a.lon;vb=b.lon;}
      else{va=(a[_dbSortKey]||'').toLowerCase();vb=(b[_dbSortKey]||'').toLowerCase();}
      return _dbSortAsc?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0);
    });
    _dbPage=0;dbRender();
  }

  function dbSort(key){
    if(_dbSortKey===key)_dbSortAsc=!_dbSortAsc;else{_dbSortKey=key;_dbSortAsc=true;}
    dbFilter();
  }

  function dbRender(){
    const tbody=document.getElementById('db-tbody');if(!tbody)return;
    const page=_dbFiltered.slice(_dbPage*DB_PER,(_dbPage+1)*DB_PER);
    tbody.innerHTML=page.map((c,pi)=>`
      <tr style="border-bottom:1px solid var(--bdr)">
        <td style="padding:4px 6px;color:var(--txt3)">${c._i}</td>
        <td style="padding:4px 6px">${escH(c.eng)}</td>
        <td style="padding:4px 6px;direction:rtl">${escH(c.heb)}</td>
        <td style="padding:4px 6px;text-align:right;color:var(--txt3)">${c.lat.toFixed(4)}</td>
        <td style="padding:4px 6px;text-align:right;color:var(--txt3)">${c.lon.toFixed(4)}</td>
        <td style="padding:4px 6px"></td>
      </tr>`).join('');
    const pages=Math.ceil(_dbFiltered.length/DB_PER);
    const pag=document.getElementById('db-pagination');
    if(pag){
      pag.innerHTML=`<button class="btn" onclick="Calib._dbPrev()" ${_dbPage===0?'disabled':''} style="padding:3px 8px;font-size:10px">←</button>
        <span>${_dbPage+1}/${pages||1} (${_dbFiltered.length})</span>
        <button class="btn" onclick="Calib._dbNext()" ${_dbPage>=pages-1?'disabled':''} style="padding:3px 8px;font-size:10px">→</button>`;
    }
    document.getElementById('db-count').textContent=typeof CITIES!=='undefined'?CITIES.length:0;
  }
  function _dbPrev(){if(_dbPage>0){_dbPage--;dbRender();}}
  function _dbNext(){const p=Math.ceil(_dbFiltered.length/DB_PER);if(_dbPage<p-1){_dbPage++;dbRender();}}
  function dbExport(){
    if(typeof CITIES==='undefined')return;
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(CITIES,null,2)],{type:'application/json'}));
    a.download='pikud_haoref_zones.json';a.click();
  }
  function dbImport(input){
    const file=input.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const data=JSON.parse(e.target.result);
        if(!Array.isArray(data)){alert('Invalid JSON — expected array');return;}
        const valid=data.filter(x=>x.eng&&typeof x.lat==='number'&&typeof x.lon==='number');
        if(!valid.length){alert('No valid zones found');return;}
        if(confirm(`Import ${valid.length} zones? This replaces the current list.`)){
          CITIES.length=0;valid.forEach(c=>CITIES.push(c));
          refreshCityDots();dbFilter();
        }
      }catch(err){alert('JSON error: '+err.message);}
    };
    reader.readAsText(file);input.value='';
  }

  function escH(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  return {
    showStage, onShow,
    resetAlignPins, renderAlign,
    autoDetect, setEditMode, updateThresh, updateLedSize, updateMinDist,
    autoSnake, recalibrateFromHere, undoSnake, clearSnake,
    popupConfirm, popupCancel, popupKey,
    buildAndSend, sendToDevice, downloadPayload, copyPayload,
    dbFilter, dbSort, dbExport, dbImport,
    _dbPrev, _dbNext,
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  LiveMap.init();
  App.init();
});
