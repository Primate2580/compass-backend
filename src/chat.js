// The heart of Compass: one chat turn from "user sent a message" to "reply saved".
import { query } from "./db.js";
import { buildSystemPrompt } from "./prompt.js";
import { runAssistant } from "./ai.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

const MAX_MESSAGE_CHARS = 4000; // longest message we accept from a user
const MAX_HISTORY = 20; // how many past messages Claude sees (keeps cost down)

const TOOLS_NOTE = `

# TOOLS
You can save tasks and goals to the user's account and look up their open tasks.
- Save only what the user asked for or agreed to. If unsure, show the plan first and ask.
- After saving, tell the user briefly what you saved.
- If a tool fails, try once more with corrected input, or explain the problem plainly.`;

// Lets the API route reply with a proper status code (404, 400...) instead of 500.
export class HttpError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

// Claude expects messages to start with "user" and alternate roles.
// Old data can break that (for example after a failed request), so we tidy it.
function tidyHistory(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += "\n\n" + r.content;
    else out.push({ role: r.role, content: r.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function handleChat(userId, conversationId, rawMessage) {
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (!message) throw new HttpError(400, "message is required");
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  }

  // 1. Build the system prompt from this user's profile in Neon.
  const baseSystem = await buildSystemPrompt(userId);
  if (!baseSystem) throw new HttpError(404, "User not found");
  const system = baseSystem + TOOLS_NOTE;

  // 2. Find (or start) the conversation. It must belong to this user.
  let convoId = conversationId;
  let history = [];
  if (convoId) {
    const own = await query("select id from conversations where id = $1 and user_id = $2", [convoId, userId]);
    if (!own.rows.length) throw new HttpError(404, "Conversation not found");

    const past = await query(
      `select role, content from (
         select role, content, created_at from messages
         where conversation_id = $1 and role in ('user','assistant') and content is not null
         order by created_at desc limit $2
       ) recent order by created_at asc`,
      [convoId, MAX_HISTORY]
    );
    history = tidyHistory(past.rows);
  }

  // 3. Ask the AI (Gemini or Claude, set in .env). If it wants to use a tool, ai.js runs it
  //    against Neon and sends the result back, repeating until the AI gives a normal answer.
  const { reply: aiReply, actions } = await runAssistant({
    system,
    history,
    userMessage: message,
    tools: TOOL_DEFINITIONS,
    runTool: (name, input) => runTool(userId, name, input),
  });
  let reply = aiReply;

  if (!reply) reply = "Sorry, I got tangled up on that one. Could you try asking again?";

  // 4. Save both sides of the turn only after success, so failures leave no half-saved turns
  //    (and no empty conversations if the AI was unavailable).
  if (!convoId) {
    const created = await query(`insert into conversations (user_id, title) values ($1, $2) returning id`, [
      userId,
      message.slice(0, 60),
    ]);
    convoId = created.rows[0].id;
  }
  await query(
    `insert into messages (conversation_id, role, content, created_at) values ($1, 'user', $2, clock_timestamp())`,
    [convoId, message]
  );
  await query(
    `insert into messages (conversation_id, role, content, tool_calls, created_at)
     values ($1, 'assistant', $2, $3, clock_timestamp())`,
    [convoId, reply, actions.length ? JSON.stringify(actions) : null]
  );

  return { conversation_id: convoId, reply, actions };
}
