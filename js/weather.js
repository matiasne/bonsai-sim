/* Pixel Bonsai — real weather + location. Open-Meteo (keyless, CORS *), silent IP
   geolocation with fallback, manual city search, optional precise geolocation.
   Everything degrades to neutral "indoor weather" so the sim never blocks. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  function fetchT(url, ms) {
    return new Promise((resolve, reject) => {
      if (typeof fetch !== 'function') return reject(new Error('no fetch'));
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = setTimeout(() => { if (ctl) ctl.abort(); reject(new Error('timeout')); }, ms || 5000);
      fetch(url, ctl ? { signal: ctl.signal } : {}).then(
        r => { clearTimeout(t); resolve(r); },
        e => { clearTimeout(t); reject(e); }
      );
    });
  }

  const WMO = [
    [[0], '☀️', 'Clear sky', 'clear'],
    [[1, 2], '⛅', 'Partly cloudy', 'clear'],
    [[3], '☁️', 'Overcast', 'clouds'],
    [[45, 48], '🌫️', 'Foggy', 'fog'],
    [[51, 53, 55, 56, 57], '🌦️', 'Drizzle', 'rain'],
    [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'Rain', 'rain'],
    [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow', 'snow'],
    [[95, 96, 99], '⛈️', 'Thunderstorm', 'storm'],
  ];
  function describe(code, isDay) {
    for (const [codes, emoji, label, kind] of WMO) {
      if (codes.includes(code)) return { emoji: code === 0 && !isDay ? '🌙' : emoji, label, kind };
    }
    return { emoji: '🌤️', label: 'Fair', kind: 'clear' };
  }

  const Weather = {
    st: {
      ok: false, city: null, lat: null, lon: null,
      temp: 21, rh: 55, wind: 6, code: 1, isDay: 1, precip: 0, fetchedAt: 0,
    },
    _timer: null,
    onUpdate: null,

    hydrate(saved) {
      if (saved && typeof saved === 'object') Object.assign(this.st, saved);
      this.st.ok = !!(this.st.ok && this.st.fetchedAt && Date.now() - this.st.fetchedAt < 3 * 3600e3);
    },
    serialize() {
      const s = this.st;
      return {
        ok: s.ok, city: s.city, lat: s.lat, lon: s.lon, temp: s.temp, rh: s.rh,
        wind: s.wind, code: s.code, isDay: s.isDay, precip: s.precip, fetchedAt: s.fetchedAt,
      };
    },

    async init() {
      if (this.st.lat === null) await this._ipLocate();
      await this.refresh();
      clearInterval(this._timer);
      this._timer = setInterval(() => this.refresh(), 30 * 60 * 1000);
    },

    async _ipLocate() {
      try {
        const r = await fetchT('https://ipwho.is/');
        const j = await r.json();
        if (j && j.success !== false && typeof j.latitude === 'number') {
          this.st.lat = j.latitude; this.st.lon = j.longitude;
          this.st.city = j.city || j.country || 'your area';
          return;
        }
      } catch (e) { /* try fallback */ }
      try {
        const r = await fetchT('https://get.geojs.io/v1/ip/geo.json');
        const j = await r.json();
        if (j && j.latitude) {
          this.st.lat = parseFloat(j.latitude); this.st.lon = parseFloat(j.longitude);
          this.st.city = j.city || j.country || 'your area';
        }
      } catch (e) { /* stay unlocated — user can set a city */ }
    },

    geolocate() {
      return new Promise((resolve) => {
        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return resolve(false);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.st.lat = pos.coords.latitude;
            this.st.lon = pos.coords.longitude;
            this.st.city = 'your location';
            this.refresh().then(() => resolve(true));
          },
          () => resolve(false),
          { timeout: 8000 }
        );
      });
    },

    async searchCity(q) {
      const r = await fetchT('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=' + encodeURIComponent(q));
      const j = await r.json();
      return (j.results || []).map(c => ({
        name: c.name, admin: c.admin1 || '', country: c.country_code || '',
        lat: c.latitude, lon: c.longitude,
      }));
    },

    async setLocation(lat, lon, city) {
      this.st.lat = lat; this.st.lon = lon; this.st.city = city;
      await this.refresh();
    },

    async refresh() {
      if (this.st.lat === null) { this._ping(); return; }
      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + this.st.lat +
          '&longitude=' + this.st.lon +
          '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day&timezone=auto';
        const r = await fetchT(url, 6000);
        const j = await r.json();
        const c = j.current;
        if (c && typeof c.temperature_2m === 'number') {
          Object.assign(this.st, {
            ok: true, fetchedAt: Date.now(),
            temp: c.temperature_2m,
            rh: c.relative_humidity_2m,
            precip: c.precipitation || 0,
            code: c.weather_code,
            wind: c.wind_speed_10m || 0,
            isDay: c.is_day,
          });
        }
      } catch (e) { /* keep last reading / neutral defaults */ }
      this._ping();
    },
    _ping() { if (this.onUpdate) this.onUpdate(this.st); },

    // Environmental factors for the sim, derived from weather + clock.
    env(now) {
      const st = this.st;
      const hour = now.getHours() + now.getMinutes() / 60;
      const clockNight = hour < 6.5 || hour >= 20;
      const d = st.ok ? describe(st.code, st.isDay) : { emoji: clockNight ? '🌙' : '☀️', label: 'Indoor weather', kind: 'none' };
      const night = st.ok ? !st.isDay : clockNight;
      const frost = st.ok && st.temp <= 1;
      const hot = st.ok && st.temp >= 33;

      let growth = night ? 0.4 : 1.0;
      if (st.ok) {
        if (frost) growth *= 0.05;
        else if (st.temp < 8) growth *= 0.45;
        else if (st.temp < 15) growth *= 0.8;
        else if (st.temp > 30) growth *= 0.7;
        if (d.kind === 'clouds' || d.kind === 'fog') growth *= 0.9;
        if (d.kind === 'snow') growth *= 0.1;
        if (d.kind === 'storm') growth *= 0.6;
        if (d.kind === 'clear' && !night) growth *= 1.1;
      }
      const dryMul = st.ok
        ? Math.max(0.4, 1 + (st.temp - 20) * 0.035 + (50 - st.rh) * 0.008) * (night ? 0.6 : 1)
        : (night ? 0.7 : 1);
      const mistMul = st.ok ? Math.max(0.35, 1 + (55 - st.rh) * 0.02) : 1;
      const raining = d.kind === 'rain' || d.kind === 'storm';
      const rainWater = raining ? Math.min(14, 3 + st.precip * 4) : 0;
      const sway = Math.min(1.6, 0.15 + (st.ok ? st.wind : 5) * 0.045 + (d.kind === 'storm' ? 0.5 : 0));

      let note = null;
      if (!st.ok) note = st.lat === null ? 'no weather — open ⚙ to set your city 📍' : null;
      else if (frost) note = '❄️ frost outside — your bonsai is dormant';
      else if (d.kind === 'snow') note = '🌨 snow outside — growth has paused';
      else if (d.kind === 'storm') note = '⛈ a storm rocks the branches!';
      else if (raining) note = '🌧 rain outside is watering your tree';
      else if (hot) note = '🔥 heat wave — the soil dries fast';
      else if (st.wind >= 25) note = '💨 strong wind — hold on, little tree';

      // wired branches set a bit faster in the local growing season (hemisphere-aware)
      const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
      const summerPeak = st.lat !== null && st.lat < 0 ? 355 : 172;
      const wireRate = st.lat === null ? 1 : 1 + 0.1 * Math.cos(((doy - summerPeak) / 365) * Math.PI * 2);

      return {
        emoji: d.emoji, label: d.label, kind: d.kind,
        night, frost, hot, raining, snowing: d.kind === 'snow',
        growth, dryMul, mistMul, rainWater, sway, wireRate,
        wind: st.ok ? st.wind : 5, temp: st.temp, city: st.city, ok: st.ok, note,
      };
    },
  };

  B.Weather = Weather;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
