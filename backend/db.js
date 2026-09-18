import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isVercel = Boolean(process.env.VERCEL);
const DATA_DIR = isVercel
  ? path.join(os.tmpdir(), "studymate_data")
  : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "studymate_db.json");

// In-memory cache fallback to ensure 0 crashes anywhere
let memoryDb = {
  users: [],
  sessions: [],
};

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  // Silent fallback to memory storage
}

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      try {
        fs.writeFileSync(DB_FILE, JSON.stringify(memoryDb, null, 2), "utf8");
      } catch (we) {
        // silent write error on read-only environments
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
    // In-memory state is maintained even if disk write is blocked
  }
}

// MongoDB Lazy Loader
let mongoose = null;
let UserModel = null;
let SessionModel = null;
let isMongoConnected = false;
let mongoInitAttempted = false;

async function getMongoModels() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) return null;

  if (isMongoConnected && UserModel && SessionModel) {
    return { UserModel, SessionModel };
  }

  if (mongoInitAttempted && !isMongoConnected) {
    return null;
  }

  mongoInitAttempted = true;
  try {
    const mod = await import("mongoose");
    mongoose = mod.default || mod;

    const UserSchema = new mongoose.Schema({
      id: { type: String, required: true, unique: true, index: true },
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true, index: true, lowercase: true },
      passwordHash: { type: String, required: true },
      provider: { type: String, default: "local" },
      avatar: { type: String, default: null },
      providerId: { type: String, default: null },
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

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 3000,
      });
    }

    UserModel = mongoose.models.User || mongoose.model("User", UserSchema);
    SessionModel = mongoose.models.Session || mongoose.model("Session", SessionSchema);
    isMongoConnected = true;
    console.log(" Connected to MongoDB Database successfully!");
    return { UserModel, SessionModel };
  } catch (err) {
    console.warn(" MongoDB connection warning (using persistent JSON storage):", err.message);
    isMongoConnected = false;
    return null;
  }
}

// Background connect if Mongo URI is present
if (process.env.MONGODB_URI || process.env.MONGO_URI) {
  getMongoModels().catch(() => {});
}

export const db = {
  getEngine() {
    return isMongoConnected ? "MongoDB" : "JSON Database";
  },

  async findUserByEmail(email) {
    const normalizedEmail = (email || "").trim().toLowerCase();
    try {
      const models = await getMongoModels();
      if (models?.UserModel) {
        const user = await models.UserModel.findOne({ email: normalizedEmail }).lean();
        if (user) return user;
      }
    } catch (err) {
      // fallback
    }
    const data = readDb();
    return data.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  },

  async findUserById(id) {
    try {
      const models = await getMongoModels();
      if (models?.UserModel) {
        const user = await models.UserModel.findOne({ id }).lean();
        if (user) return user;
      }
    } catch (err) {
      // fallback
    }
    const data = readDb();
    return data.users.find((u) => u.id === id);
  },

  async createUser(user) {
    const newUser = {
      id: user.id || crypto.randomUUID(),
      name: user.name.trim(),
      email: user.email.trim().toLowerCase(),
      passwordHash: user.passwordHash || `oauth_${user.provider || "user"}`,
      provider: user.provider || "local",
      avatar: user.avatar || null,
      providerId: user.providerId || null,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };

    try {
      const models = await getMongoModels();
      if (models?.UserModel) {
        await models.UserModel.create(newUser);
      }
    } catch (err) {
      console.warn("MongoDB createUser error:", err.message);
    }

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

  async upsertSocialUser({ name, email, provider, avatar, providerId }) {
    const normalizedEmail = (email || "").trim().toLowerCase();
    const cleanName = (name || "").trim() || `${provider.charAt(0).toUpperCase() + provider.slice(1)} Scholar`;
    const now = new Date().toISOString();

    let existingUser = await this.findUserByEmail(normalizedEmail);
    if (existingUser) {
      // Update last login and provider/avatar if not present
      try {
        const models = await getMongoModels();
        if (models?.UserModel) {
          const updateFields = { lastLoginAt: now };
          if (provider && existingUser.provider === "local") updateFields.provider = provider;
          if (avatar && !existingUser.avatar) updateFields.avatar = avatar;
          if (providerId && !existingUser.providerId) updateFields.providerId = providerId;
          await models.UserModel.updateOne({ id: existingUser.id }, { $set: updateFields });
        }
      } catch (err) {
        // fallback
      }

      const data = readDb();
      const userInDb = data.users.find((u) => u.id === existingUser.id || u.email.toLowerCase() === normalizedEmail);
      if (userInDb) {
        userInDb.lastLoginAt = now;
        if (provider && userInDb.provider === "local") userInDb.provider = provider;
        if (avatar && !userInDb.avatar) userInDb.avatar = avatar;
        if (providerId && !userInDb.providerId) userInDb.providerId = providerId;
        writeDb(data);
        existingUser = userInDb;
      }
      return existingUser;
    }

    // Create new user for social login
    const newUser = {
      id: crypto.randomUUID(),
      name: cleanName,
      email: normalizedEmail,
      passwordHash: `oauth_${provider}_${crypto.randomBytes(8).toString("hex")}`,
      provider: provider || "google",
      avatar: avatar || null,
      providerId: providerId || null,
      createdAt: now,
      lastLoginAt: now,
    };

    return await this.createUser(newUser);
  },

  async updateUserLastLogin(id) {
    const now = new Date().toISOString();
    try {
      const models = await getMongoModels();
      if (models?.UserModel) {
        await models.UserModel.updateOne({ id }, { $set: { lastLoginAt: now } });
      }
    } catch (err) {
      // fallback
    }
    const data = readDb();
    const user = data.users.find((u) => u.id === id);
    if (user) {
      user.lastLoginAt = now;
      writeDb(data);
    }
  },

  async getUserCount() {
    try {
      const models = await getMongoModels();
      if (models?.UserModel) {
        return await models.UserModel.countDocuments();
      }
    } catch (e) {
      // fallback
    }
    const data = readDb();
    return data.users.length;
  },

  async getSessionsByUserId(userId) {
    try {
      const models = await getMongoModels();
      if (models?.SessionModel) {
        const sessions = await models.SessionModel.find({ userId }).sort({ createdAt: -1 }).lean();
        if (sessions && sessions.length > 0) return sessions;
      }
    } catch (err) {
      // fallback
    }
    const data = readDb();
    return data.sessions
      .filter((s) => s.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async getSessionById(id, userId) {
    try {
      const models = await getMongoModels();
      if (models?.SessionModel) {
        const query = userId ? { id, userId } : { id };
        const session = await models.SessionModel.findOne(query).lean();
        if (session) return session;
      }
    } catch (err) {
      // fallback
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

    try {
      const models = await getMongoModels();
      if (models?.SessionModel) {
        await models.SessionModel.create(newSession);
      }
    } catch (err) {
      console.warn("MongoDB createSession error:", err.message);
    }

    const data = readDb();
    data.sessions.push(newSession);
    writeDb(data);

    return newSession;
  },

  async updateSession(id, userId, updates) {
    const now = new Date().toISOString();
    try {
      const models = await getMongoModels();
      if (models?.SessionModel) {
        const query = userId ? { id, userId } : { id };
        await models.SessionModel.updateOne(query, { $set: { ...updates, updatedAt: now } });
      }
    } catch (err) {
      // fallback
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
    try {
      const models = await getMongoModels();
      if (models?.SessionModel) {
        const query = userId ? { id, userId } : { id };
        await models.SessionModel.deleteOne(query);
      }
    } catch (err) {
      // fallback
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
