// services/equipmentIntegrationClient.js
//
// Server-to-server client for the Equipment Flow (ASIK) backend. Team Flow
// never opens the equipment database: it asks the equipment API, which owns
// its own rules (cancelled rows, deployments, machine states).
//
//   EQUIPMENT_API_URL           e.g. https://equipment-asik.onrender.com/api
//   EQUIPMENT_INTEGRATION_TOKEN same value as INTEGRATION_TOKEN on the equipment server (32+ chars)
//
// Every call has a timeout. A failure never breaks the report: the caller gets
// { ok: false, error } and prints the plant section empty with a warning.

const TIMEOUT_MS = Number(process.env.EQUIPMENT_API_TIMEOUT_MS) || 15000;

function config() {
  const base = String(process.env.EQUIPMENT_API_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.EQUIPMENT_INTEGRATION_TOKEN || '').trim();
  return { base, token, configured: Boolean(base && token.length >= 32) };
}

async function call(pathAndQuery) {
  const { base, token, configured } = config();
  if (!configured) {
    return { ok: false, error: 'The equipment system is not connected (EQUIPMENT_API_URL / EQUIPMENT_INTEGRATION_TOKEN).' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      const msg = body && body.message ? body.message : `HTTP ${res.status}`;
      return { ok: false, error: `Equipment system: ${msg}` };
    }
    return { ok: true, data: body ? body.data : null };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'no answer (timeout)' : 'not reachable';
    return { ok: false, error: `Equipment system: ${msg}.` };
  } finally {
    clearTimeout(timer);
  }
}

const listSites = () => call('/integration/sites');
const listTypes = () => call('/integration/equipment-types');
const dailyPlant = (date, siteIds) => call(
  `/integration/daily-plant?date=${encodeURIComponent(date)}&site_ids=${siteIds.map(Number).join(',')}`);

const listVendors = () => call('/integration/vendors');
/** Machines on site per day, type and vendor (Working / Standby / Breakdown) over a range. */
const plantDays = (from, to, siteIds) => call(
  `/integration/plant-days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&site_ids=${siteIds.map(Number).join(',')}`);

module.exports = { config, listSites, listTypes, dailyPlant, listVendors, plantDays };
