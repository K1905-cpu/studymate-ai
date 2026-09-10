import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "studymate_db.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultData = {
  users: [],
  sessions: [],
};

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), "utf8");
      return defaultData;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading DB file, returning fallback:", err);
    return defaultData;
  }
}

function writeDb(data) {
  try {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error("Error writing DB file:", err);
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
