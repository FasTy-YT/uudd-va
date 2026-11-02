// ==== 1. Навигация по вкладкам ====
(function() {
    const navLinks = document.querySelectorAll('.nav-tabs a');
    const pages = {
      home: document.getElementById('page-home'),
      leadership: document.getElementById('page-leadership'),
      training: document.getElementById('page-training'),
      fleet: document.getElementById('page-fleet'),
      online: document.getElementById('page-online'),
      mayday: document.getElementById('page-mayday')
    };
    function showPage(pageId) {
      navLinks.forEach(l => l.classList.remove('active'));
      Object.values(pages).forEach(p => p.classList.remove('active'));
      const a = Array.from(navLinks).find(l => l.dataset.page === pageId);
      if (a) a.classList.add('active');
      if (pages[pageId]) pages[pageId].classList.add('active');
      if (pageId === 'online' && typeof window.vakInitMap === 'function') window.vakInitMap();
    }
    navLinks.forEach(l => l.addEventListener('click', function() { showPage(this.dataset.page); }));
    window.addEventListener('hashchange', function() {
      const h = window.location.hash.replace('#','') || 'home';
      showPage(pages[h] ? h : 'home');
    });
    const h0 = window.location.hash.replace('#','');
    if (h0 && pages[h0]) showPage(h0);
    else { showPage('home'); if (history.replaceState) history.replaceState(null,'','#home'); }
  })();
  
  // ==== 2. Модуль карты ====
  (function() {
    let map = null, pilotsLayer = null, routeLayer = null;
    let allPilots = [], loading = false;
    let airportDB = {}; 
    let airportsLoaded = false;
  
    // Математика для дуги (Great Circle)
    function getGeodesicPoints(lat1, lon1, lat2, lon2, steps = 40) {
      const φ1 = lat1 * Math.PI / 180, λ1 = lon1 * Math.PI / 180;
      const φ2 = lat2 * Math.PI / 180, λ2 = lon2 * Math.PI / 180;
      const d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((φ2 - φ1)/2), 2) + Math.cos(φ1)*Math.cos(φ2)*Math.pow(Math.sin((λ2 - λ1)/2), 2)));
      const points = [];
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
        const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
        const z = A * Math.sin(φ1) + B * Math.sin(φ2);
        const φ3 = Math.atan2(z, Math.sqrt(x*x + y*y));
        const λ3 = Math.atan2(y, x);
        points.push([φ3 * 180 / Math.PI, λ3 * 180 / Math.PI]);
      }
      return points;
    }
  
    async function loadAirportsDB() {
      if (airportsLoaded) return;
      try {
        const res = await fetch('https://cdn.jsdelivr.net/gh/mwgg/Airports@master/airports.json');
        const data = await res.json();
        for (const key in data) {
          if (data[key].icao) {
            airportDB[data[key].icao.toUpperCase()] = {
              lat: data[key].lat, lon: data[key].lon,
              city: data[key].city || data[key].name || 'UNKNOWN'
            };
          }
        }
        airportsLoaded = true;
      } catch (e) { console.warn('Airports DB error:', e); }
    }
  
    function formatTime(seconds) {
      if (!seconds) return '--:--';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
  
    function formatUTC(timestamp) {
      if (!timestamp) return '--:--';
      const d = new Date(timestamp * 1000);
      return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
    }
    
    function getAltColor(alt) {
      if (alt < 1000) return '#ffffff';
      if (alt < 10000) return '#00ffff';
      if (alt < 20000) return '#00ff00';
      if (alt < 30000) return '#ffff00';
      return '#ff4500';
    }
  
    window.vakInitMap = function() {
      if (map) { setTimeout(() => map.invalidateSize(), 60); return; }
      const el = document.getElementById('map');
      if (!el) return;
      
      map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([55, 50], 3);
      
      L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri', maxZoom: 16
      }).addTo(map);
  
      pilotsLayer = L.layerGroup().addTo(map);
      routeLayer = L.layerGroup().addTo(map); 
      
      map.on('click', function() { 
        routeLayer.clearLayers(); 
        document.getElementById('flight-dashboard').classList.remove('active');
      });
  
      setTimeout(() => map.invalidateSize(), 120);
      
      document.getElementById('refresh-map').addEventListener('click', loadPilots);
      document.getElementById('pilot-filter').addEventListener('input', renderPilots);
      document.getElementById('dash-close').addEventListener('click', function() {
        document.getElementById('flight-dashboard').classList.remove('active');
      });
      
      loadAirportsDB();
      loadPilots();
    };
  
    async function loadPilots() {
      if (loading) return; 
      loading = true;
      const errEl = document.getElementById('map-error');
      const statusEl = document.getElementById('pilot-count');
      errEl.style.display = 'none';
      statusEl.textContent = 'Загрузка данных IVAO…';
      
      const api = 'https://api.ivao.aero/v2/tracker/whazzup';
      const urls = [
        { url: api },
        { url: 'https://corsproxy.io/?url=' + encodeURIComponent(api) },
        { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(api) }
      ];
      
      let data = null, lastErr = null;
      
      for (const item of urls) {
        try {
          const r = await fetch(item.url, { cache: 'no-store' });
          if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
          const text = await r.text();
          if (text.trim().startsWith('<')) { lastErr = 'HTML'; continue; }
          const j = JSON.parse(text);
          if (j && j.clients && Array.isArray(j.clients.pilots)) { data = j; break; }
        } catch (e) { lastErr = e.message; }
      }
      
      loading = false;
      if (!data) {
        statusEl.textContent = 'Ошибка загрузки';
        errEl.style.display = 'block';
        errEl.innerHTML = '⚠️ Не удалось загрузить данные.<br><br><input type="file" id="map-json-file" accept=".json,.txt">';
        document.getElementById('map-json-file').addEventListener('change', function(e) {
          const f = e.target.files[0]; if (!f) return;
          const r = new FileReader();
          r.onload = ev => {
            try {
              const j = JSON.parse(ev.target.result);
              if (j.clients.pilots) { allPilots = j.clients.pilots; errEl.style.display = 'none'; renderPilots(); }
            } catch (err) { alert('Ошибка JSON'); }
          };
          r.readAsText(f);
        });
        return;
      }
      allPilots = data.clients.pilots;
      renderPilots();
    }
  
    function showDashboard(p) {
      const fp = p.flightPlan || {};
      const t = p.lastTrack || {};
      
      document.getElementById('dash-callsign').textContent = p.callsign || '???';
      document.getElementById('dash-acft').textContent = (fp.aircraft && fp.aircraft.model) ? fp.aircraft.model : (fp.aircraftId || 'Unknown');
      document.getElementById('dash-dep-code').textContent = fp.departureId || '----';
      document.getElementById('dash-arr-code').textContent = fp.arrivalId || '----';
      
      if (fp.departureId && airportDB[fp.departureId]) {
        document.getElementById('dash-dep-city').textContent = airportDB[fp.departureId].city;
      } else { document.getElementById('dash-dep-city').textContent = 'UNKNOWN'; }
      
      if (fp.arrivalId && airportDB[fp.arrivalId]) {
        document.getElementById('dash-arr-city').textContent = airportDB[fp.arrivalId].city;
      } else { document.getElementById('dash-arr-city').textContent = 'UNKNOWN'; }
  
      const depDist = t.departureDistance || 0;
      const arrDist = t.arrivalDistance || 0;
      const totalDist = depDist + arrDist;
      let progress = 0;
      if (totalDist > 0) progress = (depDist / totalDist) * 100;
      
      document.getElementById('dash-route-flown').textContent = Math.round(depDist) + ' nm flown';
      document.getElementById('dash-route-togo').textContent = Math.round(arrDist) + ' nm to go';
      document.getElementById('dash-progress-fill').style.width = progress + '%';
      
      document.getElementById('dash-rules').textContent = fp.flightRules === 'I' ? 'IFR' : 'VFR';
      document.getElementById('dash-state').textContent = t.state || '---';
  
      document.getElementById('dash-alt').textContent = t.altitude ? t.altitude.toLocaleString() : '---';
      document.getElementById('dash-gs').textContent = t.groundSpeed ? Math.round(t.groundSpeed) : '---';
      document.getElementById('dash-hdg').textContent = t.heading ? Math.round(t.heading) + '°' : '---';
      document.getElementById('dash-squawk').textContent = t.transponder || '---';
      document.getElementById('dash-online').textContent = formatTime(p.time);
      
      let etaStr = '--:--';
      if (t.groundSpeed > 0 && arrDist > 0) {
         const remainingHours = arrDist / t.groundSpeed;
         const etaDate = new Date(Date.now() + remainingHours * 3600 * 1000);
         etaStr = `${etaDate.getUTCHours().toString().padStart(2, '0')}:${etaDate.getUTCMinutes().toString().padStart(2, '0')}`;
      }
      document.getElementById('dash-eta').textContent = etaStr;
  
      document.getElementById('dash-acft-type').textContent = fp.aircraftId || '---';
      document.getElementById('dash-fl').textContent = fp.level ? fp.level.replace(/[A-Z]/g, '') : '---';
      document.getElementById('dash-speed').textContent = fp.speed || '---';
      document.getElementById('dash-dep-time').textContent = formatUTC(fp.departureTime);
      document.getElementById('dash-eet').textContent = formatTime(fp.eet);
      
      let remSeconds = fp.eet;
      if (t.time) remSeconds = fp.eet - t.time;
      if (remSeconds < 0) remSeconds = 0;
      document.getElementById('dash-remaining').textContent = formatTime(remSeconds);
  
      document.getElementById('dash-route').textContent = fp.route || 'No route provided.';
      document.getElementById('dash-remarks').textContent = fp.remarks || 'No remarks.';
      
      // Имя пилота и Симулятор
      document.getElementById('dash-pilot-name').textContent = p.name || p.callsign || 'Unknown Pilot';
      const sim = p.pilotSession ? p.pilotSession.simulatorId : 'Unknown Simulator';
      document.getElementById('dash-simulator').textContent = sim;
  
      document.getElementById('flight-dashboard').classList.add('active');
  
      // === ОТРИСОВКА МАРШРУТОВ НА КАРТЕ ===
      routeLayer.clearLayers();
      
      const dep = fp.departureId;
      const arr = fp.arrivalId;
      
      if (dep && arr && airportDB[dep] && airportDB[arr]) {
        const a1 = airportDB[dep];
        const a2 = airportDB[arr];
        
        const plannedPath = getGeodesicPoints(a1.lat, a1.lon, a2.lat, a2.lon);
        L.polyline(plannedPath, { color: '#5aff78', weight: 1, dashArray: '4, 8', opacity: 0.5 }).addTo(routeLayer);
        
        L.circleMarker([a1.lat, a1.lon], { radius: 4, color: '#fff', fillColor: '#5aff78', fillOpacity: 1, weight: 2 })
         .addTo(routeLayer).bindTooltip(dep, { permanent: true, direction: 'top', offset: [0, -5] });
         
        L.circleMarker([a2.lat, a2.lon], { radius: 4, color: '#fff', fillColor: '#5aff78', fillOpacity: 1, weight: 2 })
         .addTo(routeLayer).bindTooltip(arr, { permanent: true, direction: 'top', offset: [0, -5] });
      }
  
      if (dep && airportDB[dep] && t.latitude && t.longitude) {
        const a1 = airportDB[dep];
        const currentPath = getGeodesicPoints(a1.lat, a1.lon, t.latitude, t.longitude, 30);
        
        for (let i = 0; i < currentPath.length - 1; i++) {
          const fraction = i / (currentPath.length - 1);
          const simulatedAlt = t.altitude * fraction; 
          
          L.polyline([currentPath[i], currentPath[i+1]], {
            color: getAltColor(simulatedAlt),
            weight: 4,
            opacity: 0.9,
            lineCap: 'round'
          }).addTo(routeLayer);
        }
      }
  
      if (t.latitude && t.longitude) {
        map.setView([t.latitude, t.longitude], 5, { animate: true });
      }
    }
  
    function renderPilots() {
      if (!pilotsLayer) return;
      pilotsLayer.clearLayers();
      routeLayer.clearLayers(); 
      
      const uf = (document.getElementById('pilot-filter').value||'').trim().toLowerCase();
      let count = 0; 
      const bounds = L.latLngBounds();
      
      allPilots.forEach(p => {
        const t = p.lastTrack;
        if (!t || typeof t.latitude !== 'number' || typeof t.longitude !== 'number') return;
        const fp = p.flightPlan || {};
        
        if (uf) {
          const hay = [p.callsign, fp.departureId, fp.arrivalId, fp.aircraftId, fp.remarks, t.state].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(uf)) return;
        }
        
        count++;
        
        // === САМОЛЕТИК ВМЕСТО КРУЖОЧКА ===
        const isGround = t.onGround;
        const heading = t.heading || 0;
        
        const planeIcon = L.divIcon({
          className: 'plane-wrapper',
          html: `<div class="plane-icon ${isGround ? 'ground' : ''}" style="transform: rotate(${heading}deg);"></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });
  
        const marker = L.marker([t.latitude, t.longitude], { icon: planeIcon });
        
        const cs = p.callsign || '???';
        const acftType = fp.aircraftId || (fp.aircraft && fp.aircraft.model) || '---';
        const depAirport = fp.departureId || '----';
        const arrAirport = fp.arrivalId || '----';
  
        const tooltipHtml = `
          <div style="text-align:center; line-height:1.3;">
            <div style="font-size:14px; font-weight:800; color:#fff; margin-bottom:2px;">${cs}</div>
            <div style="font-size:11px; color:#9aa8b9; margin-bottom:4px;">${acftType}</div>
            <div style="font-size:13px; font-weight:700; color:#5aff78;">${depAirport} → ${arrAirport}</div>
          </div>
        `;
        
        marker.bindTooltip(tooltipHtml, { 
          direction: 'top', 
          offset: [0, -12], 
          className: 'custom-aircraft-tooltip',
          opacity: 1
        });
        
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          showDashboard(p);
        });
        
        pilotsLayer.addLayer(marker);
        bounds.extend([t.latitude, t.longitude]);
      });
      
      document.getElementById('pilot-count').textContent = 'На карте: ' + count + ' из ' + allPilots.length;
      if (count > 0 && map) map.fitBounds(bounds.pad(0.15), { maxZoom: 6 });
    }
  })();