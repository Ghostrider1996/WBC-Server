CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  global_name TEXT,
  discriminator TEXT,
  avatar TEXT,
  discord_access_token TEXT,
  discord_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ,
  token_refresh_label TEXT,
  guild_rank TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  realm TEXT,
  region TEXT,
  class TEXT,
  spec TEXT,
  role TEXT,
  item_level INTEGER,
  is_main BOOLEAN NOT NULL DEFAULT false,
  armory_url TEXT,
  warcraftlogs_url TEXT,
  battlenet_character_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS characters_one_main_per_user
  ON characters (user_id)
  WHERE is_main;

CREATE UNIQUE INDEX IF NOT EXISTS characters_unique_per_user
  ON characters (user_id, lower(name), lower(COALESCE(realm, '')));

CREATE INDEX IF NOT EXISTS characters_user_id_idx
  ON characters (user_id);

CREATE TABLE IF NOT EXISTS raid_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
  raid_event_id TEXT NOT NULL,
  raid_name TEXT,
  raid_tier TEXT,
  scheduled_at TIMESTAMPTZ,
  role TEXT,
  status TEXT NOT NULL CHECK (status IN ('signed', 'confirmed', 'waitlist', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, raid_event_id)
);

CREATE INDEX IF NOT EXISTS raid_signups_user_status_idx
  ON raid_signups (user_id, status);

CREATE INDEX IF NOT EXISTS raid_signups_event_idx
  ON raid_signups (raid_event_id);

CREATE TABLE IF NOT EXISTS news_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT,
  tag TEXT NOT NULL DEFAULT 'Update',
  image_url TEXT,
  body TEXT,
  details TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_posts_published_at_idx
  ON news_posts (published_at DESC);

CREATE TABLE IF NOT EXISTS gallery_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  title TEXT NOT NULL,
  slug TEXT,
  url TEXT NOT NULL,
  details TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gallery_posts_created_at_idx
  ON gallery_posts (created_at DESC);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS characters_set_updated_at ON characters;
CREATE TRIGGER characters_set_updated_at
  BEFORE UPDATE ON characters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS raid_signups_set_updated_at ON raid_signups;
CREATE TRIGGER raid_signups_set_updated_at
  BEFORE UPDATE ON raid_signups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS news_posts_set_updated_at ON news_posts;
CREATE TRIGGER news_posts_set_updated_at
  BEFORE UPDATE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS gallery_posts_set_updated_at ON gallery_posts;
CREATE TRIGGER gallery_posts_set_updated_at
  BEFORE UPDATE ON gallery_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_battletag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_access_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_token_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battlenet_connected_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS warcraftlogs_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE characters ADD COLUMN IF NOT EXISTS level INTEGER;
ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS details TEXT;
ALTER TABLE gallery_posts ADD COLUMN IF NOT EXISTS details TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_battlenet_id_idx
  ON users (battlenet_id)
  WHERE battlenet_id IS NOT NULL;

ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE gallery_posts ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS news_posts_slug_idx
  ON news_posts (slug)
  WHERE slug IS NOT NULL AND btrim(slug) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS gallery_posts_slug_idx
  ON gallery_posts (slug)
  WHERE slug IS NOT NULL AND btrim(slug) <> '';

CREATE TABLE IF NOT EXISTS recruitment_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  demand TEXT NOT NULL CHECK (demand IN ('High', 'Medium', 'Low', 'Closed')),
  tone TEXT NOT NULL CHECK (tone IN ('high', 'medium', 'low', 'closed')),
  details TEXT NOT NULL DEFAULT 'No additional details available',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recruitment_classes_sort_idx
  ON recruitment_classes (sort_order, class_name);

ALTER TABLE recruitment_classes DROP CONSTRAINT IF EXISTS recruitment_classes_demand_check;
ALTER TABLE recruitment_classes DROP CONSTRAINT IF EXISTS recruitment_classes_tone_check;
ALTER TABLE recruitment_classes
  ADD CONSTRAINT recruitment_classes_demand_check
  CHECK (demand IN ('High', 'Medium', 'Low', 'Closed'));
ALTER TABLE recruitment_classes
  ADD CONSTRAINT recruitment_classes_tone_check
  CHECK (tone IN ('high', 'medium', 'low', 'closed'));

DROP TRIGGER IF EXISTS recruitment_classes_set_updated_at ON recruitment_classes;
CREATE TRIGGER recruitment_classes_set_updated_at
  BEFORE UPDATE ON recruitment_classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO recruitment_classes (class_name, role, demand, tone, details, sort_order)
