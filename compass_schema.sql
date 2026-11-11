-- =====================================================================
-- Compass: AI personal assistant schema (PostgreSQL 14+)
-- Works as-is on Supabase, Neon, or plain Postgres. Prisma/Django can
-- introspect it (prisma db pull / inspectdb).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- for overlap protection on schedule blocks
-- CREATE EXTENSION IF NOT EXISTS vector;    -- optional: semantic search over industry_knowledge

-- ---------- ENUMS ----------------------------------------------------
CREATE TYPE role_type         AS ENUM ('employee','freelancer','business_owner','student','between_jobs');
CREATE TYPE income_pattern    AS ENUM ('steady','irregular','just_starting');
CREATE TYPE energy_peak       AS ENUM ('early_morning','midday','afternoon','night');
CREATE TYPE planning_style    AS ENUM ('structured','flexible');
CREATE TYPE deadline_behavior AS ENUM ('starts_early','plans_then_starts','last_minute');
CREATE TYPE quadrant          AS ENUM ('do_now','schedule','delegate','eliminate');
CREATE TYPE task_status       AS ENUM ('todo','in_progress','done','dropped');
CREATE TYPE goal_status       AS ENUM ('active','achieved','paused','dropped');
CREATE TYPE goal_horizon      AS ENUM ('3_month','12_month','other');
CREATE TYPE block_kind        AS ENUM ('task','deep_work','admin','leisure','buffer');
CREATE TYPE block_status      AS ENUM ('planned','done','skipped','cancelled');
CREATE TYPE cost_frequency    AS ENUM ('weekly','monthly','quarterly','yearly');
CREATE TYPE insight_kind      AS ENUM ('gap','pitfall');
CREATE TYPE insight_status    AS ENUM ('new','saved','testing','validated','dismissed');
CREATE TYPE evidence_level    AS ENUM ('sourced','general_reasoning');
CREATE TYPE message_role      AS ENUM ('user','assistant','tool');

-- ---------- HELPERS --------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- USERS & PROFILE -----------------------------------------
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE NOT NULL,
  password_hash text,                           -- bcrypt hash; the real password is never stored
  full_name   text,
  timezone    text NOT NULL DEFAULT 'Africa/Lagos',
  currency    char(3) NOT NULL DEFAULT 'NGN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per user: the structured onboarding result injected into the system prompt.
CREATE TABLE profiles (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_type               role_type,
  role_title              text,                 -- "accountant", "fashion designer"
  industry                text,
  years_experience_band   text,                 -- '<1','1-3','3-10','10+'
  org_size                integer,              -- people in company / team (NULL = unknown)
  income_pattern          income_pattern,
  target_monthly_income   numeric(14,2),        -- "what a good month looks like"
  peak_energy             energy_peak,
  planning_style          planning_style,
  deadline_behavior       deadline_behavior,
  style_answers           jsonb NOT NULL DEFAULT '{}',   -- single/multi-task, recharge style, re-plan reaction, etc.
  work_hours              jsonb NOT NULL DEFAULT '{}',   -- {"mon":["09:00","17:00"], ...}
  leisure_min_hours_week  numeric(4,1) NOT NULL DEFAULT 5,
  onboarding_stage        smallint NOT NULL DEFAULT 1,
  onboarding_done_at      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Raw answers, so people can skip now and be asked later, and so you can re-ask
-- when something becomes relevant ("I need your monthly costs to plan cash flow").
CREATE TABLE onboarding_answers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key  text NOT NULL,                 -- 'org_size', 'peak_energy', ...
  answer        jsonb,
  skipped       boolean NOT NULL DEFAULT false,
  answered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_key)
);

-- Things that can't move (job hours, classes, church, school run).
CREATE TABLE fixed_commitments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  days        smallint[] NOT NULL,             -- 0 = Sunday ... 6 = Saturday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);

-- ---------- MONEY / OVERHEADS ---------------------------------------
CREATE TABLE overhead_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL,                   -- rent, salaries, data, transport
  category    text,
  amount      numeric(14,2) NOT NULL CHECK (amount >= 0),
  frequency   cost_frequency NOT NULL DEFAULT 'monthly',
  monthly_equivalent numeric(14,2) GENERATED ALWAYS AS (
    CASE frequency
      WHEN 'weekly'    THEN amount * 52.0 / 12.0
      WHEN 'monthly'   THEN amount
      WHEN 'quarterly' THEN amount / 3.0
      WHEN 'yearly'    THEN amount / 12.0
    END
  ) STORED,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Monthly target vs actual, for the weekly/monthly review and buffer tracking.
CREATE TABLE finance_months (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month          date NOT NULL,                -- first day of month
  income_target  numeric(14,2),
  income_actual  numeric(14,2),
  buffer_balance numeric(14,2),                -- savings cushion at month end
  UNIQUE (user_id, month)
);

