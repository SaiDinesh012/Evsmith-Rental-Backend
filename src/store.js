import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");
const dbFile = path.join(dataDir, "db.json");
const tempFile = path.join(dataDir, "db.json.tmp");

function ensure() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({
      users: [], admins: [], bikes: [], rentals: [], payments: [], notifications: []
    }, null, 2));
  }
}

export function readDb() {
  ensure();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

export function writeDb(db) {
  ensure();
  // Atomic write pattern: write to tmp file first, then atomically rename
  // Guarantees zero corrupted JSON files if process is interrupted
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tempFile, dbFile);
  return db;
}

export function updateDb(fn) {
  const db = readDb();
  fn(db);
  return writeDb(db);
}

export function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}
