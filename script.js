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
      navLinks.forEach(link => link.classList.remove('active'));
      Object.values(pages).forEach(page => page.classList.remove('active'));
  
      const activeLink = Array.from(navLinks).find(link => link.dataset.page === pageId);
      if (activeLink) activeLink.classList.add('active');
      if (pages[pageId]) pages[pageId].classList.add('active');
  
      if (pageId === 'online' && typeof window.vakInitMap === 'function') {
        window.vakInitMap();
      }
    }
  
    navLinks.forEach(link => {
      link.addEventListener('click', function() {
        showPage(this.dataset.page);
      });
    });
  
    window.addEventListener('hashchange', function() {
      const hash = window.location.hash.replace('#', '') || 'home';
      showPage(pages[hash] ? hash : 'home');
    });
  
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash && pages[initialHash]) {
      showPage(initialHash);
    } else {
      showPage('home');
      if (history.replaceState) history.replaceState(null, '', '#home');
    }
  })();
  
  /* ================================== */
  /* Модуль онлайн-карты пилотов IVAO   */
  /* ================================== */
  (function initMapModule() {
    let map = null;
    let pilotsLayer = null;
    let allPilots = [];
    let loading = false;
  
    // Настройки фильтрации. Пока показываем всех, чтобы можно было проверить работу.
    // Когда узнаешь код ВАК в IVAO (например 'DME'), укажи его здесь:
    //   filterRemarksIncludes: 'IVAOVA/DME'   -> покажем только наших
    //   callsignPrefixes: ['DME','SBI']       -> по префиксу позывного
    const CONFIG = {
      filterRemarksIncludes: null,   // строка для поиска в remarks flightPlan
      callsignPrefixes: null,        // массив префиксов позывных
      showAll: true                  // если true — показываем всех, фильтр ручной
    };
  
    window.vakInitMap = function() {
      if (map) {
        setTimeout(() => map.invalidateSize(), 60);
        return;
      }
  
      const el = document.getElementById('map');
      if (!el) return;
  
      map = L.map('map', { zoomControl: true, worldCopyJump: true })
        .setView([55, 50], 3);
  
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(map);
  
      pilotsLayer = L.layerGroup().addTo(map);
  
      setTimeout(() => map.invalidateSize(), 120);
  
      const refreshBtn = document.getElementById('refresh-map');
      const filterEl = document.getElementById('pilot-filter');
      if (refreshBtn) refreshBtn.addEventListener('click', loadPilots);
      if (filterEl) filterEl.addEventListener('input', renderPilots);
  
      loadPilots();
    };
  
    async function loadPilots() {
      if (loading) return;
      loading = true;
  
      const errEl = document.getElementById('map-error');
      const statusEl = document.getElementById('pilot-count');
      if (errEl) errEl.style.display = 'none';
      if (statusEl) statusEl.textContent = 'Загрузка данных IVAO…';
  
      const apiUrl = 'https://api.ivao.aero/v2/tracker/whazzup';
      const attempts = [
        { name: 'direct', url: apiUrl },
        { name: 'corsproxy', url: 'https://corsproxy.io/?url=' + encodeURIComponent(apiUrl) },
        { name: 'allorigins', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(apiUrl) }
      ];
  
      let data = null;
      let lastErr = null;
  
      for (const a of attempts) {
        try {
          const r = await fetch(a.url, { cache: 'no-store' });
          if (!r.ok) { lastErr = 'HTTP ' + r.status + ' (' + a.name + ')'; continue; }
          const j = await r.json();
          if (j && j.clients && Array.isArray(j.clients.pilots)) {
            data = j;
            break;
          } else {
            lastErr = 'Неверный формат ответа (' + a.name + ')';
          }
        } catch (e) {
          lastErr = e.message + ' (' + a.name + ')';
        }
      }
  
      loading = false;
  
      if (!data) {
        if (statusEl) statusEl.textContent = 'Ошибка загрузки';
        if (errEl) {
          errEl.style.display = 'block';
          errEl.innerHTML =
            '⚠️ Не удалось загрузить данные с IVAO.<br>' +
            '<small>Причина: ' + (lastErr || 'неизвестно') + '</small><br><br>' +
            'IVAO API требует OAuth-авторизации и не отдаёт CORS для браузера. ' +
            'Можно загрузить сохранённый JSON вручную:<br>' +
            '<input type="file" id="map-json-file" accept=".json,application/json">';
          const fi = document.getElementById('map-json-file');
          if (fi) fi.addEventListener('change', handleFileUpload);
        }
        return;
      }
  
      allPilots = data.clients.pilots;
      renderPilots();
    }
  
    function handleFileUpload(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const j = JSON.parse(ev.target.result);
          if (j && j.clients && Array.isArray(j.clients.pilots)) {
            allPilots = j.clients.pilots;
            const errEl = document.getElementById('map-error');
            if (errEl) errEl.style.display = 'none';
            renderPilots();
          } else {
            alert('Неверный формат JSON: ожидался объект с clients.pilots');
          }
        } catch (err) {
          alert('Ошибка парсинга JSON: ' + err.message);
        }
      };
      reader.readAsText(file);
    }
  
    function matchesVaConfig(pilot, fp) {
      if (CONFIG.showAll) return true;
  
      if (CONFIG.callsignPrefixes && CONFIG.callsignPrefixes.length) {
        const cs = (pilot.callsign || '').toUpperCase();
        if (!CONFIG.callsignPrefixes.some(p => cs.startsWith(p.toUpperCase()))) return false;
      }
  
      if (CONFIG.filterRemarksIncludes) {
        const remarks = (fp && fp.remarks) ? String(fp.remarks).toUpperCase() : '';
        if (!remarks.includes(CONFIG.filterRemarksIncludes.toUpperCase())) return false;
      }
  
      return true;
    }
  
    function renderPilots() {
      if (!pilotsLayer) return;
      pilotsLayer.clearLayers();
  
      const filterEl = document.getElementById('pilot-filter');
      const userFilter = (filterEl && filterEl.value || '').trim().toLowerCase();
      const statusEl = document.getElementById('pilot-count');
  
      let count = 0;
      const bounds = L.latLngBounds();
  
      allPilots.forEach(p => {
        const t = p.lastTrack;
        if (!t) return;
        if (typeof t.latitude !== 'number' || typeof t.longitude !== 'number') return;
  
        const fp = p.flightPlan || {};
  
        if (!matchesVaConfig(p, fp)) return;
  
        if (userFilter) {
          const hay = [
            p.callsign,
            fp.departureId,
            fp.arrivalId,
            fp.aircraftId,
            fp.remarks,
            t.state
          ].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(userFilter)) return;
        }
  
        count++;
  
        const onGround = !!t.onGround;
        const color = onGround ? '#ffb703' : '#5aff78';
  
        const marker = L.circleMarker([t.latitude, t.longitude], {
          radius: 5,
          fillColor: color,
          color: '#000',
          weight: 1,
          opacity: 0.9,
          fillOpacity: 0.9
        });
  
        const callsign = p.callsign || '???';
        const route = (fp.departureId && fp.arrivalId)
          ? fp.departureId + ' → ' + fp.arrivalId
          : '—';
        const acft = fp.aircraftId || '—';
        const state = t.state || '—';
        const alt = (typeof t.altitude === 'number') ? t.altitude : '—';
        const gs  = (typeof t.groundSpeed === 'number') ? t.groundSpeed : '—';
        const hdg = (typeof t.heading === 'number') ? t.heading : '—';
  
        marker.bindPopup(
          '<div style="min-width:200px;color:#0b0f17;font-family:Inter,system-ui,sans-serif;font-size:13px;">' +
            '<div style="font-size:15px;font-weight:700;color:#0b0f17;margin-bottom:4px;">' + callsign + '</div>' +
            '<div style="color:#444;margin-bottom:4px;">' + acft + '</div>' +
            '<div style="font-weight:600;margin-bottom:4px;">' + route + '</div>' +
            '<div style="color:#666;margin-bottom:2px;">' + state + '</div>' +
            '<div style="color:#444;">Alt: ' + alt + ' ft · GS: ' + gs + ' kt · HDG: ' + hdg + '°</div>' +
          '</div>'
        );
  
        pilotsLayer.addLayer(marker);
        bounds.extend([t.latitude, t.longitude]);
      });
  
      if (statusEl) {
        statusEl.textContent = 'На карте: ' + count + ' из ' + allPilots.length + ' пилотов';
      }
  
      if (count > 0 && map) {
        map.fitBounds(bounds.pad(0.15), { maxZoom: 6 });
      }
    }
  })();