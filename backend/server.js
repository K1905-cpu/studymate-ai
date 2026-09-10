import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import mammoth from "mammoth";
import { db } from "./db.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "studymate_super_secret_jwt_key_2026";

// Initialize AI clients
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const GROQ_FALLBACK_MODELS = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
  "groq/compound-mini",
];

// Middlewares
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB limit
  },
});

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      req.user = null;
    } else {
      req.user = decoded;
    }
    next();
  });
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required. Please sign in." });
  }
  next();
}

// Helper: safe string
function safeString(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    return val.message || val.text || JSON.stringify(val);
  }
  return String(val || fallback);
}

// Helper: Clean reasoning / think tags from AI response
function cleanAiText(raw) {
  if (!raw) return "";
  let text = typeof raw === "string" ? raw : safeString(raw);

  if (text.includes("</think>")) {
    const thinkEnd = text.indexOf("</think>");
    text = text.slice(thinkEnd + 8);
  } else {
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "");
  }

  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  text = text.replace(/<reasoning>[\s\S]*/gi, "");
  return text.trim();
}

// Helper: Extract JSON from AI text
function extractJson(text) {
  if (!text) return null;
  let cleaned = cleanAiText(text);

  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) {
    cleaned = jsonMatch[1].trim();
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    try {
      const sanitized = cleaned
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
        .replace(/,\s*}/g, "}")
        .replace(/,\s*\]/g, "]");
      return JSON.parse(sanitized);
    } catch (e2) {
      console.error("JSON parse error:", e2.message);
      return null;
    }
  }
}

// Multi-Tier AI Completion with Gemini 2.5 Flash as Primary
async function generateAiText(prompt, systemInstruction = "", temperature = 0.2) {
  // 1. Try Gemini 2.5 Flash
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: systemInstruction || undefined,
        generationConfig: { temperature },
      });
      const result = await model.generateContent(prompt);
      const text = result?.response?.text();
      if (text && text.trim().length > 0) {
        return text;
      }
    } catch (geminiError) {
      console.warn("Gemini 2.5 Flash failed, trying Gemini 1.5 Flash:", geminiError.message);
      try {
        const model15 = genAI.getGenerativeModel({
          model: "gemini-1.5-flash",
          systemInstruction: systemInstruction || undefined,
          generationConfig: { temperature },
        });
        const result15 = await model15.generateContent(prompt);
        const text15 = result15?.response?.text();
        if (text15 && text15.trim().length > 0) {
          return text15;
        }
      } catch (gemini15Error) {
        console.warn("Gemini 1.5 Flash failed, falling back to Groq:", gemini15Error.message);
      }
    }
  }

  // 2. Try Groq Models
  if (groq) {
    const messages = [];
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }
    messages.push({ role: "user", content: prompt });

    for (const model of GROQ_FALLBACK_MODELS) {
      try {
        const completion = await groq.chat.completions.create({
          model,
          messages,
          temperature,
          max_tokens: 4000,
        });
        const content = completion.choices?.[0]?.message?.content;
        if (content && content.trim().length > 0) {
          return content;
        }
      } catch (groqErr) {
        console.warn(`Groq model ${model} failed:`, groqErr.message);
      }
    }
  }

  throw new Error("All AI generation providers failed. Please verify your GEMINI_API_KEY or GROQ_API_KEY.");
}

// Document Text Extraction Handlers
async function extractPdfText(buffer) {
  const parsed = await pdfParse(buffer);
  return parsed.text || "";
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
}

