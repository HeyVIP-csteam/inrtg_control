// create-owner-account.js
//
// Run this LOCALLY (never on the server) to generate the two
// `wrangler kv key put` commands needed to create a brand-new hidden
// "owner" account, directly in KV — this is the ONLY way to create one;
// there is no path through the website itself (see OWNER_ROLE_SETUP.md).
//
// Usage:
//   node create-owner-account.js <username> "<password>"
//
// The password never leaves your machine — this only prints commands
// for YOU to run with your own `wrangler login` session.
const crypto = require("crypto");
const PBKDF2_ITERATIONS = 10000; // must match PBKDF2_ITERATIONS_CURRENT in functions/_shared/accounts.js

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("base64");
}

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node create-owner-account.js <username> <password>");
  process.exit(1);
}

const key = username.toLowerCase();
const salt = crypto.randomBytes(16);
const account = {
  username: key,
  salt: salt.toString("base64"),
  hash: hashPassword(password, salt),
  iterations: PBKDF2_ITERATIONS,
  tokenVersion: 0,
  role: "owner",
  officeId: null,
  allowedBrands: "all",
  allowedModules: "all",
  fullName: "",
  pid: "",
  lastActiveAt: null,
  lastPasswordChange: { at: new Date().toISOString(), by: key },
  locked: false,
  lockedAt: null,
  lockedReason: null,
};

console.log(`wrangler kv key put --binding=THREADS_KV "account:${key}" '${JSON.stringify(account)}' --remote`);
console.log(`\n然后把 "${key}" 加进 accounts-index 这个数组（先 wrangler kv key get 看现有内容再拼）：`);
console.log(`wrangler kv key get --binding=THREADS_KV "accounts-index" --remote`);
console.log(`wrangler kv key put --binding=THREADS_KV "accounts-index" '["${key}", ...现有数组内容...]' --remote`);
