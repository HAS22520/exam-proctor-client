const fs = require('node:fs');
const path = require('node:path');
function runtime(app) {
  if (globalThis.__hydroProctorRuntime) return globalThis.__hydroProctorRuntime;
  // Development entry and old installations have no update bootstrap identity.
  let identity;
  try { identity = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/build.json'), 'utf8')); }
  catch { identity = { version: app.getVersion(), buildVersion: '' }; }
  return { identity, markReady: () => {}, source: 'installed', failure: null };
}
module.exports = { runtime };