-- ---------- GOALS, MILESTONES, TASKS --------------------------------
CREATE TABLE goals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             text NOT NULL,             -- the raw goal: "grow my business"
  horizon           goal_horizon NOT NULL DEFAULT 'other',
  -- SMART breakdown
  specific          text,
  measurable_metric text,                      -- "new paying clients"
  target_value      numeric,
  current_value     numeric DEFAULT 0,
  achievable_note   text,                      -- why it's realistic given hours/energy/money
  relevant_note     text,                      -- why it matters to this user
  due_date          date,
  status            goal_status NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id     uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due_date    date,
  position    integer NOT NULL DEFAULT 0,
  done_at     timestamptz
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id           uuid REFERENCES goals(id) ON DELETE SET NULL,
  milestone_id      uuid REFERENCES milestones(id) ON DELETE SET NULL,
  title             text NOT NULL,
  notes             text,
  is_important      boolean,                   -- NULL = not sorted yet
  is_urgent         boolean,
  -- Eisenhower quadrant is derived, so flipping a flag moves the task automatically.
  quadrant          quadrant GENERATED ALWAYS AS (
    CASE
      WHEN is_important AND is_urgent             THEN 'do_now'::quadrant
      WHEN is_important AND NOT is_urgent         THEN 'schedule'::quadrant
      WHEN NOT is_important AND is_urgent         THEN 'delegate'::quadrant
      WHEN NOT is_important AND NOT is_urgent     THEN 'eliminate'::quadrant
      ELSE NULL
    END
  ) STORED,
  quadrant_reason   text,                      -- the assistant's one-line "why"
  status            task_status NOT NULL DEFAULT 'todo',
  estimated_minutes integer CHECK (estimated_minutes > 0),
  due_at            timestamptz,
  delegated_to      text,
  is_first_action   boolean NOT NULL DEFAULT false,  -- the "do this week, <30 min" step
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

-- ---------- SCHEDULE -------------------------------------------------
CREATE TABLE schedule_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  kind        block_kind NOT NULL,
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      block_status NOT NULL DEFAULT 'planned',
  external_event_id text,                      -- Google/Outlook calendar sync id
  CHECK (ends_at > starts_at),
  -- no double-booking per user (cancelled blocks don't count)
  EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status <> 'cancelled')
);

-- ---------- INSIGHTS (gaps & pitfalls) ------------------------------
CREATE TABLE insights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             insight_kind NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  how_to_validate  text,                       -- cheap test for a gap / avoidance step for a pitfall
  evidence         evidence_level NOT NULL DEFAULT 'general_reasoning',
  sources          jsonb NOT NULL DEFAULT '[]',   -- [{"url":"...","title":"...","retrieved_at":"..."}]
  status           insight_status NOT NULL DEFAULT 'new',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Curated, shared knowledge per industry (feeds the assistant so it isn't guessing).
CREATE TABLE industry_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry    text NOT NULL,
  kind        insight_kind NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  source_url  text,
  reviewed_at date,                            -- when a human last checked it
  -- embedding vector(1536),                   -- uncomment with pgvector for semantic retrieval
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- REVIEWS --------------------------------------------------
CREATE TABLE weekly_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start   date NOT NULL,
  wins         text,
  misses       text,
  adjustments  text,
  next_top3    jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

-- ---------- CHAT -----------------------------------------------------
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             message_role NOT NULL,
  content          text,
  tool_calls       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- INDEXES --------------------------------------------------
CREATE INDEX idx_tasks_user_status    ON tasks (user_id, status);
CREATE INDEX idx_tasks_user_quadrant  ON tasks (user_id, quadrant) WHERE status <> 'done';
CREATE INDEX idx_tasks_due            ON tasks (user_id, due_at) WHERE status <> 'done';
CREATE INDEX idx_goals_user_status    ON goals (user_id, status);
CREATE INDEX idx_blocks_user_time     ON schedule_blocks (user_id, starts_at);
CREATE INDEX idx_insights_user_kind   ON insights (user_id, kind, status);
CREATE INDEX idx_knowledge_industry   ON industry_knowledge (lower(industry), kind);
CREATE INDEX idx_messages_convo       ON messages (conversation_id, created_at);

-- ---------- updated_at TRIGGERS -------------------------------------
CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_goals_updated    BEFORE UPDATE ON goals    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tasks_updated    BEFORE UPDATE ON tasks    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- VIEWS THE ASSISTANT / DASHBOARD CAN USE -----------------
-- Total monthly overheads per user.
CREATE VIEW v_monthly_overheads AS
SELECT user_id, round(sum(monthly_equivalent), 2) AS monthly_total
FROM overhead_items
WHERE active
GROUP BY user_id;

-- Scheduled leisure per week vs the user's protected minimum.
-- (Week boundaries use UTC; adjust with AT TIME ZONE users.timezone if needed.)
CREATE VIEW v_weekly_leisure AS
SELECT
  b.user_id,
  date_trunc('week', b.starts_at)::date AS week_start,
  round(sum(extract(epoch FROM (b.ends_at - b.starts_at)) / 3600.0)::numeric, 1) AS leisure_hours,
  p.leisure_min_hours_week,
  sum(extract(epoch FROM (b.ends_at - b.starts_at)) / 3600.0) >= p.leisure_min_hours_week AS meets_minimum
FROM schedule_blocks b
JOIN profiles p ON p.user_id = b.user_id
WHERE b.kind = 'leisure' AND b.status <> 'cancelled'
GROUP BY b.user_id, date_trunc('week', b.starts_at), p.leisure_min_hours_week;

-- Open work grouped by Eisenhower quadrant.
CREATE VIEW v_matrix AS
SELECT user_id, quadrant, count(*) AS open_tasks
FROM tasks
WHERE status IN ('todo','in_progress')
GROUP BY user_id, quadrant;

-- ---------- ROW-LEVEL SECURITY (Supabase / multi-tenant) ------------
-- Uncomment and adapt if users authenticate through Supabase Auth
-- (then users.id should equal auth.uid()).
--
-- ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tasks_owner ON tasks
--   USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- Repeat for every table that has a user_id column.
