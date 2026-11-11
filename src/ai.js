// Talks to the AI. Two providers are supported, chosen in your .env file:
//   AI_PROVIDER=gemini     -> Google Gemini (has a free tier)
//   AI_PROVIDER=anthropic  -> Claude (paid)
// If AI_PROVIDER isn't set, Gemini is used when only GEMINI_API_KEY exists.
// Both use plain fetch, so there is nothing extra to install.
import "dotenv/config";

const MAX_TOOL_ROUNDS = 5; // safety stop so the AI can't loop forever

export function activeProvider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "gemini" || p === "anthropic") return p;
  if (process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "gemini";
  return "anthropic";
}

// One entry point for chat.js:
//   history     = [{ role: "user" | "assistant", content }]
//   userMessage = the new message
//   tools       = TOOL_DEFINITIONS from tools.js
//   runTool     = (name, input) => { content, isError }
// Returns { reply, actions }.
export async function runAssistant(args) {
  return activeProvider() === "gemini" ? geminiRun(args) : anthropicRun(args);
}

function missingKey(message) {
  const err = new Error(message);
  err.httpStatus = 503; // the error handler sends this message to the app as-is
  return err;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function geminiCall({ model, key, system, contents, declarations }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: declarations.length ? [{ functionDeclarations: declarations }] : undefined,
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Gemini API error ${res.status}: ${body}`);
    const fail = (status, message) => Object.assign(new Error(message), { httpStatus: status });
    if (res.status === 429)
      throw fail(429, "The free AI quota is used up for now. Wait a minute and try again (if it keeps happening, you may have hit the daily limit).");
    if (res.status === 404)
      throw fail(502, `The AI model "${model}" wasn't found. Check GEMINI_MODEL in the backend .env (see the models list in Google AI Studio).`);
    if (res.status === 400 && /api key/i.test(body))
      throw fail(502, "Google rejected the Gemini API key. Check GEMINI_API_KEY in the backend .env and restart.");
    const err = new Error(`Gemini API error ${res.status}`);
    err.isAiError = true;
    throw err;
  }
  return res.json();
}

// Gemini wants the result of a tool as an object.
function toObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: text };
  }
}

async function geminiRun({ system, history, userMessage, tools, runTool }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw missingKey("The AI key isn't set up on the server yet. Add GEMINI_API_KEY to the backend .env file and restart it.");
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

  // Same tools, written the way Gemini expects. A tool with no inputs omits "parameters".
  const declarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.input_schema?.properties || {}).length ? { parameters: t.input_schema } : {}),
  }));

  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const actions = [];
  let reply = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await geminiCall({ model, key, system, contents, declarations });
    const content = data.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();

    if (calls.length === 0) {
      reply = text;
      break;
    }

    // Send the model's turn back exactly as received (Gemini 3 needs its hidden "thought signatures" kept).
    contents.push(content);

    const responseParts = [];
    for (const p of calls) {
      const call = p.functionCall;
      const out = await runTool(call.name, call.args || {});
      actions.push({ tool: call.name, input: call.args || {}, ok: !out.isError });
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}), // Gemini 3 requires the call id to be echoed back
          name: call.name,
          response: out.isError ? { error: out.content } : toObject(out.content),
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return { reply, actions };
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------
async function callClaude({ system, messages, tools }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingKey("The AI key isn't set up on the server yet. Add ANTHROPIC_API_KEY to the backend .env file and restart it.");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 1500, // caps the length (and cost) of each reply
      system,
      messages,
      tools,
    }),
  });
  if (!res.ok) {
    const err = new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    err.isAiError = true; // the server returns a friendly 502 instead of leaking details
    throw err;
  }
  return res.json();
}

async function anthropicRun({ system, history, userMessage, tools, runTool }) {
  const messages = [...history, { role: "user", content: userMessage }];
  const actions = [];
  let reply = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await callClaude({ system, messages, tools });
    messages.push({ role: "assistant", content: data.content });

    const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const calls = data.content.filter((b) => b.type === "tool_use");

    if (data.stop_reason !== "tool_use" || calls.length === 0) {
      reply = text;
      break;
    }

    const results = [];
    for (const call of calls) {
      const out = await runTool(call.name, call.input);
      actions.push({ tool: call.name, input: call.input, ok: !out.isError });
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: out.content,
        ...(out.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { reply, actions };
}
