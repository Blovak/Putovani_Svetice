(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const routeKey = (params.get('route') || '').toLowerCase();
  const route = window.ROUTES && window.ROUTES[routeKey];
  const title = document.getElementById('routeTitle');
  const summary = document.getElementById('routeSummary');
  const pointsList = document.getElementById('routePoints');
  const locationButton = document.getElementById('locationButton');
  const locationStatus = document.getElementById('locationStatus');

  if (!route) {
    title.textContent = 'Trasa nebyla nalezena';
    summary.className = 'error-card';
    summary.textContent = 'Odkaz na mapu neobsahuje platný název trasy.';
    pointsList.hidden = true;
    locationButton.hidden = true;
    document.getElementById('map').hidden = true;
    return;
  }

  document.documentElement.style.setProperty('--route', route.color);
  document.documentElement.style.setProperty('--route-dark', route.darkColor);
  document.documentElement.style.setProperty('--button-text', route.textColor || '#fff');
  document.querySelector('meta[name="theme-color"]').content = route.color;
  document.title = route.name + ' trasa – Světické kilometrobrání';
  title.textContent = route.name + ' trasa';
  summary.textContent = route.length.toLocaleString('cs-CZ', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
  document.getElementById('map').setAttribute('aria-label', 'Interaktivní mapa ' + route.name.toLowerCase() + ' trasy');

  route.points.forEach(function (point) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const value = document.createElement('span');
    label.className = 'point-label';
    label.textContent = point.label;
    value.textContent = point.title;
    item.append(label, value);
    pointsList.appendChild(item);
  });

  const map = L.map('map', { preferCanvas: true, zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  L.polyline(route.coordinates, {
    color: '#fff',
    weight: 10,
    opacity: .94,
    lineJoin: 'round'
  }).addTo(map);

  const routeLine = L.polyline(route.coordinates, {
    color: route.color,
    weight: 6,
    opacity: 1,
    lineJoin: 'round'
  }).addTo(map);

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }

  function markerIcon(point) {
    const controlClass = point.label === 'QR' ? ' route-marker--control' : '';
    const size = point.label === 'QR' ? 48 : 44;
    return L.divIcon({
      className: '',
      html: '<span class="route-marker' + controlClass + '">' + escapeHtml(point.label) + '</span>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2]
    });
  }

  route.points.forEach(function (point) {
    L.marker(point.position, {
      icon: markerIcon(point),
      title: point.title,
      keyboard: true,
      zIndexOffset: point.label === 'QR' ? 500 : 0
    }).addTo(map).bindPopup('<strong>' + escapeHtml(point.title) + '</strong>');
  });

  const visibleBounds = routeLine.getBounds();
  route.points.forEach(function (point) { visibleBounds.extend(point.position); });
  map.fitBounds(visibleBounds, {
    paddingTopLeft: [24, 225],
    paddingBottomRight: [24, 24],
    maxZoom: 16
  });

  let locationWatchId = null;
  let locationMarker = null;
  let accuracyCircle = null;
  let locationCentered = false;

  function stopLocation() {
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
    locationCentered = false;
    locationButton.disabled = false;
    locationButton.textContent = 'Ukázat moji polohu';
    locationStatus.textContent = '';
  }

  function showLocation(position) {
    const coordinates = [position.coords.latitude, position.coords.longitude];
    const accuracy = Math.max(position.coords.accuracy || 0, 5);
    const positionIcon = L.divIcon({
      className: '',
      html: '<span class="position-marker" aria-hidden="true"></span>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    if (!locationMarker) {
      locationMarker = L.marker(coordinates, {
        icon: positionIcon,
        title: 'Moje poloha',
        zIndexOffset: 1000
      }).addTo(map).bindPopup('<strong>Moje poloha</strong>');
      accuracyCircle = L.circle(coordinates, {
        radius: accuracy,
        color: '#1976d2',
        fillColor: '#64b5f6',
        fillOpacity: .16,
        weight: 2
      }).addTo(map);
    } else {
      locationMarker.setLatLng(coordinates);
      accuracyCircle.setLatLng(coordinates).setRadius(accuracy);
    }

    if (!locationCentered) {
      map.setView(coordinates, Math.max(map.getZoom(), 16));
      locationCentered = true;
    }
    locationButton.disabled = false;
    locationButton.textContent = 'Vypnout sledování polohy';
    locationStatus.textContent = 'Poloha je zobrazena s přesností přibližně ' + Math.round(accuracy) + ' m.';
  }

  function locationError(error) {
    stopLocation();
    if (error.code === error.PERMISSION_DENIED) {
      locationStatus.textContent = 'Prohlížeč nemá povolený přístup k poloze.';
    } else if (error.code === error.TIMEOUT) {
      locationStatus.textContent = 'Polohu se nepodařilo zjistit včas. Zkuste to znovu.';
    } else {
      locationStatus.textContent = 'Aktuální polohu se nepodařilo zjistit.';
    }
  }

  locationButton.addEventListener('click', function () {
    if (locationWatchId !== null) {
      stopLocation();
      return;
    }
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Tento prohlížeč zobrazení polohy nepodporuje.';
      return;
    }
    locationButton.disabled = true;
    locationButton.textContent = 'Zjišťuji polohu…';
    locationStatus.textContent = 'Povolte prohlížeči přístup k poloze.';
    locationWatchId = navigator.geolocation.watchPosition(showLocation, locationError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000
    });
  });

  window.addEventListener('pagehide', function () {
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
  });
}());