async function transcribeMediaFile(buffer, filename) {
  if (!groq) {
    throw new Error("GROQ_API_KEY is required for audio/video transcription.");
  }
  const ext = path.extname(filename) || ".mp3";
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}${ext}`);
  try {
    fs.writeFileSync(tempPath, buffer);
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-large-v3",
      response_format: "text",
    });
    if (typeof transcription === "string") return transcription;
    if (transcription && typeof transcription.text === "string") return transcription.text;
    return String(transcription?.message || JSON.stringify(transcription) || "");
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // ignore cleanup error
      }
    }
  }
}

function sanitizeNotes(notes, fallbackContent = "") {
  if (!notes || typeof notes !== "object") {
    return createStructuredFallbackNotes(fallbackContent, "AI structure formatting issue");
  }

  const safeArray = (arr, itemSanitizer) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(itemSanitizer).filter(Boolean);
  };

  return {
    title: safeString(notes.title, "Comprehensive Study Notes"),
    subject: safeString(notes.subject, "General Studies"),
    summary: safeString(notes.summary, "Summary extracted from lecture material."),
    keyPoints: safeArray(notes.keyPoints, (p) => safeString(p)),
    actionItems: safeArray(notes.actionItems, (a) => safeString(a)),
    glossary: safeArray(notes.glossary, (g) => ({
      term: safeString(g?.term, "Key Concept"),
      definition: safeString(g?.definition, "Explanation of this concept."),
    })),
    flashcards: safeArray(notes.flashcards, (card) => ({
      question: safeString(card?.question, "Question"),
      answer: safeString(card?.answer, "Answer"),
    })),
    quiz: safeArray(notes.quiz, (q) => {
      let options = safeArray(q?.options, (opt) => safeString(opt));
      if (options.length < 2) {
        options = ["Option A", "Option B", "Option C", "Option D"];
      }
      return {
        question: safeString(q?.question, "Quiz Question"),
        options,
        answer: safeString(q?.answer, options[0]),
        explanation: safeString(q?.explanation, "Correct based on the study material."),
      };
    }),
  };
}

function createStructuredFallbackNotes(content, reason = "") {
  const contentStr = typeof content === "string" ? content : safeString(content);
  const snippet = contentStr.slice(0, 1200);

  return {
    title: "Study Material Notes",
    subject: "Uploaded Content",
    summary: snippet || "Here is the summary of your processed document.",
    keyPoints: [
      "Key topics were successfully extracted from the uploaded document.",
      "Review the key definitions and formulas highlighted in your study session.",
      "Use the interactive AI chatbot below to ask specific in-depth questions.",
    ],
    actionItems: [
      "Review the summary and flashcards.",
      "Test your understanding with the quiz questions.",
      "Ask the AI tutor for clarification on difficult topics.",
    ],
    glossary: [
      {
        term: "Lecture Overview",
        definition: "The core foundational knowledge presented in this study material.",
      },
    ],
    flashcards: [
      {
        question: "What is the primary topic of this study material?",
        answer: "The uploaded lecture content covers core principles and key takeaways.",
      },
      {
        question: "How can you reinforce this learning?",
        answer: "By reviewing flashcards, completing quizzes, and asking the AI tutor questions.",
      },
    ],
    quiz: [
      {
        question: "What is the best way to retain information from this document?",
        options: [
          "Active recall with flashcards and quizzes",
          "Passive reading once",
          "Ignoring difficult concepts",
          "Skipping summaries",
        ],
        answer: "Active recall with flashcards and quizzes",
        explanation: "Active recall and practice testing significantly boost long-term memory retention.",
      },
    ],
    reason: reason || undefined,
  };
}

// Comprehensive Study Notes Generator with High Context Window
async function generateStudyNotes(content) {
  const textContent = typeof content === "string" ? content : safeString(content);
  // Gemini 2.5 Flash has up to 1M token context! We can safely send up to 80,000 characters
  const contextSnippet = textContent.slice(0, 75000);

  const prompt = `
You are an elite academic professor and master tutor. Analyze the following study material/lecture transcript thoroughly and generate an exceptionally comprehensive, high-yield study package.

Return JSON ONLY. Do NOT wrap in markdown explanation or add text outside the JSON.

