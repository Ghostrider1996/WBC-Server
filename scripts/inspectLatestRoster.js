require("dotenv").config();
const { query, closePool } = require("../src/db/pool");

(async () => {
  const meta = await query("SELECT * FROM guild_roster_meta");
  const coverage = await query(`
    SELECT
      COUNT(*)::int AS members,
      COUNT(*) FILTER (WHERE level IS NOT NULL)::int AS with_level,
      COUNT(*) FILTER (WHERE rank_index IS NOT NULL)::int AS with_rank_index,
      COUNT(*) FILTER (WHERE last_online_days IS NOT NULL)::int AS with_last_online_days,
      COUNT(*) FILTER (WHERE last_online_text IS NOT NULL AND last_online_text <> '')::int AS with_last_online_text,
      COUNT(*) FILTER (WHERE online)::int AS online,
      MAX(updated_at) AS members_updated_at
    FROM guild_roster_members
  `);
  const professions = await query(`
    SELECT name, skill_line_id, COUNT(*)::int AS characters,
           MAX(updated_at) AS updated_at
    FROM guild_professions
    GROUP BY name, skill_line_id
    ORDER BY name, skill_line_id
  `);
  const recipes = await query(`
    SELECT p.name, p.skill_line_id, COUNT(r.id)::int AS recipes
    FROM guild_professions p
    LEFT JOIN guild_profession_recipes r
      ON lower(p.character_name) = lower(r.character_name)
     AND p.skill_line_id = r.skill_line_id
    GROUP BY p.name, p.skill_line_id
    ORDER BY p.name, p.skill_line_id
  `);
  const samples = await query(`
    SELECT character_name, rank_index, rank_name, level, class, online,
           last_online_days, last_online_text, left(public_note, 60) AS public_note, updated_at
    FROM guild_roster_members
    ORDER BY updated_at DESC NULLS LAST, lower(character_name)
    LIMIT 12
  `);
  const profSamples = await query(`
    SELECT character_name, name, skill_line_id, current_skill, max_skill, updated_at
    FROM guild_professions
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 20
  `);

  console.log(JSON.stringify({
    meta: meta.rows,
    coverage: coverage.rows[0],
    professions: professions.rows,
    recipes: recipes.rows,
    samples: samples.rows,
    profSamples: profSamples.rows,
  }, null, 2));

  await closePool();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
