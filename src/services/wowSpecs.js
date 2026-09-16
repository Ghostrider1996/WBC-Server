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

const ANY_RECRUITMENT_SPEC = "Any spec";
const ANY_ROLE_ALIASES = new Set(["any", "any spec", "any role", "any dps spec"]);

function combinations(items, size) {
  if (size === 0) return [[]];
  if (size > items.length) return [];

  const result = [];
  items.forEach((item, index) => {
    combinations(items.slice(index + 1), size - 1).forEach((rest) => {
      result.push([item, ...rest]);
    });
  });
  return result;
}

function getRecruitmentSpecOptions(className) {
  const specs = specsForClass(className);
  const options = [ANY_RECRUITMENT_SPEC];

  for (let size = 1; size < specs.length; size += 1) {
    combinations(specs, size).forEach((combo) => {
      options.push(combo.join(" / "));
    });
  }

  return options;
}

function normalizeRecruitmentRole(className, role) {
  const specs = specsForClass(className);
  const trimmed = String(role || "").trim();
  if (!trimmed || ANY_ROLE_ALIASES.has(trimmed.toLowerCase())) {
    return ANY_RECRUITMENT_SPEC;
  }

  const selected = trimmed.split(/\s*\/\s*/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const matched = specs.filter((spec) => selected.includes(spec.toLowerCase()));

  if (matched.length === 0) return "";
  if (matched.length === specs.length) return ANY_RECRUITMENT_SPEC;
  return matched.join(" / ");
}

module.exports = {
  CLASS_SPECS,
  specsForClass,
  roleFromSpec,
  resolveSpecForClass,
  ANY_RECRUITMENT_SPEC,
  getRecruitmentSpecOptions,
  normalizeRecruitmentRole,
};
