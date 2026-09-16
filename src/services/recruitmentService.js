const { getPool, query } = require("../db/pool");
const { getRecruitmentSpecOptions, normalizeRecruitmentRole } = require("./wowSpecs");

const DEMAND_TONES = {
  High: "high",
  Medium: "medium",
  Low: "low",
};

const DEFAULT_DETAILS = "No additional details available";
const MAX_DETAILS_LENGTH = 500;
const MAX_ROLE_LENGTH = 120;

function mapRecruitmentClass(row) {
  return {
    className: row.class_name,
    role: normalizeRecruitmentRole(row.class_name, row.role) || row.role,
    demand: row.demand,
    tone: row.tone,
    details: row.details || DEFAULT_DETAILS,
  };
}

async function listRecruitment() {
  const result = await query(
    `
      SELECT class_name, role, demand, tone, details, sort_order
      FROM recruitment_classes
      ORDER BY sort_order, class_name
    `,
  );

  return result.rows.map(mapRecruitmentClass);
}

function cleanDetails(value) {
  const details = String(value || "").trim().slice(0, MAX_DETAILS_LENGTH);
  return details || DEFAULT_DETAILS;
}

async function updateRecruitmentStatuses(statuses, updatedBy) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    const error = new Error("No recruitment updates were provided.");
    error.statusCode = 400;
    throw error;
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    for (const item of statuses) {
      const className = typeof item?.className === "string" ? item.className.trim() : "";
      const demand = typeof item?.demand === "string" ? item.demand.trim() : "";
      const tone = DEMAND_TONES[demand];
      const role = normalizeRecruitmentRole(className, item?.role).slice(0, MAX_ROLE_LENGTH);
      const details = cleanDetails(item?.details);

      if (!className || !tone || !role || !getRecruitmentSpecOptions(className).includes(role)) {
        const error = new Error("Each class needs a High, Medium, or Low demand and a valid spec option.");
        error.statusCode = 400;
        throw error;
      }

      const result = await client.query(
        `
          UPDATE recruitment_classes
          SET demand = $2, tone = $3, role = $4, details = $5, updated_by = $6
          WHERE class_name = $1
          RETURNING class_name
        `,
        [className, demand, tone, role, details, updatedBy || null],
      );

      if (!result.rowCount) {
        const error = new Error(`${className} is not a recruitment class.`);
        error.statusCode = 404;
        throw error;
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return listRecruitment();
}

module.exports = { listRecruitment, updateRecruitmentStatuses };
