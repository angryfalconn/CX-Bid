const fields = [
  'jobRef', 'loadedMiles', 'emptyMiles', 'returnMiles', 'mpg', 'fuelPrice',
  'vehicleCost', 'otherCosts', 'waitHours', 'hourlyRate', 'parkingBufferMinutes', 'margin', 'roundTo',
  'marketPrice', 'otherBids', 'cxRate', 'useMarket', 'insuranceMonthly', 'averagePayout',
  'monthlyTarget', 'dailyTarget', 'workingDays', 'hoursPerDay'
];
const inputs = Object.fromEntries(fields.map(id => [id, document.getElementById(id)]));
function localDateTimeValue(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const departureInput = document.getElementById('plannedDeparture');
const homeInput = document.getElementById('startPostcode');
const homeSaveButton = document.getElementById('saveHomePostcode');
const startModeInput = document.getElementById('startLocationMode');
const manualStartWrap = document.getElementById('manualStartWrap');
const startLocationStatus = document.getElementById('startLocationStatus');
let phoneStartPoint = null;
const extraStopsContainer = document.getElementById('extraStops');
let routeStopTiming = [], lastRoutePoints = [], googleMap = null, googleTrafficLayer = null, googlePolylines = [], googleMarkers = [], googleLoadPromise = null, activeGoogleKey = null, routeProvider = 'osrm';
departureInput.value = localDateTimeValue(new Date());
const googleKeyInput = document.getElementById('googleMapsKey');
googleKeyInput.value = localStorage.getItem('routerate-google-maps-key') || '';
const mapStatus = document.getElementById('mapIntegrationStatus');
const currency = n => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number.isFinite(n) ? n : 0);
const number = id => Number(inputs[id].value) || 0;
const savedHomePostcode = localStorage.getItem('routerate-home-postcode');
if (savedHomePostcode) { homeInput.value = savedHomePostcode; startModeInput.value = 'postcode'; }
const saved = JSON.parse(localStorage.getItem('routerate-settings') || 'null');
if (saved) for (const id of fields) if (saved[id] !== undefined) {
  if (id === 'useMarket') inputs[id].checked = saved[id] === true || saved[id] === 'true';
  else inputs[id].value = saved[id];
}

