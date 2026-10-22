const fields = [
  'jobRef', 'loadedMiles', 'emptyMiles', 'returnMiles', 'mpg', 'fuelPrice',
  'vehicleCost', 'otherCosts', 'waitHours', 'hourlyRate', 'margin', 'roundTo',
  'marketPrice', 'otherBids', 'useMarket', 'insuranceMonthly', 'averagePayout',
  'monthlyTarget', 'dailyTarget', 'workingDays', 'hoursPerDay'
];
const inputs = Object.fromEntries(fields.map(id => [id, document.getElementById(id)]));
const currency = n => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number.isFinite(n) ? n : 0);
const number = id => Number(inputs[id].value) || 0;
const saved = JSON.parse(localStorage.getItem('routerate-settings') || 'null');
if (saved) for (const id of fields) if (saved[id] !== undefined) {
  if (id === 'useMarket') inputs[id].checked = saved[id] === true || saved[id] === 'true';
  else inputs[id].value = saved[id];
}

let quote = {}, routeDurationHours = 0, routeToDeliveryHours = 0, map, routeLayer, markers = [];
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
async function lookupPostcode(value) {
  const postcode = value.trim().toUpperCase();
  if (!postcode) throw Error('Enter all three postcodes.');
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
async function calculateRoute() {
  const button = document.getElementById('routeButton');
  button.disabled = true;
  button.classList.add('loading');
  button.querySelector('span').textContent = 'Finding route…';
  setRouteStatus('Looking up postcode areas and calculating the round trip…');
  try {
    const values = ['startPostcode', 'pickupPostcode', 'deliveryPostcode'].map(id => document.getElementById(id).value);
    if (values.some(value => !value.trim())) throw Error('Enter your starting, collection and delivery postcodes.');
    const points = await Promise.all(values.map(lookupPostcode));
    const coords = [points[0], points[1], points[2], points[0]].map(p => `${p.lon},${p.lat}`).join(';');
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    if (!response.ok) throw Error('The route service could not be reached. Try again shortly.');
    const result = await response.json();
    if (result.code !== 'Ok' || !result.routes?.[0]) throw Error('No drivable route found for those postcodes.');
    const route = result.routes[0], legs = route.legs;
    if (legs.length !== 3) throw Error('The route service returned an incomplete route.');
    const legMiles = legs.map(leg => toMiles(leg.distance)), total = legMiles.reduce((a, b) => a + b, 0);
    const legDurations = legs.map(leg => leg.duration), totalDuration = legDurations.reduce((a, b) => a + b, 0);
    routeDurationHours = route.duration / 3600;
    routeToDeliveryHours = (legs[0].duration + legs[1].duration) / 3600;
    document.getElementById('emptyMiles').value = legMiles[0].toFixed(1);
    document.getElementById('loadedMiles').value = legMiles[1].toFixed(1);
    document.getElementById('returnMiles').value = legMiles[2].toFixed(1);
    document.getElementById('emptyLeg').textContent = `${legMiles[0].toFixed(1)} mi`;
    document.getElementById('loadedLeg').textContent = `${legMiles[1].toFixed(1)} mi`;
    document.getElementById('returnLeg').textContent = `${legMiles[2].toFixed(1)} mi`;
    document.getElementById('roundTripMiles').textContent = `${total.toFixed(1)} mi`;
    document.getElementById('emptyTime').textContent = `${formatDuration(legDurations[0])} drive`;
    document.getElementById('loadedTime').textContent = `${formatDuration(legDurations[1])} drive`;
    document.getElementById('returnTime').textContent = `${formatDuration(legDurations[2])} drive`;
    document.getElementById('roundTripTime').textContent = `${formatDuration(totalDuration)} total driving`;
    if (map) {
      if (routeLayer) map.removeLayer(routeLayer);
      markers.forEach(marker => map.removeLayer(marker));
      markers = [];
      const latlngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      routeLayer = L.polyline(latlngs, { color: '#347854', weight: 5, opacity: .85 }).addTo(map);
      const labels = ['START / RETURN', 'PICKUP', 'DELIVERY'];
      [points[0], points[1], points[2]].forEach((point, index) => {
        const marker = L.circleMarker([point.lat, point.lon], {
          radius: 7, color: '#fff', weight: 2,
          fillColor: index === 0 ? '#173e2f' : index === 1 ? '#dc9859' : '#5e86bb', fillOpacity: 1
        }).bindTooltip(`${labels[index]} · ${point.label}${point.approx ? ' · area centre' : ''}`).addTo(map);
        markers.push(marker);
      });
      map.fitBounds(routeLayer.getBounds().pad(.12));
    }
    calculate();
    const approximate = points.some(point => point.approx);
    setRouteStatus(`Route calculated${approximate ? ' using postcode area centres' : ''}: ${points[0].label} → ${points[1].label} → ${points[2].label} → ${points[0].label}. Approx. ${total.toFixed(1)} miles by road.`, 'success');
  } catch (error) {
    routeDurationHours = 0;
    routeToDeliveryHours = 0;
    for (const id of ['loadedMiles', 'emptyMiles', 'returnMiles']) inputs[id].value = '0';
    for (const id of ['emptyLeg', 'loadedLeg', 'returnLeg', 'roundTripMiles', 'emptyTime', 'loadedTime', 'returnTime', 'roundTripTime']) document.getElementById(id).textContent = '—';
    calculate();
    setRouteStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.querySelector('span').textContent = 'Calculate route & miles';
  }
}

function marketBids() {
  return inputs.otherBids.value.split(/[\s,;]+/).map(value => Number(value.replace(/[£,]/g, ''))).filter(value => Number.isFinite(value) && value > 0);
}
function renderMarket(bids, benchmarks) {
  const badge = document.getElementById('marketBadge'), lowEl = document.getElementById('marketLow');
  const avgEl = document.getElementById('marketAverage'), pos = document.getElementById('marketPosition'), advice = document.getElementById('marketAdvice');
  if (!benchmarks.length) {
    badge.textContent = 'ADD MARKET DATA'; lowEl.textContent = '—'; avgEl.textContent = '—'; pos.textContent = '—';
    advice.textContent = 'Add comparable prices or visible bids to see where your quote sits.';
    return;
  }
  const overallLow = Math.min(...benchmarks), average = bids.length ? bids.reduce((a, b) => a + b, 0) / bids.length : number('marketPrice');
  const difference = quote.bid - overallLow;
  lowEl.textContent = currency(overallLow); avgEl.textContent = bids.length ? currency(average) : '—';
  pos.textContent = difference <= 0 ? 'At / below low' : `+${currency(difference)} vs low`;
  if (quote.floorBid > overallLow && inputs.useMarket.checked) badge.textContent = 'MARGIN PROTECTED';
  else if (quote.bid <= overallLow) badge.textContent = 'COMPETITIVE';
  else if (quote.bid <= average) badge.textContent = 'IN RANGE';
  else badge.textContent = 'ABOVE MARKET';
  if (quote.floorBid > overallLow && inputs.useMarket.checked) advice.textContent = `Your target-margin floor is ${currency(quote.floorBid)}, above the lowest entered price. The suggested bid protects your margin instead of matching a potentially unprofitable bid.`;
  else if (quote.bid <= overallLow) advice.textContent = 'Your suggested bid is at or below the lowest price entered. Compare like-for-like jobs before using it.';
  else advice.textContent = 'Your suggested bid is above the lowest entered price. Check route, vehicle, timing and service differences before deciding.';
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
  const time = (number('waitHours') + routeDurationHours) * hourlyRate;
  const timeToDelivery = (number('waitHours') + routeToDeliveryHours) * hourlyRate;
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
  const benchmarks = [...bids, ...(market ? [market] : [])], low = bids.length ? Math.min(...bids) : null;
  const averageBid = bids.length ? bids.reduce((a, b) => a + b, 0) / bids.length : null;
  let marketTarget = null;
  if (inputs.useMarket.checked) {
    if (low !== null) marketTarget = Math.max(0, low - 1);
    else if (market) marketTarget = market * .97;
  }
  const rawBid = marketTarget === null ? floorBid : Math.max(floorBid, marketTarget);
  const rawBidToDelivery = marketTarget === null ? floorBidToDelivery : Math.max(floorBidToDelivery, marketTarget);
  const step = Number(inputs.roundTo.value) || 1;
  const bid = step === .01 ? Math.ceil(rawBid * 100) / 100 : Math.ceil(rawBid / step) * step;
  const bidToDelivery = step === .01 ? Math.ceil(rawBidToDelivery * 100) / 100 : Math.ceil(rawBidToDelivery / step) * step;
  const profit = bid - costs, neededJobs = Math.max(0, Math.ceil(dailyTarget / averagePayout));
  const hourlyGoal = dailyTarget / Math.max(1, number('hoursPerDay'));
  quote = { loaded, empty, back, miles, mpg, fuel, vehicle, time, other, insurancePerOrder, costs, margin, bid, bidToDelivery, profit, ref: inputs.jobRef.value.trim(), floorBid };
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
  document.getElementById('targetSummary').textContent = `At ${currency(averagePayout)} average payout, aim for ${neededJobs} ${neededJobs === 1 ? 'job' : 'jobs'} each workday. Insurance adds ${currency(insurancePerOrder)} per job, assuming ${jobsPerDay} jobs/day over ${workingDays} days.`;
  renderMarket(bids, benchmarks);
  localStorage.setItem('routerate-settings', JSON.stringify(Object.fromEntries(fields.map(id => [id, id === 'useMarket' ? inputs[id].checked : inputs[id].value]))));
}
let toastTimer;
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2200); }
for (const id of fields) { inputs[id].addEventListener('input', calculate); inputs[id].addEventListener('change', calculate); }
document.getElementById('routeButton').addEventListener('click', calculateRoute);
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
initMap();
calculate();
