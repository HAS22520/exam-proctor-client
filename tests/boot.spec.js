const assert = require('node:assert/strict');
const { test } = require('node:test');
const { prepareBootIdentity, bootIdentity } = require('../app/main/device-store');
const { digest } = require('../app/main/proctor-crypto');

test('Windows boot identity is prepared asynchronously once and cached for journal recovery', async () => {
  let callback, calls = 0;
  const pending = prepareBootIdentity({ platform: 'win32', exec: (command, args, options, done) => {
    assert.equal(command, 'powershell.exe'); assert.equal(options.windowsHide, true);
    calls++; callback = done;
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bootIdentity(), null);
  callback(null, '2026-10-10T00:00:00.000Z\r\n');
  const expected = digest('win32:2026-10-10T00:00:00.000Z');
  assert.equal(await pending, expected); assert.equal(bootIdentity(), expected);
  assert.equal(await prepareBootIdentity(), expected); assert.equal(calls, 1);
});
