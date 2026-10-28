const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanMainCharacterName } = require("../src/services/applicantService");

test("a blank main is kept empty", () => {
  assert.equal(cleanMainCharacterName("   "), "");
});

test("a typed main character name is kept", () => {
  assert.equal(cleanMainCharacterName("  Madrebel Bulwark  "), "Madrebel Bulwark");
});

test("a name with digits is rejected", () => {
  assert.throws(() => cleanMainCharacterName("Madrebel1"), { statusCode: 400 });
});
