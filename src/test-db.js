// Run with: npm run test-db
// If this prints a timestamp, your backend can reach your Neon database.
import { query, pool } from "./db.js";

const { rows } = await query("select now() as server_time");
console.log("Connected to Neon. Server time:", rows[0].server_time);
await pool.end();