VALUES
  ('Warrior', 'Protection', 'High', 'high', 'No additional details available', 1),
  ('Paladin', 'Protection / Holy', 'High', 'high', 'No additional details available', 2),
  ('Priest', 'Discipline / Holy', 'High', 'high', 'No additional details available', 3),
  ('Druid', 'Restoration / Balance', 'High', 'high', 'No additional details available', 4),
  ('Shaman', 'Restoration / Elemental', 'High', 'high', 'No additional details available', 5),
  ('Mage', 'Any DPS spec', 'High', 'high', 'No additional details available', 6),
  ('Warlock', 'Any DPS spec', 'High', 'high', 'No additional details available', 7),
  ('Rogue', 'Any DPS spec', 'Low', 'low', 'No additional details available', 8),
  ('Hunter', 'Any DPS spec', 'High', 'high', 'No additional details available', 9)
ON CONFLICT (class_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  allow_multiple BOOLEAN NOT NULL DEFAULT false,
  ends_at TIMESTAMPTZ,
  discord_message_id TEXT,
  discord_channel_id TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS polls_discord_message_id_idx
  ON polls (discord_message_id)
  WHERE discord_message_id IS NOT NULL AND btrim(discord_message_id) <> '';

CREATE INDEX IF NOT EXISTS polls_created_at_idx
  ON polls (created_at DESC);

ALTER TABLE polls ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE polls DROP CONSTRAINT IF EXISTS polls_status_check;
ALTER TABLE polls ADD CONSTRAINT polls_status_check CHECK (status IN ('open', 'closed'));
UPDATE polls SET status = 'closed' WHERE ends_at IS NOT NULL AND ends_at <= now() AND status IS DISTINCT FROM 'closed';

CREATE TABLE IF NOT EXISTS poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  discord_answer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poll_options_poll_id_idx
  ON poll_options (poll_id, sort_order);

CREATE TABLE IF NOT EXISTS poll_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  discord_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (option_id, user_id)
);

CREATE INDEX IF NOT EXISTS poll_votes_poll_user_idx
  ON poll_votes (poll_id, user_id);

DROP INDEX IF EXISTS poll_votes_one_per_user_idx;

UPDATE polls SET allow_multiple = true;

DROP TRIGGER IF EXISTS polls_set_updated_at ON polls;
CREATE TRIGGER polls_set_updated_at
  BEFORE UPDATE ON polls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS guild_admins (
  discord_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'admin',
  added_by_discord_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE guild_admins DROP CONSTRAINT IF EXISTS guild_admins_role_check;
ALTER TABLE guild_admins ADD CONSTRAINT guild_admins_role_check CHECK (role IN ('owner', 'admin'));

INSERT INTO guild_admins (discord_id, role)
VALUES ('315040446370021378', 'owner')
ON CONFLICT (discord_id) DO UPDATE SET role = 'owner';

CREATE TABLE IF NOT EXISTS guild_roster_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  roster_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO guild_roster_meta (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS guild_roster_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_name TEXT NOT NULL,
  rank_index INTEGER,
  rank_name TEXT,
  level INTEGER,
  class TEXT,
  public_note TEXT,
  officer_note TEXT,
  online BOOLEAN NOT NULL DEFAULT false,
  last_online_days INTEGER,
  last_online_at BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS guild_roster_members_name_idx
  ON guild_roster_members (lower(character_name));

DROP TRIGGER IF EXISTS guild_roster_members_set_updated_at ON guild_roster_members;
CREATE TRIGGER guild_roster_members_set_updated_at
  BEFORE UPDATE ON guild_roster_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS guild_professions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_name TEXT NOT NULL,
  name TEXT NOT NULL,
  skill_line_id INTEGER NOT NULL,
  current_skill INTEGER,
  max_skill INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS guild_professions_unique
  ON guild_professions (lower(character_name), skill_line_id);

DROP TRIGGER IF EXISTS guild_professions_set_updated_at ON guild_professions;
CREATE TRIGGER guild_professions_set_updated_at
  BEFORE UPDATE ON guild_professions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS guild_profession_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_name TEXT NOT NULL,
  skill_line_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  recipe_name TEXT,
  learned BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS guild_profession_recipes_unique
  ON guild_profession_recipes (lower(character_name), skill_line_id, recipe_id);

DROP TRIGGER IF EXISTS guild_profession_recipes_set_updated_at ON guild_profession_recipes;
CREATE TRIGGER guild_profession_recipes_set_updated_at
  BEFORE UPDATE ON guild_profession_recipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE guild_roster_members ADD COLUMN IF NOT EXISTS last_online_text TEXT;
ALTER TABLE guild_roster_members ADD COLUMN IF NOT EXISTS last_online_hours INTEGER;
ALTER TABLE guild_profession_recipes ADD COLUMN IF NOT EXISTS output_item_id INTEGER;
ALTER TABLE guild_profession_recipes ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE guild_profession_recipes ADD COLUMN IF NOT EXISTS materials JSONB;