let quote = {}, routeDurationHours = 0, routeToDeliveryHours = 0, routeDepartureTime = null, collectionDriveSeconds = 0, deliveryDriveSeconds = 0, hasRoute = false, map, routeLayer, markers = [];
const setRouteStatus = (message, type = '') => {
  const el = document.getElementById('routeStatus');
  el.textContent = message;
  el.className = `route-status ${type}`;
};
function initMap() {
  const notice = document.getElementById('mapNotice');
  if (!window.L) {
    notice.hidden = false;
    notice.textContent = 'The map library could not load. Your route calculation may still work; allow access to unpkg.com to show the map.';
    return;
  }
  map = L.map('routeMap', { scrollWheelZoom: false }).setView([54.5, -3.2], 5);
  let layer, failedTiles = 0, usingFallback = false;
  const addTiles = fallback => {
    if (layer) map.removeLayer(layer);
    failedTiles = 0;
    usingFallback = fallback;
    layer = L.tileLayer(fallback
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: fallback ? 'abcd' : 'abc',
        attribution: fallback ? '&copy; OpenStreetMap contributors &copy; CARTO' : '&copy; OpenStreetMap contributors'
      }).addTo(map);
    layer.on('tileerror', () => {
      failedTiles++;
      if (failedTiles >= 3 && !usingFallback) addTiles(true);
      else if (failedTiles >= 3 && usingFallback) {
        notice.hidden = false;
        notice.textContent = 'Map tiles are blocked or unavailable from both map sources. Check this page’s network permissions; the postcode route and mileage calculation are separate.';
      }
    });
    layer.on('tileload', () => { failedTiles = 0; notice.hidden = true; });
  };
  addTiles(false);
  setTimeout(() => map.invalidateSize(), 100);
}
function renumberStops() {
  [...extraStopsContainer.querySelectorAll('.extra-stop-row')].forEach((row, index) => {
    const label = row.querySelector('label');
    const input = row.querySelector('input');
    const id = `extraStop${index + 1}`;
    let caption = label.querySelector('.stop-caption');
    if (!caption) { caption = document.createElement('span'); caption.className = 'stop-caption'; input.before(caption); }
    caption.textContent = `Stop ${index + 1} postcode`;
    label.htmlFor = id;
    input.id = id;
    input.setAttribute('aria-label', `Stop ${index + 1} postcode`);
  });
}
function addStop(value = '') {
  const row = document.createElement('div');
  row.className = 'extra-stop-row';
  const label = document.createElement('label'); label.className = 'field';
  const input = document.createElement('input'); input.type = 'text'; input.autocomplete = 'postal-code'; input.placeholder = 'e.g. M1 or SW1A'; input.value = value;
  label.append(input);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-stop'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove postcode stop');
  remove.addEventListener('click', () => { lastRoutePoints = []; row.remove(); renumberStops(); refreshParkingStops(); updateNavigationLinks(); });
  row.append(label, remove); extraStopsContainer.append(row); renumberStops();
}
document.getElementById('addStop').addEventListener('click', () => { lastRoutePoints = []; addStop(); refreshParkingStops(); updateNavigationLinks(); });
homeSaveButton.addEventListener('click', () => {
  const home = homeInput.value.trim().toUpperCase();
  if (!home) { toast('Enter a postcode to save it on this device.'); return; }
  homeInput.value = home; localStorage.setItem('routerate-home-postcode', home);
  homeSaveButton.textContent = 'Postcode saved'; setTimeout(() => homeSaveButton.textContent = 'Save postcode on this device', 1800);
});
function setStartMode() {
  manualStartWrap.hidden = startModeInput.value !== 'postcode';
  startLocationStatus.textContent = startModeInput.value === 'gps' ? 'GPS will be requested when you calculate the route.' : 'Enter a postcode above, or switch back to phone GPS.';
  if (startModeInput.value === 'gps') phoneStartPoint = null;
  lastRoutePoints = []; refreshParkingStops(); updateNavigationLinks();
}
startModeInput.addEventListener('change', setStartMode);
function getPhoneLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser does not provide GPS location.')); return; }
    navigator.geolocation.getCurrentPosition(position => resolve({ lat: position.coords.latitude, lon: position.coords.longitude, label: 'Phone GPS', approx: false }), error => reject(new Error(`Phone location unavailable: ${error.message}. Allow location access or enter a postcode instead.`)), { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
  });
}
document.getElementById('locateStartButton').addEventListener('click', async () => {
  startModeInput.value = 'gps'; manualStartWrap.hidden = true; startLocationStatus.textContent = 'Requesting this phone’s location…';
  try { phoneStartPoint = await getPhoneLocation(); startLocationStatus.textContent = 'Using this phone’s current location for the route.'; refreshParkingStops(); updateNavigationLinks(); toast('Phone location is ready as your starting point.'); }
  catch (error) { startLocationStatus.textContent = error.message; }
});
function loadGoogleMapsApi(key) {
  if (window.google?.maps?.importLibrary) {
    if (activeGoogleKey && activeGoogleKey !== key) throw new Error('Reload RouteRate to apply a changed Google key.');
    return Promise.resolve();
  }
  if (googleLoadPromise) return googleLoadPromise;
  googleLoadPromise = new Promise((resolve, reject) => {
    window.routeRateGoogleReady = () => { activeGoogleKey = key; resolve(); };
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=routeRateGoogleReady`;
    script.onerror = () => reject(new Error('Google Maps failed to load. Check the key restrictions and enabled APIs.'));
    document.head.append(script);
  }).catch(error => { googleLoadPromise = null; throw error; });
  return googleLoadPromise;
}
async function ensureGoogleMap(key = googleKeyInput.value.trim()) {
  if (!key) throw new Error('Add a Google Maps API key in the quote settings first.');
  await loadGoogleMapsApi(key);
  document.getElementById('routeMap').hidden = true;
  document.getElementById('googleRouteMap').hidden = false;
  const { Map, TrafficLayer } = await google.maps.importLibrary('maps');
  if (!googleMap) {
    googleMap = new Map(document.getElementById('googleRouteMap'), { center: { lat: 54.5, lng: -3.2 }, zoom: 5, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    googleTrafficLayer = new TrafficLayer({ autoRefresh: true });
  }
  googleTrafficLayer.setMap(googleMap);
  setTimeout(() => google.maps.event.trigger(googleMap, 'resize'), 100);
  mapStatus.textContent = 'Google map with refreshed live traffic layer. Tap Recalculate route to refresh the traffic-aware route and ETAs.';
  return { Map, TrafficLayer };
}
async function getGoogleTrafficRoute(points) {
  await ensureGoogleMap();
  const { Route } = await google.maps.importLibrary('routes');
  const planned = Date.parse(departureInput.value);
  const request = {
    origin: { lat: points[0].lat, lng: points[0].lon },
    destination: { lat: points[points.length - 1].lat, lng: points[points.length - 1].lon },
    intermediates: points.slice(1, -1).map(point => ({ location: { lat: point.lat, lng: point.lon }, via: false })),
    travelMode: 'DRIVING',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    trafficModel: 'BEST_GUESS',
    extraComputations: ['TRAFFIC_ON_POLYLINE'],
    fields: ['path', 'speedPaths', 'routeLabels', 'distanceMeters', 'durationMillis', 'staticDurationMillis', 'legs.distanceMeters', 'legs.durationMillis'],
    language: 'en-GB',
    units: google.maps.UnitSystem.IMPERIAL
  };
  if (Number.isFinite(planned) && planned > Date.now()) request.departureTime = new Date(planned);
  const { routes } = await Route.computeRoutes(request);
  if (!routes?.length || !routes[0].legs?.length) throw new Error('Google did not return a complete traffic-aware route.');
  return routes[0];
}
function drawGoogleRoute(route, points, labels) {
  googlePolylines.forEach(line => line.setMap(null)); googlePolylines = route.createPolylines();
  googlePolylines.forEach(line => line.setMap(googleMap));
  googleMarkers.forEach(marker => marker.setMap(null));
  googleMarkers = points.map((point, index) => new google.maps.Marker({ map: googleMap, position: { lat: point.lat, lng: point.lon }, title: `${labels[index]}: ${point.label}` }));
  if (route.viewport) googleMap.fitBounds(route.viewport);
  else if (route.path?.length) { const bounds = new google.maps.LatLngBounds(); route.path.forEach(point => bounds.extend(point)); googleMap.fitBounds(bounds); }
}
function showLeafletMap() {
  document.getElementById('googleRouteMap').hidden = true;
  document.getElementById('routeMap').hidden = false;
  if (map) setTimeout(() => map.invalidateSize(), 50);
}
function navigationValues() {
  const start = startModeInput.value === 'gps' ? (phoneStartPoint ? `${phoneStartPoint.lat},${phoneStartPoint.lon}` : '') : homeInput.value.trim();
  if (!start) return [];
  return [start, document.getElementById('pickupPostcode').value.trim(), ...[...extraStopsContainer.querySelectorAll('input')].map(input => input.value.trim()).filter(Boolean), document.getElementById('deliveryPostcode').value.trim()].filter(Boolean);
}
function updateNavigationLinks(values = navigationValues()) {
  const googleLink = document.getElementById('googleMapsLink');
  const wazeLink = document.getElementById('wazeLink');
  const home = values[0], delivery = values[values.length - 1];
  if (values.length >= 2) {
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1'); url.searchParams.set('origin', home); url.searchParams.set('destination', home); url.searchParams.set('travelmode', 'driving');
    url.searchParams.set('waypoints', values.slice(1).join('|'));
    googleLink.href = url.toString();
    const waze = new URL('https://waze.com/ul'); waze.searchParams.set('q', delivery); waze.searchParams.set('navigate', 'yes'); waze.searchParams.set('utm_source', 'routerate');
    wazeLink.href = waze.toString();
  }
}
function refreshParkingStops(values = navigationValues()) {
  const select = document.getElementById('parkingPostcode');
  const oldValue = select.value; select.replaceChildren();
  const names = ['Home', 'Collection', ...values.slice(2, -1).map((_, index) => `Stop ${index + 1}`), 'Delivery'];
  values.forEach((postcode, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${names[index]} - ${postcode}`; select.append(option); });
  if ([...select.options].some(option => option.value === oldValue)) select.value = oldValue;
  else if (select.options.length) select.value = String(select.options.length - 1);
}
async function searchParking() {
  const parkingButton = document.getElementById('parkingSearchButton');
  parkingButton.disabled = true; parkingButton.textContent = 'Searching...';
  const values = navigationValues();
  if (!values.length) { parkingButton.disabled = false; parkingButton.textContent = 'Search parking'; return; }
  const selectedIndex = Number(document.getElementById('parkingPostcode').value);
  const index = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < values.length ? selectedIndex : values.length - 1;
  const postcode = values[index] || values[values.length - 1];
  const results = document.getElementById('parkingResults'); results.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = `Parking near ${postcode}`; results.append(heading);
  try {
    await ensureGoogleMap();
    const { Place } = await google.maps.importLibrary('places');
    const point = lastRoutePoints[index] || await lookupPostcode(postcode);
    const { places = [] } = await Place.searchByText({
      textQuery: `parking near ${postcode}`, region: 'gb', maxResultCount: 5,
      locationBias: { center: { lat: point.lat, lng: point.lon }, radius: 3000 },
      fields: ['displayName', 'formattedAddress', 'googleMapsURI', 'parkingOptions']
    });
    if (!places.length) { const note = document.createElement('p'); note.textContent = 'No parking places found near this postcode. Try the Google Maps search link.'; results.append(note); parkingButton.disabled = false; parkingButton.textContent = 'Search parking'; return; }
    places.forEach(place => {
      const row = document.createElement('div'); row.className = 'parking-result';
      const link = document.createElement('a'); link.textContent = place.displayName || 'Parking place'; link.href = place.googleMapsURI || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`parking near ${postcode}`)}`; link.target = '_blank'; link.rel = 'noopener';
      const detail = document.createElement('small'); detail.textContent = place.formattedAddress || 'Address not available';
      const options = place.parkingOptions || {};
      const facilities = [['hasFreeParkingLot','Free parking lot'],['hasPaidParkingLot','Paid parking lot'],['hasFreeGarageParking','Free garage'],['hasPaidGarageParking','Paid garage'],['hasFreeStreetParking','Free street parking'],['hasPaidStreetParking','Paid street parking']].filter(([key]) => options[key] === true).map(([, label]) => label);
      const status = document.createElement('small'); status.textContent = facilities.length ? facilities.join(' - ') : 'Parking place listed; live space occupancy is not available';
      row.append(link, detail, status); results.append(row);
    });
    parkingButton.disabled = false; parkingButton.textContent = 'Search parking';
  } catch (error) {
    const fallback = document.createElement('a'); fallback.textContent = `Search parking near ${postcode} in Google Maps`; fallback.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`parking near ${postcode}`)}`; fallback.target = '_blank'; fallback.rel = 'noopener'; results.append(fallback);
    const note = document.createElement('small'); note.textContent = `In-page parking search unavailable: ${error.message}`; results.append(note);
    parkingButton.disabled = false; parkingButton.textContent = 'Search parking';
  }
}
document.getElementById('saveGoogleKey').addEventListener('click', async () => {
  const key = googleKeyInput.value.trim();
  if (!key) { localStorage.removeItem('routerate-google-maps-key'); googleLoadPromise = null; googleTrafficLayer?.setMap(null); showLeafletMap(); mapStatus.textContent = 'Google key removed. OpenStreetMap routing remains available.'; return; }
  localStorage.setItem('routerate-google-maps-key', key);
  try { await ensureGoogleMap(key); document.getElementById('saveGoogleKey').textContent = 'Google Maps connected'; }
  catch (error) { mapStatus.textContent = error.message; }
});
document.getElementById('googleTrafficButton').addEventListener('click', async () => {
  try { await ensureGoogleMap(); }
  catch (error) { mapStatus.textContent = error.message; document.querySelector('.settings-drawer').open = true; googleKeyInput.focus(); }
});
document.getElementById('parkingSearchButton').addEventListener('click', searchParking);
document.getElementById('quoteForm').addEventListener('submit', event => event.preventDefault());
async function lookupPostcode(value) {
  const coordinates = value.trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (coordinates) return { lat: Number(coordinates[1]), lon: Number(coordinates[2]), label: 'Phone GPS', approx: false };
  const postcode = value.trim().toUpperCase();
  if (!postcode) throw Error('Enter a starting postcode or use this phone’s GPS, then add collection and delivery postcodes.');
  const compact = postcode.replace(/\s+/g, '');
  if (compact.length > 4) {
    const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.status === 200 && data.result) return { lat: data.result.latitude, lon: data.result.longitude, label: data.result.postcode || postcode, approx: false };
    }
  }
  if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(compact)) throw Error(`“${postcode}” is not a recognised outward code. Enter its first part, such as M1 or SW1A, or a full postcode.`);
  const response = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(compact)}`);
  if (!response.ok) throw Error(`Could not find postcode area ${compact}. Check it and try again.`);
  const data = await response.json();
  if (data.status !== 200 || !data.result) throw Error(`Could not find postcode area ${compact}. Check it and try again.`);
  return { lat: data.result.latitude, lon: data.result.longitude, label: data.result.outcode || compact, approx: true };
}
const toMiles = metres => metres / 1609.344;
function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60), hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
function renderStopEtas() {
  const container = document.getElementById('stopEtas'); container.replaceChildren();
  routeStopTiming.forEach(stop => {
    const row = document.createElement('div'); row.className = 'stop-eta-row';
    const label = document.createElement('span'); label.textContent = stop.label;
    const detail = document.createElement('small'); detail.textContent = `${stop.miles.toFixed(1)} mi from home`;
    const eta = document.createElement('strong'); eta.dataset.stopSeconds = String(stop.seconds); eta.dataset.stopOrder = String(stop.stopOrder); eta.textContent = '--:--';
    row.append(label, detail, eta); container.append(row);
  });
}
function ukClock(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
function updateTiming() {
  const now = new Date();
  document.getElementById('liveClock').textContent = `${ukClock(now)}:${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', second: '2-digit' }).format(now)}`;
  if (!routeDepartureTime || !hasRoute) return;
  const pickup = new Date(routeDepartureTime + collectionDriveSeconds * 1000);
  const bufferSeconds = number('parkingBufferMinutes') * 60;
  const stopsBeforeDelivery = hasRoute ? routeStopTiming.length + 1 : 0;
  const delivery = new Date(routeDepartureTime + (deliveryDriveSeconds + number('waitHours') * 3600 + bufferSeconds * stopsBeforeDelivery) * 1000);
  const etaText = date => `${ukClock(date)}${new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'2-digit',month:'short'}).format(date) !== new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'2-digit',month:'short'}).format(now) ? ` - ${new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'2-digit',month:'short'}).format(date)}` : ''}`;
  document.getElementById('collectionEta').textContent = etaText(pickup);
  document.getElementById('deliveryEta').textContent = etaText(delivery);
  document.querySelectorAll('.stop-eta-row strong[data-stop-seconds]').forEach(el => {
    const stopEta = new Date(routeDepartureTime + (Number(el.dataset.stopSeconds) + number('waitHours') * 3600 + number('parkingBufferMinutes') * 60 * Number(el.dataset.stopOrder || 1)) * 1000);
    el.textContent = etaText(stopEta);
  });
  document.getElementById('collectionEtaDetail').textContent = `After ${formatDuration(collectionDriveSeconds)} drive`;
  document.getElementById('deliveryEtaDetail').textContent = `After ${formatDuration(deliveryDriveSeconds)} drive${number('waitHours') ? ` + ${number('waitHours').toFixed(1)} hr wait` : ''}`;
}
departureInput.addEventListener('input', () => {
  routeDepartureTime = departureInput.value ? Date.parse(departureInput.value) : null;
  updateTiming();
});
departureInput.addEventListener('change', () => { if (hasRoute && routeProvider === 'google') calculateRoute(); });
setInterval(updateTiming, 1000);
async function calculateRoute() {
  const button = document.getElementById('routeButton');
  button.disabled = true; button.classList.add('loading'); routeProvider = 'osrm';
  const hasGoogleKey = Boolean(googleKeyInput.value.trim());
  button.querySelector('span').textContent = hasGoogleKey ? 'Finding traffic-aware route...' : 'Finding route...';
  setRouteStatus(hasGoogleKey ? 'Looking up postcodes and checking current traffic...' : 'Looking up postcodes and calculating standard road times...');
  let routeSource = 'osrm', fallbackMessage = '';
  try {
    if (startModeInput.value === 'gps') {
      startLocationStatus.textContent = 'Getting this phone’s current location…';
      phoneStartPoint = await getPhoneLocation();
      startLocationStatus.textContent = 'Using this phone’s current location for the route.';
    }
    const values = navigationValues();
    if (values.length < 3) throw Error('Choose phone GPS or enter a starting postcode, then add collection and delivery postcodes.');
    const points = await Promise.all(values.map(lookupPostcode));
    lastRoutePoints = points; updateNavigationLinks(values); refreshParkingStops(values);
    let route, legDistances, legDurations, path = null;
    const key = googleKeyInput.value.trim();
    if (key) {
      try {
        localStorage.setItem('routerate-google-maps-key', key);
        route = await getGoogleTrafficRoute(points);
        routeSource = 'google';
        legDistances = route.legs.map(leg => Number(leg.distanceMeters));
        legDurations = route.legs.map(leg => Number(leg.durationMillis) / 1000);
        path = route.path;
      } catch (error) {
        fallbackMessage = `Google traffic route unavailable (${error.message}); using a standard route estimate.`;
      }
    }
    if (routeSource !== 'google') {
      const coords = [...points, points[0]].map(point => `${point.lon},${point.lat}`).join(';');
      const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
      if (!response.ok) throw Error('The route service could not be reached. Try again shortly.');
      const result = await response.json();
      if (result.code !== 'Ok' || !result.routes?.[0]) throw Error('No drivable route found for those postcodes.');
      route = result.routes[0];
      legDistances = route.legs.map(leg => leg.distance);
      legDurations = route.legs.map(leg => leg.duration);
      path = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lng: lon }));
      showLeafletMap();
    }
    if (legDistances.length !== points.length || legDurations.some(value => !Number.isFinite(value))) throw Error('The map service returned an incomplete route.');
    const legMiles = legDistances.map(toMiles), total = legMiles.reduce((a, b) => a + b, 0);
    const totalDuration = legDurations.reduce((a, b) => a + b, 0);
    routeDurationHours = totalDuration / 3600;
    const returnIndex = legDistances.length - 1;
    const emptyMiles = legMiles[0], loadedMiles = legMiles.slice(1, returnIndex).reduce((a, b) => a + b, 0), returnMiles = legMiles[returnIndex];
    const loadedSeconds = legDurations.slice(1, returnIndex).reduce((a, b) => a + b, 0);
    routeToDeliveryHours = (legDurations[0] + loadedSeconds) / 3600;
    collectionDriveSeconds = legDurations[0];
    deliveryDriveSeconds = legDurations.slice(0, returnIndex).reduce((a, b) => a + b, 0);
    routeStopTiming = [];
    let cumulativeMiles = 0, cumulativeSeconds = 0;
    for (let i = 1; i < points.length; i++) {
      cumulativeMiles += legMiles[i - 1]; cumulativeSeconds += legDurations[i - 1];
      if (i > 1 && i < points.length - 1) routeStopTiming.push({ label: `Stop ${i - 1}: ${points[i].label}`, miles: cumulativeMiles, seconds: cumulativeSeconds, stopOrder: i - 1 });
    }
    renderStopEtas();
    const now = Date.now(), planned = Date.parse(departureInput.value);
    routeDepartureTime = Number.isFinite(planned) && planned > now ? planned : now;
    hasRoute = true; routeProvider = routeSource;
    document.getElementById('emptyMiles').value = emptyMiles.toFixed(1);
    document.getElementById('loadedMiles').value = loadedMiles.toFixed(1);
    document.getElementById('returnMiles').value = returnMiles.toFixed(1);
    document.getElementById('emptyLeg').textContent = `${emptyMiles.toFixed(1)} mi`;
    document.getElementById('loadedLeg').textContent = `${loadedMiles.toFixed(1)} mi`;
    document.getElementById('returnLeg').textContent = `${returnMiles.toFixed(1)} mi`;
    document.getElementById('roundTripMiles').textContent = `${total.toFixed(1)} mi`;
    document.getElementById('milesToCollection').textContent = `${emptyMiles.toFixed(1)} mi`;
    document.getElementById('milesToDelivery').textContent = `${(emptyMiles + loadedMiles).toFixed(1)} mi`;
    document.getElementById('emptyTime').textContent = `${formatDuration(legDurations[0])} drive`;
    document.getElementById('loadedTime').textContent = `${formatDuration(loadedSeconds)} drive`;
    document.getElementById('returnTime').textContent = `${formatDuration(legDurations[returnIndex])} drive`;
    document.getElementById('roundTripTime').textContent = `${formatDuration(totalDuration)} driving`;
    if (routeSource === 'google') {
      await ensureGoogleMap();
      const labels = ['HOME', 'COLLECTION', ...points.slice(2, -1).map((_, index) => `STOP ${index + 1}`), 'DELIVERY'];
      drawGoogleRoute(route, points, labels);
      document.getElementById('googleTrafficButton').textContent = 'Google live traffic enabled';
    } else if (map && path) {
      if (routeLayer) map.removeLayer(routeLayer);
      markers.forEach(marker => map.removeLayer(marker)); markers = [];
      routeLayer = L.polyline(path.map(point => [point.lat, point.lng]), { color: '#347854', weight: 5, opacity: .85 }).addTo(map);
      const labels = ['HOME', 'COLLECTION', ...points.slice(2, -1).map((_, index) => `STOP ${index + 1}`), 'DELIVERY'];
      points.forEach((point, index) => {
        const marker = L.circleMarker([point.lat, point.lon], { radius: 7, color: '#fff', weight: 2, fillColor: index === 0 ? '#173e2f' : index === 1 ? '#dc9859' : '#5e86bb', fillOpacity: 1 }).bindTooltip(`${labels[index]} - ${point.label}${point.approx ? ' - area centre' : ''}`).addTo(map);
        markers.push(marker);
      });
      map.fitBounds(routeLayer.getBounds().pad(.12));
    }
    updateTiming(); calculate();
    const approximate = points.some(point => point.approx);
    const traffic = routeSource === 'google' ? ' Google traffic-aware route.' : ' Traffic is not included in this estimate.';
    setRouteStatus(`Route calculated${approximate ? ' using postcode area centres' : ''} through ${points.length} postcodes and back home. ${total.toFixed(1)} road miles.${traffic}${fallbackMessage ? ` ${fallbackMessage}` : ''}`, 'success');
  } catch (error) {
    routeDurationHours = 0; routeToDeliveryHours = 0; routeDepartureTime = null; collectionDriveSeconds = 0; deliveryDriveSeconds = 0; hasRoute = false; routeStopTiming = []; renderStopEtas();
    document.getElementById('collectionEta').textContent = '--:--'; document.getElementById('deliveryEta').textContent = '--:--';
    document.getElementById('milesToCollection').textContent = '-- mi'; document.getElementById('milesToDelivery').textContent = '-- mi';
    for (const id of ['loadedMiles', 'emptyMiles', 'returnMiles']) inputs[id].value = '0';
    for (const id of ['emptyLeg', 'loadedLeg', 'returnLeg', 'roundTripMiles', 'emptyTime', 'loadedTime', 'returnTime', 'roundTripTime']) document.getElementById(id).textContent = '--';
    calculate(); setRouteStatus(error.message, 'error');
  } finally {
    button.disabled = false; button.classList.remove('loading');
    button.querySelector('span').textContent = routeProvider === 'google' ? 'Refresh live traffic route' : 'Calculate route & miles';
  }
}

