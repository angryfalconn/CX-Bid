(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('accountDialog');
  const status = $('accountStatus');
  const cfg = JSON.parse(localStorage.getItem('routerate-supabase-config') || '{}');
  $('supabaseUrl').value = cfg.url || '';
  $('supabaseAnonKey').value = cfg.key || '';
  let client = null, currentUser = null, deviceId = null;
  let watchId = null, channel = null, devices = [], trackingMap = null, trackingMarker = null;
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  const supabaseFactory = () => window.supabase?.createClient;
  const setConfig = () => {
    const url = $('supabaseUrl').value.trim().replace(/\/$/, ''), key = $('supabaseAnonKey').value.trim();
    if (!/^https:\/\/[\w-]+\.supabase\.co$/.test(url) || !key) throw new Error('Enter a valid Supabase project URL and publishable anon key.');
    localStorage.setItem('routerate-supabase-config', JSON.stringify({ url, key }));
    if (!supabaseFactory()) throw new Error('Supabase client did not load. Check your connection and reload.');
    client = supabaseFactory()(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    client.auth.onAuthStateChange((_event, session) => { currentUser = session?.user || null; if (currentUser) { const keyName = `routerate-device-id-${currentUser.id}`; deviceId = localStorage.getItem(keyName) || crypto.randomUUID(); localStorage.setItem(keyName, deviceId); } else { stopLocalWatch(); deviceId = null; devices = []; } renderAuth(); if (currentUser) setTimeout(() => { refreshDevices(); refreshJobs(); }, 0); });
    say('Connected. Sign in or create your account.');
  };
  function renderAuth() {
    $('authControls').hidden = !client || !!currentUser;
    $('signedInPanel').hidden = !currentUser;
    $('accountButton').textContent = currentUser ? 'Account · tracking' : 'Account & tracking';
    if (currentUser) { $('signedInEmail').textContent = currentUser.email || 'Signed in'; say(`Signed in as ${currentUser.email || 'your account'}. Select a device or share this phone’s GPS.`); }
    else if (client) say('Sign in or create an account to sync devices and saved jobs.');
  }
  renderAuth();
  $('accountButton').addEventListener('click', () => { if (!dialog.open) dialog.showModal(); });
  $('closeAccountDialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  $('saveSupabaseConfig').addEventListener('click', () => { try { setConfig(); } catch (error) { say(error.message, true); } });
  if (cfg.url && cfg.key && supabaseFactory()) { try { setConfig(); } catch (error) { say(error.message, true); } }
  async function auth(action) {
    if (!client) { say('Connect your Supabase project first. Follow the included setup SQL instructions.', true); return; }
    const email = $('accountEmail').value.trim(), password = $('accountPassword').value;
    if (!email || password.length < 8) { say('Enter your email and a password with at least 8 characters.', true); return; }
    say(action === 'signup' ? 'Creating account…' : 'Signing in…');
    const result = action === 'signup' ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
    if (result.error) say(result.error.message, true);
    else if (action === 'signup' && !result.data.session) say('Check your email to confirm the account, then sign in.');
    else say('Signed in successfully.');
  }
  $('signInButton').addEventListener('click', () => auth('signin'));
  $('signUpButton').addEventListener('click', () => auth('signup'));
  $('signOutButton').addEventListener('click', async () => { stopLocalWatch(); if (deviceId) await client.from('routerate_devices').update({ tracking: false, updated_at: new Date().toISOString() }).eq('id', deviceId); await client.auth.signOut(); currentUser = null; renderAuth(); });
  function initTrackingMap() {
    if (!window.L || trackingMap) return;
    trackingMap = L.map('trackingMap').setView([54.5, -3.2], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(trackingMap);
  }
  function updateDeviceView(device) {
    const box = $('trackedDeviceDetails');
    if (!device) { box.textContent = devices.length ? 'Choose a device to view its location.' : 'Sign in on each device, then start GPS sharing on the device you want to track.'; return; }
    if (device.lat == null || device.lng == null) { box.textContent = `${device.label || 'Device'} · ${device.tracking ? 'Waiting for GPS location…' : 'Location sharing is off'}`; return; }
    const point = [Number(device.lat), Number(device.lng)];
    const time = device.updated_at ? new Date(device.updated_at).toLocaleString('en-GB') : 'just now';
    const live = device.tracking && device.updated_at && Date.now() - new Date(device.updated_at).getTime() < 90000;
    box.textContent = `${device.label || 'Device'} · ${live ? 'Live location' : 'Last known location'} · Updated ${time}`;
    initTrackingMap(); if (!trackingMap) return;
    if (trackingMarker) trackingMarker.setLatLng(point); else trackingMarker = L.marker(point).addTo(trackingMap);
    trackingMarker.bindPopup(`${device.label || 'Device'}<br>${live ? 'Live location' : 'Last known location'}`).openPopup();
    trackingMap.setView(point, 15); setTimeout(() => trackingMap.invalidateSize(), 50);
  }
  function selectedDevice() { return devices.find(device => device.id === $('trackedDeviceSelect').value); }
  function renderDevices() {
    const select = $('trackedDeviceSelect'), previous = select.value;
    select.replaceChildren();
    if (!devices.length) { const option = new Option('No devices yet', ''); select.add(option); updateDeviceView(null); return; }
    devices.forEach(device => select.add(new Option(`${device.label || 'Device'}${device.tracking ? ' · sharing' : ''}${device.id === deviceId ? ' · this device' : ''}`, device.id)));
    select.value = devices.some(device => device.id === previous) ? previous : (devices.find(device => device.tracking)?.id || devices[0].id);
    updateDeviceView(selectedDevice());
    $('stopTrackingButton').hidden = watchId === null;
    $('startTrackingButton').hidden = watchId !== null;
  }
  $('trackedDeviceSelect').addEventListener('change', () => updateDeviceView(selectedDevice()));
  async function refreshDevices() {
    if (!client || !currentUser) return;
    const { data, error } = await client.from('routerate_devices').select('*').order('updated_at', { ascending: false });
    if (error) { say(`${error.message} Check that supabase-setup.sql has been run.`, true); return; }
    devices = data || []; renderDevices();
    if (channel) await client.removeChannel(channel);
    channel = client.channel(`routerate-devices-${currentUser.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'routerate_devices', filter: `user_id=eq.${currentUser.id}` }, payload => {
      const row = payload.new?.id ? payload.new : payload.old;
      if (payload.eventType === 'DELETE') devices = devices.filter(item => item.id !== row.id);
      else { const index = devices.findIndex(item => item.id === row.id); if (index < 0) devices.push(row); else devices[index] = row; }
      renderDevices();
    }).subscribe();
  }
  function stopLocalWatch() { if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId = null; }
  $('startTrackingButton').addEventListener('click', async () => {
    if (!currentUser) return;
    if (!navigator.geolocation) { say('This browser does not provide GPS location.', true); return; }
    const label = $('deviceName').value.trim() || `${navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android phone' : 'Browser'} · ${deviceId.slice(0, 4)}`;
    say('Waiting for this device’s location permission…');
    watchId = navigator.geolocation.watchPosition(async position => {
      const { latitude, longitude, accuracy } = position.coords;
      const { data, error } = await client.from('routerate_devices').upsert({ id: deviceId, user_id: currentUser.id, label, lat: latitude, lng: longitude, accuracy_m: Math.round(accuracy), tracking: true, updated_at: new Date().toISOString() }).select().single();
      if (error) say(`Could not share location: ${error.message}`, true);
      else { say(`This device is sharing GPS location (±${Math.round(accuracy)} m). You can select it on any signed-in device.`); const index = devices.findIndex(item => item.id === data.id); if (index < 0) devices.push(data); else devices[index] = data; renderDevices(); }
    }, error => { stopLocalWatch(); say(`Location unavailable: ${error.message}. Allow location access and try again.`, true); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  });
  $('stopTrackingButton').addEventListener('click', async () => {
    stopLocalWatch();
    const { error } = await client.from('routerate_devices').update({ tracking: false, updated_at: new Date().toISOString() }).eq('id', deviceId);
    if (error) say(error.message, true); else { say('Location sharing stopped on this device.'); await refreshDevices(); }
  });
  $('saveJobToAccount').addEventListener('click', async () => {
    if (!client || !currentUser) { dialog.showModal(); say('Sign in first to save collection and delivery points to your account.'); return; }
    const pickup = $('pickupPostcode').value.trim(), delivery = $('deliveryPostcode').value.trim();
    if (!pickup || !delivery) { say('Enter both collection and delivery postcodes first.', true); dialog.showModal(); return; }
    const stops = [...document.querySelectorAll('#extraStops input')].map(input => input.value.trim()).filter(Boolean);
    const { error } = await client.from('routerate_jobs').insert({ user_id: currentUser.id, job_ref: $('jobRef').value.trim() || null, home_postcode: $('startPostcode').value.trim(), pickup_postcode: pickup, delivery_postcode: delivery, stops });
    if (error) say(`Could not save job: ${error.message}`, true); else { say('Collection and delivery points saved to your account.'); await refreshJobs(); }
  });
  async function refreshJobs() {
    if (!client || !currentUser) return;
    const { data, error } = await client.from('routerate_jobs').select('id,job_ref,home_postcode,pickup_postcode,delivery_postcode,stops,created_at').order('created_at', { ascending: false }).limit(20);
    if (error) { $('savedJobsList').textContent = error.message; return; }
    const list = $('savedJobsList'); list.replaceChildren();
    if (!data?.length) { list.textContent = 'No jobs saved to your account yet.'; return; }
    data.forEach(job => { const item = document.createElement('article'); item.className = 'saved-job'; const title = document.createElement('strong'); title.textContent = job.job_ref || 'Delivery job'; const route = document.createElement('p'); route.textContent = `${job.home_postcode || 'No home'} → ${job.pickup_postcode} → ${(job.stops || []).join(' → ')}${job.stops?.length ? ' → ' : ''}${job.delivery_postcode}`; const date = document.createElement('small'); date.textContent = new Date(job.created_at).toLocaleDateString('en-GB'); item.append(title, route, date); list.append(item); });
  }
})();
