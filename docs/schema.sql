-- Production target schema (PostgreSQL 16+).
-- The zero-install prototype stores the equivalent shape in data/store.json.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- PostgreSQL text/citext/jsonb store full Unicode, including emoji, when the
-- database encoding is UTF8. Fail early instead of silently accepting an
-- incompatible production database. Application input is normalized to NFC.
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Haru requires a UTF8 PostgreSQL database';
  END IF;
END $$;

CREATE TYPE task_priority AS ENUM ('none', 'low', 'medium', 'high');
CREATE TYPE sync_direction AS ENUM ('off', 'pull_only', 'push_only', 'both');
CREATE TYPE collaboration_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain citext UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  username citext NOT NULL,
  password_hash text NOT NULL, -- Argon2id or scrypt encoded hash, never plaintext
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'guest')),
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, username)
);

CREATE TABLE task_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color char(7) NOT NULL DEFAULT '#a6c4d9',
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX one_default_list_per_user ON task_lists(user_id) WHERE is_default;

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  list_id uuid NOT NULL REFERENCES task_lists(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  notes text NOT NULL DEFAULT '',
  due_at timestamptz,
  due_is_all_day boolean NOT NULL DEFAULT true,
  priority task_priority NOT NULL DEFAULT 'none',
  status text NOT NULL DEFAULT 'NEEDS-ACTION' CHECK (status IN ('NEEDS-ACTION','IN-PROCESS','COMPLETED','CANCELLED')),
  percent_complete smallint NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  completed_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  recurrence jsonb NOT NULL DEFAULT '{"type":"none"}'::jsonb CHECK (recurrence->>'type' IN ('none','hourly','daily','weekly','monthly','yearly')),
  tags text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','cli','caldav','mcp','ai')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_version bigint NOT NULL DEFAULT 1
);
CREATE INDEX tasks_by_owner_list ON tasks(user_id, list_id, status, due_at);
CREATE INDEX tasks_by_tags ON tasks USING gin(tags);
COMMENT ON COLUMN tasks.title IS 'NFC-normalized UTF-8 text; emoji is supported';
COMMENT ON COLUMN tasks.notes IS 'NFC-normalized UTF-8 text; emoji and AI output are supported';
COMMENT ON COLUMN tasks.metadata IS 'Namespaced metadata for AI/MCP integrations; never used as the canonical task body';
COMMENT ON COLUMN tasks.recurrence IS 'Haru recurrence: none, hourly, daily, weekly+weekday, monthly+day, or yearly+month/day';
COMMENT ON COLUMN tasks.tags IS 'NFC-normalized UTF-8 tags; synchronized with CalDAV CATEGORIES';

CREATE TABLE list_collaborations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invitee_address text NOT NULL,
  status collaboration_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, invitee_address),
  CHECK (owner_user_id <> invitee_user_id)
);
CREATE INDEX collaborations_for_invitee ON list_collaborations(invitee_user_id, status, updated_at DESC);

-- List approval grants collaboration context only. A collaborator can read a
-- task only when that task has an explicit @mention share row (or they created it).
CREATE TABLE task_shares (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  collaborator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, collaborator_user_id)
);
CREATE INDEX task_shares_for_user ON task_shares(collaborator_user_id, created_at DESC);

CREATE TABLE notification_states (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id text NOT NULL,
  read_at timestamptz,
  removed_at timestamptz,
  PRIMARY KEY (user_id, notification_id)
);
CREATE INDEX active_notification_states ON notification_states(user_id, removed_at, read_at);

-- CalDAV collection and object metadata follows the VTODO model consumed by
-- Super Productivity: UID, SUMMARY, DESCRIPTION, DTSTART, DUE, CATEGORIES,
-- STATUS / COMPLETED / PERCENT-COMPLETE, SEQUENCE, URL and ETag.
CREATE TABLE caldav_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  remote_username text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  sync_direction sync_direction NOT NULL DEFAULT 'both',
  last_sync_at timestamptz,
  sync_token text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caldav_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
  list_id uuid REFERENCES task_lists(id) ON DELETE SET NULL,
  href text NOT NULL,
  display_name text NOT NULL,
  ctag text,
  sync_token text,
  UNIQUE(account_id, href)
);

CREATE TABLE caldav_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES caldav_collections(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  href text NOT NULL,
  ical_uid text NOT NULL,
  etag text,
  sequence integer NOT NULL DEFAULT 0,
  raw_ical text,
  remote_modified_at timestamptz,
  local_modified_at timestamptz NOT NULL DEFAULT now(),
  tombstoned_at timestamptz,
  UNIQUE(collection_id, href),
  UNIQUE(collection_id, ical_uid)
);

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_list_id uuid REFERENCES task_lists(id) ON DELETE SET NULL,
  default_due text NOT NULL DEFAULT 'none' CHECK (default_due IN ('none','today','tomorrow')),
  default_priority task_priority NOT NULL DEFAULT 'none',
  mcp_enabled boolean NOT NULL DEFAULT false,
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  list_marker char(1) NOT NULL DEFAULT '*',
  priority_marker char(1) NOT NULL DEFAULT '!',
  tag_marker char(1) NOT NULL DEFAULT '#',
  sort_by text NOT NULL DEFAULT 'createdAt' CHECK (sort_by IN ('manual','createdAt','due','priority','remaining')),
  sort_direction text NOT NULL DEFAULT 'desc' CHECK (sort_direction IN ('asc','desc')),
  auto_delete_completed text NOT NULL DEFAULT 'none' CHECK (auto_delete_completed IN ('none','daily','weekly','monthly','yearly')),
  CHECK (list_marker IN ('~','!','#','$','%','^','&','*')),
  CHECK (priority_marker IN ('~','!','#','$','%','^','&','*')),
  CHECK (tag_marker IN ('~','!','#','$','%','^','&','*')),
  CHECK (list_marker <> priority_marker AND list_marker <> tag_marker AND priority_marker <> tag_marker),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_version bigint NOT NULL DEFAULT 1
);

CREATE TABLE task_manual_order (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (user_id, task_id),
  UNIQUE (user_id, position)
);

CREATE TABLE user_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_by_user_expiry ON user_sessions(user_id, expires_at);
COMMENT ON COLUMN user_sessions.token_hash IS 'SHA-256 hash only; raw browser session tokens are never persisted';

CREATE TABLE shortcut_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  scope text NOT NULL CHECK (scope IN ('read','write')),
  token_hash char(64) UNIQUE NOT NULL,
  token_hint text NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shortcut_tokens_by_user ON shortcut_tokens(user_id, created_at DESC);
COMMENT ON COLUMN shortcut_tokens.token_hash IS 'SHA-256 hash only; the raw haru_sc_ token is shown once and never persisted';
COMMENT ON COLUMN shortcut_tokens.scope IS 'read permits a complete user snapshot; write permits task creation only';

-- Browser offline-first synchronization. A mutation id is accepted once, and
-- tombstones are processed before snapshots are returned to clients.
CREATE TABLE client_sync_mutations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id text NOT NULL,
  mutation_type text NOT NULL,
  result jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);

CREATE TABLE sync_tombstones (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('task','list')),
  entity_id text NOT NULL,
  sync_version bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- Durable outbox: Haru commits local changes first, then the CalDAV adapter
-- delivers them. Failed operations remain queued and prevent stale remote data
-- from being pulled back over a pending deletion.
CREATE TABLE caldav_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('delete-task','delete-list','create-list')),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  list_id uuid REFERENCES task_lists(id) ON DELETE SET NULL,
  remote_href text,
  remote_etag text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['tasks:read','tasks:write'],
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
