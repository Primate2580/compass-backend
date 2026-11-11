// "Tools" are actions Claude can ask our server to perform, such as saving a task.
// Claude never touches the database directly. It asks, and THIS code decides what happens.
// Note that userId always comes from the server, never from Claude, so Claude
// can only ever read and write the current user's own rows.
import { pool, query } from "./db.js";

// --- small input cleaners (Claude's output is treated as untrusted input) ---
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const minutes = (v) => (Number.isInteger(v) && v > 0 && v <= 1440 ? v : null);
const HORIZONS = ["3_month", "12_month", "other"];

// What we tell Claude about each tool (name, when to use it, what inputs it takes).
export const TOOL_DEFINITIONS = [
  {
    name: "list_open_tasks",
    description:
      "List the user's current open tasks (todo or in progress). Call this before prioritizing, planning, or adding tasks so you don't create duplicates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_task",
    description:
      "Save one task to the user's task list. Only save tasks the user asked you to add or agreed to. Never save speculative tasks. The Eisenhower quadrant is derived from is_important and is_urgent.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, action-style title" },
        is_important: { type: "boolean", description: "Does it move the user toward their goals or protect something that matters?" },
        is_urgent: { type: "boolean", description: "Does it need attention soon, with real consequences if delayed?" },
        quadrant_reason: { type: "string", description: "One-line reason for the placement" },
        estimated_minutes: { type: "integer" },
        due_at: { type: "string", description: "ISO 8601 date-time with offset, e.g. 2026-11-20T17:00:00+01:00" },
      },
      required: ["title", "is_important", "is_urgent"],
    },
  },
  {
    name: "create_goal",
    description:
      "Save a SMART goal with milestones and one first action (under 30 minutes, doable this week). Only call this after the user has seen and accepted the breakdown.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The goal in the user's own words" },
        horizon: { type: "string", enum: HORIZONS },
        specific: { type: "string", description: "Exactly what will be achieved" },
        measurable_metric: { type: "string", description: "What is counted, e.g. 'paying clients'" },
        target_value: { type: "number" },
        achievable_note: { type: "string", description: "Why this is realistic given the user's time, energy and money" },
        relevant_note: { type: "string", description: "Why it matters to this user" },
        due_date: { type: "string", description: "YYYY-MM-DD" },
        milestones: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, due_date: { type: "string", description: "YYYY-MM-DD" } },
            required: ["title"],
          },
        },
        first_action: {
          type: "object",
          properties: { title: { type: "string" }, estimated_minutes: { type: "integer" } },
          required: ["title"],
        },
      },
      required: ["title", "specific", "measurable_metric", "due_date", "first_action"],
    },
  },
];

// --- tool implementations ---------------------------------------------------

async function listOpenTasks(userId) {
  const { rows } = await query(
    `select id, title, quadrant, status, due_at, estimated_minutes
     from tasks
     where user_id = $1 and status in ('todo','in_progress')
     order by created_at desc
     limit 30`,
    [userId]
  );
  return { count: rows.length, tasks: rows };
}

async function addTask(userId, input) {
  const title = str(input.title, 200);
  if (!title) throw new Error("title is required");

  const { rows } = await query(
    `insert into tasks (user_id, title, is_important, is_urgent, quadrant_reason, estimated_minutes, due_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, title, quadrant`,
    [userId, title, bool(input.is_important), bool(input.is_urgent), str(input.quadrant_reason, 300), minutes(input.estimated_minutes), str(input.due_at, 40)]
  );
  return { saved: rows[0] };
}

// Goal + milestones + first action are saved together in one transaction:
// either everything is saved or nothing is, so you never get half a goal.
async function createGoal(userId, input) {
  const title = str(input.title, 200);
  if (!title) throw new Error("title is required");

  const client = await pool.connect();
  try {
    await client.query("begin");

    const goal = await client.query(
      `insert into goals (user_id, title, horizon, specific, measurable_metric, target_value, achievable_note, relevant_note, due_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        userId,
        title,
        HORIZONS.includes(input.horizon) ? input.horizon : "other",
        str(input.specific, 500),
        str(input.measurable_metric, 200),
        num(input.target_value),
        str(input.achievable_note, 500),
        str(input.relevant_note, 500),
        str(input.due_date, 10),
      ]
    );
    const goalId = goal.rows[0].id;

    const milestones = Array.isArray(input.milestones) ? input.milestones.slice(0, 10) : [];
    let milestonesSaved = 0;
    for (const [i, m] of milestones.entries()) {
      const mTitle = str(m?.title, 200);
      if (!mTitle) continue;
      await client.query(`insert into milestones (goal_id, title, due_date, position) values ($1, $2, $3, $4)`, [
        goalId,
        mTitle,
        str(m.due_date, 10),
        i,
      ]);
      milestonesSaved++;
    }

    let firstAction = null;
    const fTitle = str(input.first_action?.title, 200);
    if (fTitle) {
      const t = await client.query(
        `insert into tasks (user_id, goal_id, title, is_important, is_urgent, quadrant_reason, estimated_minutes, is_first_action)
         values ($1, $2, $3, true, false, 'First step of a goal', $4, true)
         returning id, title, quadrant`,
        [userId, goalId, fTitle, minutes(input.first_action.estimated_minutes)]
      );
      firstAction = t.rows[0];
    }

    await client.query("commit");
    return { goal_id: goalId, milestones_saved: milestonesSaved, first_action: firstAction };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// Runs a tool by name. Errors are returned to Claude as text so it can correct itself
// (for example, retry with a valid date) instead of crashing the request.
export async function runTool(userId, name, input = {}) {
  try {
    let result;
    if (name === "list_open_tasks") result = await listOpenTasks(userId);
    else if (name === "add_task") result = await addTask(userId, input);
    else if (name === "create_goal") result = await createGoal(userId, input);
    else return { content: `Unknown tool: ${name}`, isError: true };
    return { content: JSON.stringify(result), isError: false };
  } catch (e) {
    return { content: `Tool failed: ${e.message}`, isError: true };
  }
}
