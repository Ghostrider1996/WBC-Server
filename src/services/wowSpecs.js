const CLASS_SPECS = {
  Warrior: ["Arms", "Fury", "Protection"],
  Paladin: ["Holy", "Protection", "Retribution"],
  Hunter: ["Beast Mastery", "Marksmanship", "Survival"],
  Rogue: ["Assassination", "Combat", "Subtlety"],
  Priest: ["Discipline", "Holy", "Shadow"],
  Shaman: ["Elemental", "Enhancement", "Restoration"],
  Mage: ["Arcane", "Fire", "Frost"],
  Warlock: ["Affliction", "Demonology", "Destruction"],
  Druid: ["Balance", "Feral", "Guardian", "Restoration"],
};

function specsForClass(className) {
  return CLASS_SPECS[className] || [];
}

function roleFromSpec(spec) {
  const value = String(spec || "").toLowerCase().replace(/\d+$/, "");

  if (["protection", "guardian"].includes(value)) return "Tank";
  if (["holy", "discipline", "restoration"].includes(value)) return "Healer";
  return "DPS";
}

function resolveSpecForClass(className, specName) {
  const specs = specsForClass(className);
  const wanted = String(specName || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!wanted) return "";
  return specs.find((spec) => spec.toLowerCase().replace(/[^a-z]/g, "") === wanted) || "";
}

module.exports = { CLASS_SPECS, specsForClass, roleFromSpec, resolveSpecForClass };