Expected JSON Structure:
{
  "title": "Clear, engaging and descriptive academic title for this lecture/document",
  "subject": "Main academic subject / field (e.g., Computer Science, Biology, Economics, History)",
  "summary": "Detailed, multi-paragraph markdown summary highlighting major themes, background, core explanations, and real-world relevance.",
  "keyPoints": [
    "Key takeaway point 1 with concise explanation",
    "Key takeaway point 2 with concise explanation",
    "Key takeaway point 3 with concise explanation",
    "Key takeaway point 4 with concise explanation",
    "Key takeaway point 5 with concise explanation",
    "Key takeaway point 6 with concise explanation"
  ],
  "actionItems": [
    "Practical study step / exercise / homework recommendation 1",
    "Practical study step / exercise / homework recommendation 2",
    "Practical study step / exercise / homework recommendation 3",
    "Practical study step / exercise / homework recommendation 4"
  ],
  "glossary": [
    {
      "term": "Key Term / Formula 1",
      "definition": "Clear, accurate definition with context."
    },
    {
      "term": "Key Term / Formula 2",
      "definition": "Clear, accurate definition with context."
    },
    {
      "term": "Key Term / Formula 3",
      "definition": "Clear, accurate definition with context."
    },
    {
      "term": "Key Term / Formula 4",
      "definition": "Clear, accurate definition with context."
    }
  ],
  "flashcards": [
    {
      "question": "Clear concept-testing question 1?",
      "answer": "Accurate, succinct explanation."
    },
    {
      "question": "Clear concept-testing question 2?",
      "answer": "Accurate, succinct explanation."
    },
    {
      "question": "Clear concept-testing question 3?",
      "answer": "Accurate, succinct explanation."
    },
    {
      "question": "Clear concept-testing question 4?",
      "answer": "Accurate, succinct explanation."
    },
    {
      "question": "Clear concept-testing question 5?",
      "answer": "Accurate, succinct explanation."
    },
    {
      "question": "Clear concept-testing question 6?",
      "answer": "Accurate, succinct explanation."
    }
  ],
  "quiz": [
    {
      "question": "Multiple choice test question 1?",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "A. ...",
      "explanation": "Why this answer is correct and why other options are incorrect."
    },
    {
      "question": "Multiple choice test question 2?",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "B. ...",
      "explanation": "Why this answer is correct."
    },
    {
      "question": "Multiple choice test question 3?",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "C. ...",
      "explanation": "Why this answer is correct."
    },
    {
      "question": "Multiple choice test question 4?",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "D. ...",
      "explanation": "Why this answer is correct."
    },
    {
      "question": "Multiple choice test question 5?",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "A. ...",
      "explanation": "Why this answer is correct."
    }
  ]
}

