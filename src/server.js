import "dotenv/config";
import express from "express";
import cors from "cors";
import { query } from "./db.js";
import { buildSystemPrompt } from "./prompt.js";
import { handleChat } from "./chat.js";
import { requireAuth, requireSelf, register, login, me, authLimiter, chatLimiter } from "./auth.js";

const app = express();
// Which websites may call this API from a browser. Set FRONTEND_URL in .env (or on Render) to your
// Vercel address, e.g. https://compass-xyz.vercel.app (several allowed, separated by commas).
// If it isn't set (local development), any origin is allowed.
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json());

// Express 4 doesn't catch errors from async routes by itself, so we wrap each one.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Render (and most hosts) sit behind a proxy; this lets rate limits see each visitor's real address.
app.set("trust proxy", 1);

// --- Login -----------------------------------------------------------------
app.post("/auth/register", authLimiter, wrap(register));
app.post("/auth/login", authLimiter, wrap(login));
app.get("/auth/me", requireAuth, wrap(me));

// Everything under /users/:id/... now needs a valid token AND must be the owner's own id.
app.use("/users/:id", requireAuth, requireSelf);

// Only these columns can be written to the profiles table through the API.
const PROFILE_FIELDS = [
  "role_type",
  "role_title",
  "industry",
  "years_experience_band",
  "org_size",
  "income_pattern",
  "target_monthly_income",
  "peak_energy",
  "planning_style",
  "deadline_behavior",
  "style_answers",
  "work_hours",
  "leisure_min_hours_week",
];

// --- Health check ---------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// --- 2. Save or update the onboarding profile -----------------------------
// Body: any of the PROFILE_FIELDS, e.g. { "role_type": "freelancer", "industry": "design" }
// Send only what you have so far; users can skip questions and come back later.
app.put(
  "/users/:id/profile",
  wrap(async (req, res) => {
    const keys = PROFILE_FIELDS.filter((k) => k in req.body);
    if (!keys.length) return res.status(400).json({ error: "No valid profile fields in request" });

    // Column names come from our own whitelist above, never from the request,
    // and values are passed as $2, $3... placeholders, so this is safe from SQL injection.
    const cols = keys.join(", ");
    const placeholders = keys.map((_, i) => `$${i + 2}`).join(", ");
    const updates = keys.map((k) => `${k} = excluded.${k}`).join(", ");

    const { rows } = await query(
      `insert into profiles (user_id, ${cols}) values ($1, ${placeholders})
       on conflict (user_id) do update set ${updates}
       returning *`,
      [req.params.id, ...keys.map((k) => req.body[k])]
    );
    res.json(rows[0]);
  })
);

// --- 3. Save one onboarding answer (or record that it was skipped) --------
// Body: { "question_key": "pain_points", "answer": "too many meetings" }
//   or: { "question_key": "overheads", "skipped": true }
app.post(
  "/users/:id/answers",
  wrap(async (req, res) => {
    const { question_key, answer, skipped } = req.body;
    if (!question_key) return res.status(400).json({ error: "question_key is required" });

    const { rows } = await query(
      `insert into onboarding_answers (user_id, question_key, answer, skipped)
       values ($1, $2, $3, $4)
       on conflict (user_id, question_key)
       do update set answer = excluded.answer, skipped = excluded.skipped, answered_at = now()
       returning *`,
      [req.params.id, question_key, JSON.stringify(answer ?? null), Boolean(skipped)]
    );
    res.status(201).json(rows[0]);
  })
);

// --- 4. Add a fixed commitment (work hours, classes, church, school run) --
// Body: { "title": "Day job", "days": [1,2,3,4,5], "start_time": "09:00", "end_time": "17:00" }
app.post(
  "/users/:id/commitments",
  wrap(async (req, res) => {
    const { title, days, start_time, end_time } = req.body;
    if (!title || !Array.isArray(days) || !start_time || !end_time) {
      return res.status(400).json({ error: "title, days (array), start_time and end_time are required" });
    }
    const { rows } = await query(
      `insert into fixed_commitments (user_id, title, days, start_time, end_time)
       values ($1, $2, $3, $4, $5) returning *`,
      [req.params.id, title, days, start_time, end_time]
    );
    res.status(201).json(rows[0]);
  })
);

