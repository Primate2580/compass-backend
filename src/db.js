// The one place that knows how to talk to Neon.
// Every other file imports `query` from here.
import "dotenv/config";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Copy .env.example to .env and paste your Neon connection string.");
}

// A "pool" keeps a few connections open and reuses them, which is faster
// than reconnecting for every request.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// query("select * from users where id = $1", [id])
// The $1, $2 placeholders keep user input out of the SQL text, which blocks SQL injection.
export const query = (text, params) => pool.query(text, params);
