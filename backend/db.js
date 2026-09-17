import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isVercel = Boolean(process.env.VERCEL);
const DATA_DIR = isVercel
  ? path.join(os.tmpdir(), "studymate_data")
  : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "studymate_db.json");

// Mongoose Schemas (used when MongoDB URI is provided)
const UserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true, lowercase: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  title: { type: String, default: "Untitled Lecture" },
  filename: { type: String, default: "Uploaded File" },
  fileType: { type: String, default: "doc" },
  notes: { type: mongoose.Schema.Types.Mixed },
  transcript: { type: String, default: "" },
  quizScore: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

let UserModel = null;
let SessionModel = null;
let isMongoConnected = false;

// Attempt MongoDB connection if MONGODB_URI or MONGO_URI is set
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (mongoUri) {
  mongoose
    .connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    })
    .then(() => {
      isMongoConnected = true;
      UserModel = mongoose.models.User || mongoose.model("User", UserSchema);
      SessionModel = mongoose.models.Session || mongoose.model("Session", SessionSchema);
      console.log(" Connected to MongoDB Database successfully!");
    })
    .catch((err) => {
      console.warn(" MongoDB connection failed, falling back to local JSON database:", err.message);
      isMongoConnected = false;
    });
}

// In-memory cache fallback to ensure reliability
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
    // In-memory state maintained even if disk write is blocked
  }
}

export const db = {
  getEngine() {
    return isMongoConnected ? "MongoDB" : "JSON Database";
  },

  async findUserByEmail(email) {
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (isMongoConnected && UserModel) {
      try {
        const user = await UserModel.findOne({ email: normalizedEmail }).lean();
        if (user) return user;
      } catch (err) {
        console.warn("MongoDB findUserByEmail error:", err.message);
      }
    }
    const data = readDb();
    return data.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  },

  async findUserById(id) {
    if (isMongoConnected && UserModel) {
      try {
        const user = await UserModel.findOne({ id }).lean();
        if (user) return user;
      } catch (err) {
        console.warn("MongoDB findUserById error:", err.message);
      }
    }
    const data = readDb();
    return data.users.find((u) => u.id === id);
  },

  async createUser(user) {
    const newUser = {
      id: user.id,
      name: user.name.trim(),
      email: user.email.trim().toLowerCase(),
      passwordHash: user.passwordHash,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };

    if (isMongoConnected && UserModel) {
      try {
        await UserModel.create(newUser);
      } catch (err) {
        console.warn("MongoDB createUser error:", err.message);
      }
    }

    // Always persist to local JSON database for safety & offline sync
    const data = readDb();
    const existingIndex = data.users.findIndex((u) => u.email === newUser.email);
    if (existingIndex >= 0) {
      data.users[existingIndex] = newUser;
    } else {
      data.users.push(newUser);
    }
    writeDb(data);

    return newUser;
  },

  async updateUserLastLogin(id) {
    const now = new Date().toISOString();
    if (isMongoConnected && UserModel) {
      try {
        await UserModel.updateOne({ id }, { $set: { lastLoginAt: now } });
      } catch (err) {
        console.warn("MongoDB updateUserLastLogin error:", err.message);
      }
    }
    const data = readDb();
    const user = data.users.find((u) => u.id === id);
    if (user) {
      user.lastLoginAt = now;
      writeDb(data);
    }
  },

  async getUserCount() {
    if (isMongoConnected && UserModel) {
      try {
        return await UserModel.countDocuments();
      } catch (e) {
        // fallback
      }
    }
    const data = readDb();
    return data.users.length;
  },

  // Study Session operations
  async getSessionsByUserId(userId) {
    if (isMongoConnected && SessionModel) {
      try {
        const sessions = await SessionModel.find({ userId }).sort({ createdAt: -1 }).lean();
        if (sessions && sessions.length > 0) return sessions;
      } catch (err) {
        console.warn("MongoDB getSessionsByUserId error:", err.message);
      }
    }
    const data = readDb();
    return data.sessions
      .filter((s) => s.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async getSessionById(id, userId) {
    if (isMongoConnected && SessionModel) {
      try {
        const query = userId ? { id, userId } : { id };
        const session = await SessionModel.findOne(query).lean();
        if (session) return session;
      } catch (err) {
        console.warn("MongoDB getSessionById error:", err.message);
      }
    }
    const data = readDb();
    return data.sessions.find((s) => s.id === id && (!userId || s.userId === userId));
  },

  async createSession(session) {
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

    if (isMongoConnected && SessionModel) {
      try {
        await SessionModel.create(newSession);
      } catch (err) {
        console.warn("MongoDB createSession error:", err.message);
      }
    }

    const data = readDb();
    data.sessions.push(newSession);
    writeDb(data);

    return newSession;
  },

  async updateSession(id, userId, updates) {
    const now = new Date().toISOString();
    if (isMongoConnected && SessionModel) {
      try {
        const query = userId ? { id, userId } : { id };
        await SessionModel.updateOne(query, { $set: { ...updates, updatedAt: now } });
      } catch (err) {
        console.warn("MongoDB updateSession error:", err.message);
      }
    }

    const data = readDb();
    const index = data.sessions.findIndex((s) => s.id === id && (!userId || s.userId === userId));
    if (index === -1) return null;
    data.sessions[index] = {
      ...data.sessions[index],
      ...updates,
      updatedAt: now,
    };
    writeDb(data);
    return data.sessions[index];
  },

  async deleteSession(id, userId) {
    if (isMongoConnected && SessionModel) {
      try {
        const query = userId ? { id, userId } : { id };
        await SessionModel.deleteOne(query);
      } catch (err) {
        console.warn("MongoDB deleteSession error:", err.message);
      }
    }

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
