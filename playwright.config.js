const fs = require('fs');

// Managed/CI environments ship a preinstalled Chromium that may not match the
// build number the npm package expects — prefer it when present.
const managedChromium = '/opt/pw-browsers/chromium';

module.exports = {
  testDir: './tests',
  // Browser specs are *.spec.js; the server suite (tests/server/*.test.js) runs
  // under `node --test` and must not be picked up here.
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    launchOptions: fs.existsSync(managedChromium) ? { executablePath: managedChromium } : {},
  },
};
