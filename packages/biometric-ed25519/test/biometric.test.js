console.log(process.version);
const { createKey } = require('../lib');

test('create key', () => {
    console.log("biometric.test.js: create key");
    createKey("test");
    expect(true).toBeTruthy();
});