Study Material:
${contextSnippet}
`;

  try {
    const rawAiResponse = await generateAiText(
      prompt,
      "You are an expert AI academic tutor. Always return valid, well-structured JSON study packages."
    );

    const parsed = extractJson(rawAiResponse);
    if (parsed && (parsed.summary || parsed.title || parsed.keyPoints)) {
      return sanitizeNotes(parsed, textContent);
    }
    console.warn("JSON extraction returned incomplete structure, using sanitized fallback.");
    return sanitizeNotes(null, textContent);
  } catch (error) {
    console.error("Study notes generation error:", error.message);
    return createStructuredFallbackNotes(textContent, error.message);
  }
}

// ----------------------------------------------------
// AUTH ROUTES
// ----------------------------------------------------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const existing = db.findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: "An account with this email already exists. Please sign in." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const newUser = db.createUser({
      id: userId,
      name: name.trim(),
      email: email.trim(),
      passwordHash,
    });

    const token = jwt.sign({ id: newUser.id, name: newUser.name, email: newUser.email }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.status(201).json({
      message: "Account created successfully!",
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Failed to register account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = db.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      message: "Logged in successfully!",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Failed to log in." });
  }
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  const user = db.findUserById(req.user.id);
  if (!user) {
    return res.json({ user: null });
  }
  const sessions = db.getSessionsByUserId(user.id);
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      totalSessions: sessions.length,
      createdAt: user.createdAt,
    },
  });
});

// ----------------------------------------------------
// STUDY SESSIONS / HISTORY ROUTES
// ----------------------------------------------------
app.get("/api/history", authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : "guest";
    const sessions = db.getSessionsByUserId(userId);
    res.json({ sessions });
  } catch (error) {
    console.error("Fetch history error:", error);
    res.status(500).json({ error: "Failed to fetch study history." });
  }
});

app.post("/api/history", authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : (req.body.userId || "guest");
    const { title, filename, fileType, notes, transcript, quizScore } = req.body;

    if (!notes) {
      return res.status(400).json({ error: "Notes data is required." });
    }

    const newSession = db.createSession({
      id: uuidv4(),
      userId,
      title: title || notes.title || "Untitled Lecture",
      filename: filename || "uploaded_file",
      fileType: fileType || "doc",
      notes,
      transcript: transcript || "",
      quizScore: quizScore || null,
    });

    res.status(201).json({ session: newSession });
  } catch (error) {
    console.error("Save history error:", error);
    res.status(500).json({ error: "Failed to save study session." });
  }
});

app.get("/api/history/:id", authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const session = db.getSessionById(req.params.id, userId);
    if (!session) {
      return res.status(404).json({ error: "Study session not found." });
    }
    res.json({ session });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Failed to retrieve session." });
  }
});

app.delete("/api/history/:id", authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const deleted = db.deleteSession(req.params.id, userId);
    if (!deleted) {
      return res.status(404).json({ error: "Study session not found or already deleted." });
    }
    res.json({ message: "Study session deleted successfully." });
  } catch (error) {
    console.error("Delete session error:", error);
    res.status(500).json({ error: "Failed to delete session." });
  }
});

app.patch("/api/history/:id/quiz-score", authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { quizScore } = req.body;
    const updated = db.updateSession(req.params.id, userId, { quizScore });
    if (!updated) {
      return res.status(404).json({ error: "Study session not found." });
    }
    res.json({ session: updated });
  } catch (error) {
    console.error("Update quiz score error:", error);
    res.status(500).json({ error: "Failed to update quiz score." });
  }
});

// ----------------------------------------------------
// FILE PROCESSING ROUTE (Supports up to 50MB, PDF, DOCX, TXT, MD, Audio/Video)
// ----------------------------------------------------
app.post("/api/process-file", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let extractedText = "";
    let detectedType = "text";

    console.log(`Processing file: ${originalname}, size: ${(buffer.length / (1024 * 1024)).toFixed(2)} MB, type: ${mimetype}`);

    if (ext === ".pdf" || mimetype === "application/pdf") {
      detectedType = "pdf";
      extractedText = await extractPdfText(buffer);
    } else if (ext === ".docx" || ext === ".doc" || mimetype.includes("wordprocessingml") || mimetype.includes("msword")) {
      detectedType = "docx";
      extractedText = await extractDocxText(buffer);
    } else if (
      ext === ".txt" ||
      ext === ".md" ||
      ext === ".csv" ||
      ext === ".json" ||
      mimetype.startsWith("text/")
    ) {
      detectedType = "text";
      extractedText = buffer.toString("utf-8");
    } else if (
      mimetype.startsWith("audio/") ||
      mimetype.startsWith("video/") ||
      [".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm", ".mkv", ".ogg", ".aac"].includes(ext)
    ) {
      detectedType = "audio-video";
      extractedText = await transcribeMediaFile(buffer, originalname);
    } else {
      // Fallback attempt: try reading as text
      try {
        extractedText = buffer.toString("utf-8");
      } catch (e) {
        return res.status(400).json({
          error: `Unsupported file format (${ext || mimetype}). Please upload a PDF, Word (.docx), TXT, Markdown, or Audio/Video recording.`,
        });
      }
    }

    const cleanTranscript = safeString(extractedText).trim();
    if (!cleanTranscript || cleanTranscript.length < 15) {
      return res.status(400).json({
        error: "Could not extract readable text from this file. Please make sure the file contains text or clear audio.",
      });
    }

    // Generate Comprehensive Study Notes
    const notes = await generateStudyNotes(cleanTranscript);

    // Auto-save to history if user is authenticated or guest
    const userId = req.user ? req.user.id : "guest";
    const savedSession = db.createSession({
      id: uuidv4(),
      userId,
      title: notes.title || originalname.replace(/\.[^/.]+$/, ""),
      filename: originalname,
      fileType: detectedType,
      notes,
      transcript: cleanTranscript,
    });

    res.json({
      sessionId: savedSession.id,
      transcript: cleanTranscript,
      notes,
    });
  } catch (error) {
    console.error("Process file error:", error);
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File size exceeds the 50 MB upload limit. Please choose a file under 50 MB.",
      });
    }
    res.status(500).json({
      error: error.message || "Failed to process the uploaded file.",
    });
  }
});

// ----------------------------------------------------
// MULTI-LANGUAGE TRANSLATION ROUTE
// ----------------------------------------------------
app.post("/api/translate", async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !language) {
      return res.status(400).json({ error: "Text and target language are required." });
    }

    const prompt = `Translate the following academic study notes into ${language}.
