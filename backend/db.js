import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In Vercel / serverless Lambdas, __dirname is read-only.
// Use os.tmpdir() when on Vercel or if local data dir is not writable.
const isVercel = Boolean(process.env.VERCEL);
const DATA_DIR = isVercel
  ? path.join(os.tmpdir(), "studymate_data")
  : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "studymate_db.json");

// In-memory cache fallback to ensure 0 crashes if filesystem is completely locked
let memoryDb = {
  users: [],
  sessions: [],
};

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("Could not create data dir, using in-memory fallback:", e.message);
}

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      try {
        fs.writeFileSync(DB_FILE, JSON.stringify(memoryDb, null, 2), "utf8");
      } catch (we) {
        // silent write error
      }
      return memoryDb;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    memoryDb = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
    return memoryDb;
  } catch (err) {
    return memoryDb;
  }
}

function writeDb(data) {
  memoryDb = data;
  try {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    // In-memory state is maintained even if disk write is not permitted
  }
}

export const db = {
  // User operations
  findUserByEmail(email) {
    const data = readDb();
    return data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  },

  findUserById(id) {
    const data = readDb();
    return data.users.find((u) => u.id === id);
  },

  createUser(user) {
    const data = readDb();
    const newUser = {
      id: user.id,
      name: user.name,
      email: user.email.toLowerCase(),
      passwordHash: user.passwordHash,
      createdAt: new Date().toISOString(),
    };
    data.users.push(newUser);
    writeDb(data);
    return newUser;
  },

  // Study Session operations
  getSessionsByUserId(userId) {
    const data = readDb();
    return data.sessions
      .filter((s) => s.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  getSessionById(id, userId) {
    const data = readDb();
    return data.sessions.find((s) => s.id === id && (!userId || s.userId === userId));
  },

  createSession(session) {
    const data = readDb();
    const newSession = {
      id: session.id,
      userId: session.userId || "guest",
      title: session.title || "Untitled Lecture",
      filename: session.filename || "Uploaded File",
      fileType: session.fileType || "doc",
      notes: session.notes,
      transcript: session.transcript || "",
      quizScore: session.quizScore || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.sessions.push(newSession);
    writeDb(data);
    return newSession;
  },

  updateSession(id, userId, updates) {
    const data = readDb();
    const index = data.sessions.findIndex((s) => s.id === id && (!userId || s.userId === userId));
    if (index === -1) return null;
    data.sessions[index] = {
      ...data.sessions[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    writeDb(data);
    return data.sessions[index];
  },

  deleteSession(id, userId) {
    const data = readDb();
    const initialLen = data.sessions.length;
    data.sessions = data.sessions.filter((s) => !(s.id === id && (!userId || s.userId === userId)));
    const deleted = data.sessions.length < initialLen;
    if (deleted) {
      writeDb(data);
    }
    return deleted;
  },
};
