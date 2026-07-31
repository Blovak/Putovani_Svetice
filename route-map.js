(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const routeKey = (params.get('route') || '').toLowerCase();
  const route = window.ROUTES && window.ROUTES[routeKey];
  const routeKeys = ['cervena', 'cerna', 'modra', 'oranzova', 'zluta', 'hneda', 'zelena'];
  const overviewMarkerOffsets = {
    cervena: [-26, -22],
    cerna: [-18, -18],
    modra: [26, -22],
    oranzova: [18, 18],
    zluta: [0, 0],
    hneda: [-26, 22],
    zelena: [26, 22]
  };
  const isOverview = !routeKey;
  const title = document.getElementById('routeTitle');
  const summary = document.getElementById('routeSummary');
  const pointsList = document.getElementById('routePoints');
  const locationButton = document.getElementById('locationButton');
  const locationStatus = document.getElementById('locationStatus');
  const overviewLink = document.getElementById('overviewLink');

  if (!isOverview && !route) {
    title.textContent = 'Trasa nebyla nalezena';
    summary.className = 'error-card';
    summary.textContent = 'Odkaz na mapu neobsahuje platný název trasy.';
    pointsList.hidden = true;
    locationButton.hidden = true;
    document.getElementById('map').hidden = true;
    return;
  }

  if (isOverview) {
    document.documentElement.style.setProperty('--route', '#287346');
    document.documentElement.style.setProperty('--route-dark', '#1f5d38');
    document.documentElement.style.setProperty('--button-text', '#fff');
    document.querySelector('meta[name="theme-color"]').content = '#287346';
    document.title = 'Přehled všech tras – Světické kilometrobrání';
    title.textContent = 'Přehled všech tras';
    summary.textContent = 'Vyberte si trasu klepnutím na její barvu nebo název.';
    overviewLink.hidden = true;
    overviewLink.parentElement.classList.add('map-actions--single');
    document.getElementById('map').setAttribute('aria-label', 'Interaktivní přehled všech tras');

    routeKeys.forEach(function (key) {
      const itemRoute = window.ROUTES[key];
      const item = document.createElement('li');
      const colorLink = document.createElement('a');
      const swatch = document.createElement('span');
      const link = document.createElement('a');
      const details = document.createElement('span');
      const start = itemRoute.points.find(function (point) { return point.label === 'START'; });
      const finish = itemRoute.points.find(function (point) { return point.label === 'CÍL'; });
      item.className = 'route-overview-item';
      swatch.className = 'route-swatch';
      swatch.style.backgroundColor = itemRoute.color;
      swatch.setAttribute('aria-hidden', 'true');
      colorLink.href = 'mapa.html?route=' + key;
      colorLink.setAttribute('aria-label', 'Zobrazit ' + itemRoute.name.toLowerCase() + ' trasu');
      colorLink.appendChild(swatch);
      link.href = 'mapa.html?route=' + key;
      link.textContent = itemRoute.name + ' · ' + itemRoute.length.toLocaleString('cs-CZ', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }) + ' km';
      details.className = 'route-overview-endpoints';
      details.textContent = 'START: ' + pointPlace(start) + ' · CÍL: ' + pointPlace(finish);
      item.append(colorLink, link, details);
      pointsList.appendChild(item);
    });
  } else {
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
  }

  const map = L.map('map', { preferCanvas: true, zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }

  function pointPlace(point) {
    return point.title.replace(/^[^–]+–\s*/, '');
  }

  const visibleBounds = L.latLngBounds([]);

  if (isOverview) {
    routeKeys.forEach(function (key) {
      const overviewRoute = window.ROUTES[key];
      L.polyline(overviewRoute.coordinates, {
        color: '#fff',
        weight: 10,
        opacity: .9,
        lineJoin: 'round',
        interactive: false
      }).addTo(map);
      visibleBounds.extend(L.latLngBounds(overviewRoute.coordinates));
    });

    routeKeys.forEach(function (key) {
      const overviewRoute = window.ROUTES[key];
      const line = L.polyline(overviewRoute.coordinates, {
        color: overviewRoute.color,
        weight: 6,
        opacity: .96,
        lineJoin: 'round'
      }).addTo(map);
      const distance = overviewRoute.length.toLocaleString('cs-CZ', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      });
      line.bindPopup(
        '<strong>' + escapeHtml(overviewRoute.name) + ' trasa · ' + distance + ' km</strong>' +
        '<br><a class="route-popup-link" href="mapa.html?route=' + key + '">Zobrazit detail trasy</a>'
      );
      line.on('mouseover', function () {
        line.setStyle({ weight: 9, opacity: 1 });
        line.bringToFront();
      });
      line.on('mouseout', function () { line.setStyle({ weight: 6, opacity: .96 }); });

      overviewRoute.points.forEach(function (point) {
        if (point.label !== 'START' && point.label !== 'CÍL') return;
        const size = point.label === 'START' ? 48 : 38;
        const offset = overviewMarkerOffsets[key];
        const icon = L.divIcon({
          className: '',
          html: '<span class="overview-endpoint-marker" style="--marker-color:' +
            escapeHtml(overviewRoute.color) + ';--marker-text:' +
            escapeHtml(overviewRoute.textColor || '#fff') + '">' +
            escapeHtml(point.label) + '</span>',
          iconSize: [size, 28],
          iconAnchor: [size / 2 - offset[0], 14 - offset[1]],
          popupAnchor: [0, -14]
        });
        L.marker(point.position, {
          icon: icon,
          title: overviewRoute.name + ' trasa – ' + point.title,
          keyboard: true,
          zIndexOffset: point.label === 'START' ? 200 : 100
        }).addTo(map).bindPopup(
          '<strong>' + escapeHtml(overviewRoute.name) + ' trasa – ' +
          escapeHtml(point.label) + '</strong><br>' + escapeHtml(pointPlace(point)) +
          '<br><a class="route-popup-link" href="mapa.html?route=' + key +
          '">Zobrazit detail trasy</a>'
        );
        visibleBounds.extend(point.position);
      });
    });
  } else {
    L.polyline(route.coordinates, {
      color: '#fff',
      weight: 10,
      opacity: .94,
      lineJoin: 'round'
    }).addTo(map);

    L.polyline(route.coordinates, {
      color: route.color,
      weight: 6,
      opacity: 1,
      lineJoin: 'round'
    }).addTo(map);
    visibleBounds.extend(L.latLngBounds(route.coordinates));
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

  if (!isOverview) {
    route.points.forEach(function (point) {
      L.marker(point.position, {
        icon: markerIcon(point),
        title: point.title,
        keyboard: true,
        zIndexOffset: point.label === 'QR' ? 500 : 0
      }).addTo(map).bindPopup('<strong>' + escapeHtml(point.title) + '</strong>');
      visibleBounds.extend(point.position);
    });
  }

  map.fitBounds(visibleBounds, {
    paddingTopLeft: [24, isOverview ? 340 : 260],
    paddingBottomRight: [24, 24],
    maxZoom: isOverview ? 13 : 16
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