// --- 5. Build the system prompt for this user -----------------------------
// This is what you'll send to the AI as the "system" message.
app.get(
  "/users/:id/system-prompt",
  wrap(async (req, res) => {
    const prompt = await buildSystemPrompt(req.params.id);
    if (!prompt) return res.status(404).json({ error: "User not found" });
    res.type("text/plain").send(prompt);
  })
);

// --- 5b. Routes used by the React frontend --------------------------------

// Body: { "title": "Land 3 new clients", "horizon": "3_month" }  (horizon: 3_month | 12_month | other)
app.post(
  "/users/:id/goals",
  wrap(async (req, res) => {
    const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 200) : "";
    if (!title) return res.status(400).json({ error: "title is required" });
    const { rows } = await query(
      `insert into goals (user_id, title, horizon) values ($1, $2, $3::goal_horizon) returning id, title, horizon`,
      [req.params.id, title, req.body.horizon ?? "other"]
    );
    res.status(201).json(rows[0]);
  })
);

// Body: { "label": "Rent", "amount": 150000, "frequency": "monthly" }  (weekly | monthly | quarterly | yearly)
app.post(
  "/users/:id/overheads",
  wrap(async (req, res) => {
    const label = typeof req.body.label === "string" ? req.body.label.trim().slice(0, 100) : "";
    const amount = Number(req.body.amount);
    if (!label || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "label and a non-negative amount are required" });
    }
    const { rows } = await query(
      `insert into overhead_items (user_id, label, amount, frequency) values ($1, $2, $3, $4::cost_frequency)
       returning id, label, amount, frequency`,
      [req.params.id, label, amount, req.body.frequency ?? "monthly"]
    );
    res.status(201).json(rows[0]);
  })
);

// Marks onboarding as finished.
app.post(
  "/users/:id/onboarding/complete",
  wrap(async (req, res) => {
    const { rows } = await query(
      `insert into profiles (user_id, onboarding_done_at) values ($1, now())
       on conflict (user_id) do update set onboarding_done_at = now()
       returning onboarding_done_at`,
      [req.params.id]
    );
    res.json(rows[0]);
  })
);

// Body: { "status": "done" }  (todo | in_progress | done | dropped)
app.patch(
  "/users/:id/tasks/:taskId",
  wrap(async (req, res) => {
    if (!req.body.status) return res.status(400).json({ error: "status is required" });
    const { rows } = await query(
      `update tasks
       set status = $3::task_status,
           completed_at = case when $3::task_status = 'done' then now() else null end
       where id = $1 and user_id = $2
       returning id, title, quadrant, status`,
      [req.params.taskId, req.params.id, req.body.status]
    );
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(rows[0]);
  })
);

// --- 6. Chat with Compass -------------------------------------------------
// Body: { "message": "Help me plan my week", "conversation_id": "<optional>" }
// Leave conversation_id out to start a new conversation; send it back to continue one.
app.post(
  "/users/:id/chat",
  chatLimiter,
  wrap(async (req, res) => {
    const result = await handleChat(req.params.id, req.body.conversation_id, req.body.message);
    res.json(result);
  })
);

// --- 7. See saved tasks (grouped by Eisenhower quadrant) ------------------
app.get(
  "/users/:id/tasks",
  wrap(async (req, res) => {
    const { rows } = await query(
      `select id, title, quadrant, quadrant_reason, status, estimated_minutes, due_at, is_first_action
       from tasks where user_id = $1
       order by status, quadrant nulls last, created_at desc`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// --- 8. Read a conversation's messages ------------------------------------
app.get(
  "/users/:id/conversations/:cid/messages",
  wrap(async (req, res) => {
    const { rows } = await query(
      `select m.role, m.content, m.tool_calls, m.created_at
       from messages m join conversations c on c.id = m.conversation_id
       where c.id = $1 and c.user_id = $2
       order by m.created_at`,
      [req.params.cid, req.params.id]
    );
    res.json(rows);
  })
);

// --- Error handler --------------------------------------------------------
// Postgres error codes starting with 22 or 23 mean "bad input" (wrong enum value,
// invalid id, missing user, duplicate email), so we return 400 instead of 500.
app.use((err, req, res, next) => {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  if (err.isAiError) {
    console.error(err.message);
    return res.status(502).json({ error: "The AI service had a problem. Please try again in a moment." });
  }
  if (typeof err.code === "string" && (err.code.startsWith("22") || err.code.startsWith("23"))) {
    return res.status(400).json({ error: err.detail || err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Compass backend running on http://localhost:${port}`));
