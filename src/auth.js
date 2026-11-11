// Login system: email + password, with a signed token (JWT) the browser sends on every request.
//
//   register -> hash the password with bcrypt, save the user, hand back a token
//   login    -> compare the password to the stored hash, hand back a token
//   requireAuth -> checks the token on protected routes and works out WHO is asking
//   requireSelf -> makes sure they only touch THEIR OWN /users/:id/... data
import "dotenv/config";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { query } from "./db.js";

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  throw new Error(
    "JWT_SECRET is missing or too short. Generate one with:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
      "and put it in .env (and in Render's environment variables)."
  );
}

const TOKEN_LIFETIME = "7d";
const httpError = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });

// Used when the email isn't found, so a wrong email and a wrong password take the same time
// and an attacker can't use response speed to learn which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const signToken = (userId) => jwt.sign({ sub: userId }, secret, { algorithm: "HS256", expiresIn: TOKEN_LIFETIME });

function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return "Africa/Lagos";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "Africa/Lagos";
  }
}

const normalizeEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- routes -----------------------------------------------------------------

// Body: { email, password, full_name?, timezone? }
export async function register(req, res) {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, "Please enter a valid email address.");
  if (typeof password !== "string" || password.length < 8) throw httpError(400, "Your password must be at least 8 characters.");
  if (password.length > 72) throw httpError(400, "Your password must be 72 characters or fewer.");

  const fullName = typeof req.body.full_name === "string" ? req.body.full_name.trim().slice(0, 100) || null : null;
  const hash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await query(
      `insert into users (email, full_name, timezone, password_hash)
       values ($1, $2, $3, $4)
       returning id, email, full_name, timezone`,
      [email, fullName, validTimezone(req.body.timezone), hash]
    );
    res.status(201).json({ token: signToken(rows[0].id), user: rows[0] });
  } catch (e) {
    if (e.code === "23505") throw httpError(409, "That email is already registered. Try logging in instead.");
    throw e;
  }
}

// Body: { email, password }
export async function login(req, res) {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";

  const { rows } = await query(
    "select id, email, full_name, timezone, password_hash from users where email = $1",
    [email]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);

  // Same message for "no such email" and "wrong password" on purpose.
  if (!user || !user.password_hash || !ok) throw httpError(401, "Incorrect email or password.");

  const { password_hash, ...safe } = user;
  res.json({ token: signToken(user.id), user: safe });
}

// Who am I, have I finished onboarding, and which conversation was I last in?
export async function me(req, res) {
  const u = await query("select id, email, full_name, timezone from users where id = $1", [req.userId]);
  if (!u.rows.length) throw httpError(401, "Account not found. Please log in again.");
  const [p, c] = await Promise.all([
    query("select onboarding_done_at from profiles where user_id = $1", [req.userId]),
    query("select id from conversations where user_id = $1 order by created_at desc limit 1", [req.userId]),
  ]);
  res.json({ user: u.rows[0], profile: p.rows[0] || null, latest_conversation_id: c.rows[0]?.id ?? null });
}

// --- middleware --------------------------------------------------------------

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Please log in." });
  try {
    req.userId = jwt.verify(token, secret, { algorithms: ["HS256"] }).sub;
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

// Used on /users/:id/... so you can only ever reach your own data.
export function requireSelf(req, res, next) {
  if (req.params.id !== req.userId) return res.status(403).json({ error: "You can only access your own data." });
  next();
}

// --- rate limits -------------------------------------------------------------

// Slows down password guessing and mass sign-ups.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// Protects your AI quota (and bill): each user gets a limited number of messages per hour.
export const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.CHAT_LIMIT_PER_HOUR) || 40,
  keyGenerator: (req) => req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You've reached the hourly message limit. Please try again a little later." },
});
