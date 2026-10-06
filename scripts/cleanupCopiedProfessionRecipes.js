const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { getPool, closePool } = require("../src/db/pool");

const DELETE_COPIED_RECIPES = `
DELETE FROM guild_profession_recipes r
WHERE EXISTS (
  SELECT 1
  FROM guild_professions p
  JOIN guild_professions other
    ON lower(other.character_name) = lower(p.character_name)
   AND lower(other.name) = lower(p.name)
   AND other.skill_line_id <> p.skill_line_id
  WHERE lower(p.character_name) = lower(r.character_name)
    AND p.skill_line_id = r.skill_line_id
    AND NOT EXISTS (
      SELECT 1
      FROM guild_profession_recipes keep
      WHERE lower(keep.character_name) = lower(r.character_name)
        AND keep.skill_line_id = other.skill_line_id
        AND keep.recipe_id = r.recipe_id
    )
)
`;

async function main() {
  const client = await getPool().connect();
  try {
    const deleted = await client.query(DELETE_COPIED_RECIPES);
    console.log("deleted", deleted.rowCount);

    const leftover = await client.query(`
      SELECT p.name, p.skill_line_id, r.recipe_name
      FROM guild_professions p
      JOIN guild_profession_recipes r
        ON lower(r.character_name) = lower(p.character_name)
       AND r.skill_line_id = p.skill_line_id
      ORDER BY p.skill_line_id, r.recipe_name
    `);

    for (const row of leftover.rows) {
      console.log(`${row.name} ${row.skill_line_id} ${row.recipe_name}`);
    }
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