Provide a clear, natural, and highly readable translation for a student.
Preserve bullet points, headers, terms, and explanations.

Do not output any introductory or meta reasoning text. Output ONLY the translated notes.

Notes:
${safeString(text).slice(0, 15000)}
`;

    const translated = await generateAiText(
      prompt,
      `You are an expert multilingual academic translator. Output pure translations in ${language}.`
    );

    res.json({ translatedText: cleanAiText(translated) });
  } catch (error) {
    console.error("Translation error:", error);
    res.status(500).json({ error: error.message || "Translation failed." });
  }
});

// ----------------------------------------------------
// AI TUTOR CHAT ROUTE
// ----------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, transcript, notes, chatHistory } = req.body;
    if (!message || !safeString(message).trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    const notesSummary = notes ? safeString(notes.summary) : "";
    const notesTitle = notes ? safeString(notes.title) : "";
    const contextText = typeof transcript === "string" ? transcript.slice(0, 25000) : safeString(transcript).slice(0, 25000);

    const systemPrompt = `You are StudyMate AI Assistant, a friendly, brilliant personal AI tutor helping a student master their lecture notes.
Document Title: ${notesTitle || "Uploaded Study Material"}
Summary: ${notesSummary}
Full Content:
${contextText}

Guidelines:
- Explain concepts clearly with simple analogies and step-by-step breakdowns.
- If asked for flashcards or quiz questions, provide complete items with questions, options, and answers.
- Format responses beautifully with Markdown: bold terms (**term**), clean bullet points, tables (| Col 1 | Col 2 |), and code blocks where relevant.
- Be encouraging, concise, and structured.`;

    let conversationText = `User asked: ${safeString(message)}\n\n`;
    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
      const past = chatHistory
        .slice(-6)
        .map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${safeString(m.content)}`)
        .join("\n");
      conversationText = `Previous conversation:\n${past}\n\nStudent's latest question: ${safeString(message)}`;
    }

    const aiReply = await generateAiText(conversationText, systemPrompt, 0.3);
    const cleanReply = cleanAiText(aiReply) || "Here is your response based on the study materials.";

    res.json({ reply: cleanReply });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Failed to generate chatbot response. Please try again." });
  }
});

// Root & Health
app.get("/", (req, res) => {
  res.json({
    name: "StudyMate AI API",
    status: "online",
    version: "2.0.0",
    maxUploadMB: 50,
    supportedFormats: ["pdf", "docx", "txt", "md", "mp3", "wav", "m4a", "mp4", "webm"],
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.code === "LIMIT_FILE_SIZE")) {
    return res.status(400).json({
      error: "File size exceeds the 50 MB upload limit. Please select a smaller file under 50 MB.",
    });
  }
  if (err) {
    return res.status(500).json({
      error: safeString(err.message || err) || "An unexpected server error occurred.",
    });
  }
  next();
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`StudyMate AI backend running on http://localhost:${PORT}`);
});

server.on("error", (error) => {
  console.error("Server error:", error);
});

export default app;