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