function marketBids() {
  return inputs.otherBids.value.split(/[\s,;]+/).map(value => Number(value.replace(/[£,]/g, ''))).filter(value => Number.isFinite(value) && value > 0);
}
function renderMarket(bids, benchmarks) {
  const badge = document.getElementById('marketBadge'), lowEl = document.getElementById('marketLow');
  const avgEl = document.getElementById('marketAverage'), pos = document.getElementById('marketPosition'), advice = document.getElementById('marketAdvice');
  const guideValue = quote.cxGuideValue || 0;
  const observedAverage = bids.length ? bids.reduce((a, b) => a + b, 0) / bids.length : number('marketPrice');
  lowEl.textContent = guideValue ? currency(guideValue) : '--';
  avgEl.textContent = observedAverage ? currency(observedAverage) : '--';
  const difference = quote.bid - guideValue;
  pos.textContent = guideValue ? (difference >= 0 ? `+${currency(difference)}` : `-${currency(Math.abs(difference))}`) : '--';
  if (benchmarks.length && inputs.useMarket.checked) badge.textContent = 'LISTING DATA';
  else badge.textContent = 'PUBLIC GUIDE';
  if (observedAverage) advice.textContent = `Visible listing average is ${currency(observedAverage)}. The CX guide estimate is ${currency(guideValue)} at ${currency(number('cxRate'))} per loaded mile. The app keeps your target-margin floor.`;
  else advice.textContent = `Guide estimate: ${currency(number('cxRate'))} per loaded mile, or ${currency(guideValue)} for this route. CX says actual averages vary by vehicle, lane and week; use the rate shown in your CX account for a closer comparison.`;
}
function calculate() {
  const loaded = number('loadedMiles'), empty = number('emptyMiles'), back = number('returnMiles');
  const miles = loaded + empty + back, mpg = number('mpg'), litresPerGallon = 4.54609;
  const fuel = mpg > 0 ? (miles / mpg) * litresPerGallon * number('fuelPrice') : 0;
  const milesToDelivery = loaded + empty;
  const fuelToDelivery = mpg > 0 ? (milesToDelivery / mpg) * litresPerGallon * number('fuelPrice') : 0;
  const perMile = number('vehicleCost');
  const vehicle = miles * perMile, vehicleToDelivery = milesToDelivery * perMile, vehicleReturn = back * perMile;
  const hourlyRate = number('hourlyRate');
  const bufferHours = hasRoute ? (number('parkingBufferMinutes') / 60) * (routeStopTiming.length + 1) : 0;
  const time = (number('waitHours') + routeDurationHours + bufferHours) * hourlyRate;
  const timeToDelivery = (number('waitHours') + routeToDeliveryHours + bufferHours) * hourlyRate;
  const timeReturn = Math.max(0, routeDurationHours - routeToDeliveryHours) * hourlyRate, other = number('otherCosts');
  const dailyTarget = number('dailyTarget'), monthlyTarget = number('monthlyTarget'), workingDays = Math.max(1, number('workingDays'));
  const averagePayout = Math.max(1, number('averagePayout'));
  const jobsPerDay = Math.max(1, Math.ceil(dailyTarget / averagePayout));
  const insurancePerOrder = number('insuranceMonthly') / (workingDays * jobsPerDay);
  const costs = fuel + vehicle + time + other + insurancePerOrder;
  const fuelReturn = Math.max(0, fuel - fuelToDelivery);
  const costsToDelivery = fuelToDelivery + vehicleToDelivery + timeToDelivery + other + insurancePerOrder;
  const costsReturn = fuelReturn + vehicleReturn + timeReturn;
  const margin = Math.min(90, Math.max(0, number('margin'))) / 100;
  const floorBid = costs / (1 - margin), floorBidToDelivery = costsToDelivery / (1 - margin), bids = marketBids(), market = number('marketPrice');
  const cxGuideValue = loaded * number('cxRate');
  const benchmarks = [...bids, ...(market ? [market] : [])], low = bids.length ? Math.min(...bids) : null;
  let marketTarget = null;
  if (inputs.useMarket.checked) {
    if (low !== null) marketTarget = Math.max(0, low - 1);
    else if (market) marketTarget = market * .97;
    else if (cxGuideValue > 0) marketTarget = cxGuideValue;
  }
  const rawBid = marketTarget === null ? floorBid : Math.max(floorBid, marketTarget);
  const rawBidToDelivery = marketTarget === null ? floorBidToDelivery : Math.max(floorBidToDelivery, marketTarget);
  const step = Number(inputs.roundTo.value) || 1;
  const bid = step === .01 ? Math.ceil(rawBid * 100) / 100 : Math.ceil(rawBid / step) * step;
  const bidToDelivery = step === .01 ? Math.ceil(rawBidToDelivery * 100) / 100 : Math.ceil(rawBidToDelivery / step) * step;
  const profit = bid - costs, neededJobs = Math.max(0, Math.ceil(dailyTarget / averagePayout));
  const hourlyGoal = dailyTarget / Math.max(1, number('hoursPerDay'));
  quote = { loaded, empty, back, miles, mpg, fuel, vehicle, time, other, insurancePerOrder, costs, margin, bid, bidToDelivery, profit, ref: inputs.jobRef.value.trim(), floorBid, cxGuideValue };
  document.getElementById('mobileBidAmount').textContent = currency(bid);
  document.getElementById('suggestedBid').textContent = currency(bid).replace(/[^\d,.\-]/g, '');
  document.getElementById('bidToDelivery').textContent = currency(bidToDelivery).replace(/[^\d,.\-]/g, '');
  document.getElementById('estimatedProfit').textContent = currency(profit);
  document.getElementById('marginLabel').textContent = `${Math.round(margin * 100)}% target margin`;
  document.getElementById('roundedLabel').textContent = step === .01 ? 'no rounding' : `rounded up to nearest £${step}`;
  document.getElementById('totalMiles').textContent = `${miles.toLocaleString('en-GB', { maximumFractionDigits: 1 })} total miles`;
  document.getElementById('fuelToDeliveryDetail').textContent = mpg > 0 ? `${(milesToDelivery / mpg * litresPerGallon).toFixed(1)} L` : 'check mpg';
  document.getElementById('fuelReturnDetail').textContent = mpg > 0 ? `${(back / mpg * litresPerGallon).toFixed(1)} L` : 'check mpg';
  document.getElementById('timeToDeliveryDetail').textContent = `${(routeToDeliveryHours + number('waitHours')).toFixed(1)} hr`;
  document.getElementById('timeReturnDetail').textContent = `${Math.max(0, routeDurationHours - routeToDeliveryHours).toFixed(1)} hr`;
  document.getElementById('fuelToDeliveryTotal').textContent = currency(fuelToDelivery);
  document.getElementById('vehicleToDeliveryTotal').textContent = currency(vehicleToDelivery);
  document.getElementById('timeToDeliveryTotal').textContent = currency(timeToDelivery);
  document.getElementById('fixedToDeliveryTotal').textContent = currency(other + insurancePerOrder);
  document.getElementById('costToDelivery').textContent = currency(costsToDelivery);
  document.getElementById('fuelReturnTotal').textContent = currency(fuelReturn);
  document.getElementById('vehicleReturnTotal').textContent = currency(vehicleReturn);
  document.getElementById('timeReturnTotal').textContent = currency(timeReturn);
  document.getElementById('costReturn').textContent = currency(costsReturn);
  document.getElementById('costBase').textContent = currency(costs);
  document.getElementById('profitTotal').textContent = currency(profit);
  document.getElementById('dailyTargetView').textContent = currency(dailyTarget);
  document.getElementById('monthlyTargetView').textContent = currency(monthlyTarget);
  document.getElementById('jobsPerDayView').textContent = `${neededJobs} ${neededJobs === 1 ? 'job' : 'jobs'}`;
  document.getElementById('hourlyTargetView').textContent = currency(hourlyGoal);
  document.getElementById('targetPace').textContent = dailyTarget * workingDays >= monthlyTarget ? 'ON PACE' : 'TARGET GAP';
  updateTiming();
  document.getElementById('targetSummary').textContent = `At ${currency(averagePayout)} average payout, aim for ${neededJobs} ${neededJobs === 1 ? 'job' : 'jobs'} each workday. Insurance adds ${currency(insurancePerOrder)} per job, assuming ${jobsPerDay} jobs/day over ${workingDays} days.`;
  renderMarket(bids, benchmarks);
  localStorage.setItem('routerate-settings', JSON.stringify(Object.fromEntries(fields.map(id => [id, id === 'useMarket' ? inputs[id].checked : inputs[id].value]))));
}
let toastTimer;
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2200); }
for (const id of fields) { inputs[id].addEventListener('input', calculate); inputs[id].addEventListener('change', calculate); }
document.getElementById('routeButton').addEventListener('click', calculateRoute);
for (const id of ['startPostcode','pickupPostcode','deliveryPostcode']) document.getElementById(id).addEventListener('input', () => { lastRoutePoints = []; refreshParkingStops(); updateNavigationLinks(); });
document.getElementById('copyQuote').addEventListener('click', async () => {
  const ref = quote.ref ? ` for ${quote.ref}` : '';
  const message = `Available for${ref}. My bid is ${currency(quote.bid)} for the full round trip of ${quote.miles.toFixed(1)} miles (${quote.empty.toFixed(1)} miles to collection, ${quote.loaded.toFixed(1)} loaded miles, ${quote.back.toFixed(1)} return miles). I can meet the collection and delivery times—please send the full job details to confirm.`;
  try { await navigator.clipboard.writeText(message); toast('Bid message copied — check the job details before sending.'); }
  catch { const area = document.createElement('textarea'); area.value = message; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); toast('Bid message copied — check the job details before sending.'); }
});
document.getElementById('copyQuoteNoReturn').addEventListener('click', async () => {
  const ref = quote.ref ? ` for ${quote.ref}` : '';
  const message = `Available for${ref}. My bid is ${currency(quote.bidToDelivery)} for ${quote.empty.toFixed(1)} miles to collection and ${quote.loaded.toFixed(1)} loaded miles. This price excludes the return journey from delivery. I can meet the collection and delivery times; please send the full job details to confirm.`;
  try {
    await navigator.clipboard.writeText(message);
    toast('Delivery-only bid copied. It excludes the return journey.');
  } catch {
    const area = document.createElement('textarea');
    area.value = message;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('Delivery-only bid copied. It excludes the return journey.');
  }
});
const settingsDrawer = document.querySelector('.settings-drawer');
if (window.matchMedia('(min-width: 761px)').matches) settingsDrawer.open = true;
const bidDialog = document.getElementById('mobileBidDialog'), dialogContent = document.getElementById('mobileDialogContent');
function openBidDialog() {
  const copy = document.querySelector('.result-panel').cloneNode(true);
  copy.classList.add('mobile-result-copy');
  copy.querySelectorAll('[id]').forEach(el => { el.dataset.sourceId = el.id; el.removeAttribute('id'); });
  dialogContent.replaceChildren(copy);
  copy.addEventListener('click', event => {
    const button = event.target.closest('button[data-source-id]');
    if (button) document.getElementById(button.dataset.sourceId)?.click();
  });
  bidDialog.showModal();
}
document.getElementById('mobileBidTrigger').addEventListener('click', openBidDialog);
document.getElementById('closeMobileDialog').addEventListener('click', () => bidDialog.close());
bidDialog.addEventListener('click', event => { if (event.target === bidDialog) bidDialog.close(); });

let installPromptEvent = null;
const installButton = document.getElementById('installApp');
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (isStandalone) installButton.hidden = true;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPromptEvent = event; installButton.hidden = false; });
installButton.addEventListener('click', async () => {
  if (installPromptEvent) {
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    installPromptEvent = null;
    return;
  }
  toast('iPhone: open this page in Safari, tap Share, then Add to Home Screen. Android: open the browser menu and choose Install app or Add to Home screen.');
});
window.addEventListener('appinstalled', () => { installButton.hidden = true; toast('RouteRate installed.'); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

setStartMode();
refreshParkingStops();
updateNavigationLinks();
initMap();
calculate();
