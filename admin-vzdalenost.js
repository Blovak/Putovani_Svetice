(function () {
  'use strict';

  const API_URL = 'https://script.google.com/macros/s/AKfycbyMu_V5w0nmH5s7wxeCC_nh9BdheaCKJs87LyKrmgHt9J1hw1vyXRfqQY-iMZIXQcmg/exec';
  const SESSION_KEY = 'putovani:session';
  const SVETICE_CENTER = [49.9717989, 14.6651694];
  const status = document.getElementById('distanceStatus');
  const explanation = document.getElementById('distanceExplanation');
  const fitCircleButton = document.getElementById('fitCircleButton');
  const centerButton = document.getElementById('centerButton');
  const backButton = document.getElementById('backButton');
  let map;
  let distanceCircle;

  backButton.addEventListener('click', function () {
    if (window.history.length > 1) window.history.back();
    else window.location.href = 'index.html';
  });

  function apiPost(payload) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(payload).toString()
    }).then(function (response) {
      return response.text();
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('INVALID_RESPONSE');
      }
    });
  }

  async function apiPostWithRetry(payload) {
    const delays = [0, 800, 1600];
    let lastError;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise(function (resolve) { setTimeout(resolve, delays[attempt]); });
      try {
        const data = await apiPost(payload);
        if (data.status === 'ERROR' && data.error === 'SERVER_ERROR' && attempt < delays.length - 1) {
          lastError = new Error('SERVER_ERROR');
          continue;
        }
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function formatDistance(value) {
    return new Intl.NumberFormat('cs-CZ', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    }).format(Number(value) || 0) + ' km';
  }

  function showError(message) {
    status.textContent = message;
    status.classList.add('error');
  }

  function fitCircle() {
    if (!map || !distanceCircle) return;
    map.fitBounds(distanceCircle.getBounds(), {
      paddingTopLeft: window.innerWidth < 520 ? [22, 350] : [420, 70],
      paddingBottomRight: [28, 28],
      maxZoom: 13
    });
  }

  function initializeMap(totalDistanceKm, calculatedAt) {
    const radiusMeters = Math.max(0, totalDistanceKm * 1000);
    map = L.map('distanceMap', { preferCanvas: true, zoomControl: false });
    map.setView(SVETICE_CENTER, 13);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    distanceCircle = L.circle(SVETICE_CENTER, {
      radius: radiusMeters,
      color: '#1f6b3a',
      weight: 3,
      opacity: .95,
      fillColor: '#50a867',
      fillOpacity: .19
    }).addTo(map);

    const centerIcon = L.divIcon({
      className: '',
      html: '<span class="distance-center-marker" aria-hidden="true"></span>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16]
    });
    L.marker(SVETICE_CENTER, {
      icon: centerIcon,
      title: 'Světice – obecní úřad',
      keyboard: true,
      zIndexOffset: 500
    }).addTo(map).bindPopup('<strong>Světice – obecní úřad</strong><br>Střed kruhu celkové vzdálenosti');

    status.textContent = 'Všichni účastníci zatím společně ušli ' + formatDistance(totalDistanceKm) + '.' +
      (calculatedAt ? ' Přepočteno: ' + calculatedAt + '.' : '');
    status.classList.remove('error');
    explanation.classList.remove('hidden');
    fitCircleButton.classList.remove('hidden');
    centerButton.classList.remove('hidden');

    if (radiusMeters > 0) fitCircle();
    else map.setView(SVETICE_CENTER, 13);

    fitCircleButton.addEventListener('click', fitCircle);
    centerButton.addEventListener('click', function () {
      map.setView(SVETICE_CENTER, 13);
    });
  }

  async function start() {
    if (typeof L === 'undefined') {
      showError('Mapové podklady se nepodařilo načíst. Obnovte stránku a zkuste to znovu.');
      return;
    }
    const token = localStorage.getItem(SESSION_KEY) || '';
    if (!token) {
      showError('Pro zobrazení této mapy se nejprve přihlaste jako administrátor.');
      return;
    }
    try {
      const data = await apiPostWithRetry({ action: 'adminTotalDistance', sessionToken: token });
      if (data.status !== 'OK') throw new Error(data.error || 'SERVER_ERROR');
      initializeMap(Math.max(0, Number(data.totalDistanceKm) || 0), data.calculatedAt || '');
    } catch (error) {
      if (error.message === 'UNAUTHORIZED' || error.message === 'FORBIDDEN') {
        showError('Tato mapa je dostupná pouze přihlášeným administrátorům.');
      } else {
        showError('Aktuální vzdálenost se nepodařilo načíst. Zkontrolujte připojení a zkuste to znovu.');
      }
    }
  }

  start();
})();
