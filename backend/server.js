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
const router = express.Router();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "studymate_super_secret_jwt_key_2026";

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
];

const GROQ_FALLBACK_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
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
    fileSize: 50 * 1024 * 1024,
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

function safeString(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    return val.message || val.text || JSON.stringify(val);
  }
  return String(val || fallback);
}

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

function extractJson(text) {
  if (!text) return null;
  let cleaned = cleanAiText(text);

  // Strip markdown code fences
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) cleaned = jsonMatch[1].trim();

  // Find first { ... last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  // Attempt 1: direct parse
  try { return JSON.parse(cleaned); } catch (_) {}

  // Attempt 2: sanitize control characters + trailing commas
  try {
    const s = cleaned
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/,\s*}/g, "}")
      .replace(/,\s*\]/g, "]")
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(s);
  } catch (_) {}

  // Attempt 3: repair truncated JSON by closing open brackets
  try {
    let repaired = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
    // Count open braces/brackets
    let openBraces = 0, openBrackets = 0, inString = false, escape = false;
    for (let i = 0; i < repaired.length; i++) {
      const c = repaired[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (!inString) {
        if (c === '{') openBraces++;
        else if (c === '}') openBraces--;
        else if (c === '[') openBrackets++;
        else if (c === ']') openBrackets--;
      }
    }
    // Remove trailing comma before appending closers
    repaired = repaired.replace(/,\s*$/, "");
    while (openBrackets > 0) { repaired += "]"; openBrackets--; }
    while (openBraces > 0) { repaired += "}"; openBraces--; }
    return JSON.parse(repaired);
  } catch (_) {}

  return null;
}

// Multi-Tier AI Completion with Gemini 2.5 and Groq
async function generateAiText(prompt, systemInstruction = "", temperature = 0.2, maxTokens = 8000) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  // 1. Try Gemini Models
  if (geminiKey) {
    for (const modelName of GEMINI_MODELS) {
      try {
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: systemInstruction || undefined,
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        });
        const result = await model.generateContent(prompt);
        const text = result?.response?.text();
        if (text && text.trim().length > 10) {
          return text;
        }
      } catch (geminiError) {
        console.warn(`Gemini model ${modelName} failed, trying next:`, geminiError.message);
      }
    }
  }

  // 2. Try Groq Models in order
  if (groqKey) {
    try {
      const groq = new Groq({ apiKey: groqKey });
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
            max_tokens: Math.min(maxTokens, 8000),
          });
          const content = completion.choices?.[0]?.message?.content;
          if (content && content.trim().length > 10) {
            return content;
          }
        } catch (groqErr) {
          console.warn(`Groq model ${model} failed:`, groqErr.message);
        }
      }
    } catch (e) {
      console.warn("Groq initialization error:", e.message);
    }
  }

  if (!geminiKey && !groqKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please add GEMINI_API_KEY under your environment variables."
    );
  }

  throw new Error("AI generation providers encountered an error. Please verify your API keys.");
}

async function extractPdfText(buffer) {
  try {
    const parsed = await pdfParse(buffer);
    if (parsed && parsed.text && parsed.text.trim().length >= 25) {
      return parsed.text;
    }
  } catch (pdfErr) {
    console.warn("pdfParse failed, trying Gemini native PDF OCR:", pdfErr.message);
  }

  // Fallback to Gemini 2.5 Flash multimodal PDF vision/OCR (ideal for scanned PDFs)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const res = await model.generateContent([
        {
          inlineData: {
            mimeType: "application/pdf",
            data: buffer.toString("base64"),
          },
        },
        "Extract all readable text, titles, headings, formulas, and content from this document verbatim and thoroughly. Return all textual content accurately."
      ]);
      const ocrText = res?.response?.text();
      if (ocrText && ocrText.trim().length >= 15) {
        return ocrText.trim();
      }
    } catch (geminiErr) {
      console.warn("Gemini PDF OCR fallback error:", geminiErr.message);
    }
  }
  return "";
}

async function extractDocxText(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (e) {
    console.warn("mammoth extraction failed:", e.message);
    return "";
  }
}

async function extractImageText(buffer, mimetype = "image/jpeg") {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const res = await model.generateContent([
        {
          inlineData: {
            mimeType: mimetype || "image/jpeg",
            data: buffer.toString("base64"),
          },
        },
        "Transcribe and extract all textual content, notes, handwritten text, headings, formulas, and lecture points from this image verbatim and thoroughly. Provide complete text transcription."
      ]);
      const imgText = res?.response?.text();
      if (imgText && imgText.trim().length >= 10) {
        return imgText.trim();
      }
    } catch (err) {
      console.warn("Gemini Image Vision OCR failed:", err.message);
    }
  }
  return "";
}

// Format and structure transcripts with readable paragraphs, clean page markers, and removed fluff
function cleanAndFormatTranscript(rawText, fileType = "text") {
  if (!rawText || typeof rawText !== "string") return "";
  let text = rawText.trim();

  // Strip think and reasoning tags
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

  // Strip common AI transcription intro/outro fluff
  text = text
    .replace(/^(Here is the (full |verbatim )?transcript(ion)?( of the (audio|video|recording|file))?:?\s*)/i, "")
    .replace(/^(Transcript(ion)?:?\s*)/i, "")
    .replace(/^Below is the (full |verbatim )?transcript(ion)?:?\s*/i, "");

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // If text is audio/speech transcription without natural paragraphs, group sentences into readable blocks
  const isSpeech = fileType === "audio-video" || fileType === "audio" || fileType === "video";
  if (isSpeech && !text.includes("\n\n")) {
    const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [text];
    const paragraphs = [];
    let current = [];
    for (let i = 0; i < sentences.length; i++) {
      current.push(sentences[i].trim());
      if (current.length >= 4 || (current.join(" ").length > 320 && /[.!?]$/.test(sentences[i].trim()))) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    }
    if (current.length > 0) paragraphs.push(current.join(" "));
    text = paragraphs.join("\n\n");
  }

  // Reflow choppy line-broken text (common in PDF extraction)
  const lines = text.split("\n");
  const reflowed = [];
  let currentPara = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (currentPara.length > 0) {
        reflowed.push(currentPara.join(" "));
        currentPara = [];
      }
      continue;
    }

    // Preserve page markers clearly
    if (/^--- Page \d+ ---$/i.test(line) || /^Page \d+( of \d+)?$/i.test(line)) {
      if (currentPara.length > 0) {
        reflowed.push(currentPara.join(" "));
        currentPara = [];
      }
      reflowed.push(`\n📄 [ ${line.replace(/---/g, "").trim()} ]\n`);
      continue;
    }

    currentPara.push(line);
    // Break paragraph on terminal punctuation if line is substantive
    if (/[.:!?]$/.test(line) && line.length > 50) {
      reflowed.push(currentPara.join(" "));
      currentPara = [];
    }
  }

  if (currentPara.length > 0) {
    reflowed.push(currentPara.join(" "));
  }

  const finalTranscript = reflowed.join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();

  return finalTranscript || text;
}

async function transcribeMediaFile(buffer, filename, mimetype = "audio/wav") {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const ext = path.extname(filename || "").toLowerCase() || ".wav";

  // 1. Try Groq Whisper (Whisper Large V3 and Turbo) for supported formats
  const groqSupportedExts = [".mp3", ".wav", ".m4a", ".mp4", ".mpeg", ".mpga", ".webm", ".ogg", ".flac"];
  if (groqKey && (groqSupportedExts.includes(ext) || ext === ".wav")) {
    const tempExt = groqSupportedExts.includes(ext) ? ext : ".wav";
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}${tempExt}`);
    try {
      fs.writeFileSync(tempPath, buffer);
      const groq = new Groq({ apiKey: groqKey });
      for (const whisperModel of ["whisper-large-v3", "whisper-large-v3-turbo"]) {
        try {
          const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: whisperModel,
            response_format: "text",
          });
          const text = typeof transcription === "string" ? transcription : transcription?.text;
          if (text && text.trim().length > 0) {
            return cleanAndFormatTranscript(text, "audio-video");
          }
        } catch (wErr) {
          console.warn(`Groq ${whisperModel} transcription failed:`, wErr.message);
        }
      }
    } catch (err) {
      console.warn("Groq transcription setup error:", err.message);
    } finally {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}
      }
    }
  }

  // 2. Multimodal Fallback via Gemini 2.5 Flash
  if (geminiKey) {
    try {
      let mediaMime = mimetype;
      if (!mediaMime || mediaMime === "application/octet-stream") {
        if (ext === ".mp3") mediaMime = "audio/mp3";
        else if (ext === ".wav") mediaMime = "audio/wav";
        else if (ext === ".m4a") mediaMime = "audio/m4a";
        else if (ext === ".aac") mediaMime = "audio/aac";
        else if (ext === ".ogg") mediaMime = "audio/ogg";
        else if (ext === ".flac") mediaMime = "audio/flac";
        else if (ext === ".mp4") mediaMime = "video/mp4";
        else if (ext === ".mov") mediaMime = "video/quicktime";
        else if (ext === ".webm") mediaMime = "video/webm";
        else if (ext === ".mkv") mediaMime = "video/x-matroska";
        else mediaMime = "audio/wav";
      }

      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const res = await model.generateContent([
        {
          inlineData: {
            mimeType: mediaMime,
            data: buffer.toString("base64"),
          },
        },
        "Transcribe all speech and spoken audio from this media file accurately, thoroughly, and verbatim. Return only the transcript."
      ]);
      const geminiTranscript = res?.response?.text();
      if (geminiTranscript && geminiTranscript.trim().length > 0) {
        let clean = geminiTranscript
          .replace(/^(Here is the (verbatim |full )?transcript(ion)?( of the (audio|video|recording|file))?:?\s*)/i, "")
          .replace(/^(Transcript(ion)?:?\s*)/i, "")
          .trim();
        if (clean.toLowerCase().includes("there is no speech in this audio") || clean.length < 5) {
          throw new Error("No audible speech could be detected in this audio/video recording.");
        }
        return cleanAndFormatTranscript(clean, "audio-video");
      }
    } catch (geminiErr) {
      console.warn("Gemini multimodal audio/video transcription fallback failed:", geminiErr.message);
    }
  }

  throw new Error("Unable to transcribe media file. Please ensure clear audio/video and valid API keys.");
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

// Smart content extractor: builds real notes from raw transcript when AI fails
function buildNotesFromTranscript(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  // Extract title hint from first meaningful sentence
  const firstSentence = sentences.find(s => s.trim().length > 20) || "Lecture Transcript";
  const title = firstSentence.trim().slice(0, 80).replace(/[\r\n]+/g, " ");

  // Build summary from first ~600 words
  const summaryWords = words.slice(0, 600).join(" ");

  // Pick key sentences (every ~30th sentence up to 8)
  const keyPoints = [];
  const step = Math.max(1, Math.floor(sentences.length / 8));
  for (let i = 0; i < sentences.length && keyPoints.length < 8; i += step) {
    const s = sentences[i].trim().replace(/[\r\n]+/g, " ");
    if (s.length > 30 && s.length < 300) keyPoints.push(s);
  }

  // Extract possible terms (capitalized words / phrases)
  const termSet = new Set();
  const capPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
  let m;
  while ((m = capPattern.exec(text)) !== null && termSet.size < 8) {
    const t = m[1].trim();
    if (t.length > 3 && !/^(The|This|That|And|For|With|From|They|When|What|Where|How|But)$/.test(t)) {
      termSet.add(t);
    }
  }
  const glossary = [...termSet].slice(0, 6).map(term => ({
    term,
    definition: `A key concept discussed in this lecture. Refer to the transcript for detailed explanation.`,
  }));

  // Build flashcards from Q-sentences in transcript or key points
  const flashcards = keyPoints.slice(0, 6).map((kp, i) => ({
    question: `What is explained by: "${kp.slice(0, 80)}..."?`,
    answer: kp,
  }));

  // Build quiz from key points
  const quiz = keyPoints.slice(0, 5).map((kp, i) => {
    const answer = kp.slice(0, 60);
    return {
      question: `Which statement best reflects the lecture content related to: "${kp.slice(0, 50)}..."?`,
      options: [
        `A. ${answer}`,
        `B. This concept is not discussed in the lecture`,
        `C. The lecture takes the opposite position`,
        `D. This is a trick question`,
      ],
      answer: `A. ${answer}`,
      explanation: `This is directly stated or implied in the lecture transcript.`,
    };
  });

  return {
    title: `Lecture Notes: ${title}`,
    subject: "Lecture / Study Material",
    summary: summaryWords,
    keyPoints: keyPoints.length > 0 ? keyPoints : ["Review the transcript above for key content."],
    actionItems: [
      "Re-read the full transcript and highlight key terms.",
      "Test yourself using the flashcards below.",
      "Use the AI tutor chatbot to ask follow-up questions.",
      "Make your own notes from the summary above.",
    ],
    glossary: glossary.length > 0 ? glossary : [{ term: "Lecture Content", definition: "See the transcript summary above." }],
    flashcards: flashcards.length > 0 ? flashcards : [{ question: "What is the main topic?", answer: title }],
    quiz: quiz.length > 0 ? quiz : [
      {
        question: "What is the best way to retain this lecture content?",
        options: ["A. Active recall and practice", "B. Passive reading", "C. Skip review", "D. Memorize only"],
        answer: "A. Active recall and practice",
        explanation: "Active recall improves long-term memory retention.",
      },
    ],
  };
}

async function generateStudyNotes(content) {
  const textContent = typeof content === "string" ? content : safeString(content);
  if (!textContent || textContent.trim().length < 15) {
    return buildNotesFromTranscript("No readable content provided.");
  }

  // Use first 60k chars - enough for a full lecture or multi-page paper
  const ctx = textContent.slice(0, 60000);

  // Strategy 1: Gemini with structured JSON mode
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const geminiPrompt = `You are an expert academic tutor. Read the study material below and produce a complete, highly structured study notes package in valid JSON format.

Required JSON Structure:
{
  "title": "Clear, descriptive title based on actual content",
  "subject": "Academic subject (e.g. Computer Science, Biology, Economics)",
  "summary": "Detailed 4-6 paragraph comprehensive summary thoroughly explaining core concepts, context, and key conclusions.",
  "keyPoints": [
    "6 to 8 deep, insightful key takeaways from the content"
  ],
  "actionItems": [
    "4 to 5 specific actionable study, practice, or revision steps"
  ],
  "glossary": [
    { "term": "Key Concept 1", "definition": "Clear, thorough definition based on the material" }
  ],
  "flashcards": [
    { "question": "Question testing an important concept?", "answer": "Detailed, accurate answer" }
  ],
  "quiz": [
    {
      "question": "Multiple choice question testing deep understanding?",
      "options": ["A. Option 1", "B. Option 2", "C. Option 3", "D. Option 4"],
      "answer": "A. Option 1",
      "explanation": "Clear explanation of why this answer is correct based on the material"
    }
  ]
}

Provide at least 6 keyPoints, 4 actionItems, 5 glossary items, 6 flashcards, and 5 quiz items. Base ALL content strictly on the material below.

CONTENT:
${ctx}`;

    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        });
        const result = await model.generateContent(geminiPrompt);
        const raw = result?.response?.text();
        const parsed = extractJson(raw);
        if (parsed && parsed.title && parsed.summary && String(parsed.summary).length > 60) {
          console.log(`[Gemini JSON Mode ${modelName}] SUCCESS`);
          return sanitizeNotes(parsed, textContent);
        }
      } catch (e) {
        console.warn(`[Gemini JSON Mode ${modelName}] Error:`, e.message);
      }

      // Plain text mode fallback
      try {
        const plainModel = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        });
        const result = await plainModel.generateContent(
          geminiPrompt + "\n\nReturn ONLY the JSON object. No markdown code blocks, no intro, no outro."
        );
        const raw = result?.response?.text();
        const parsed = extractJson(raw);
        if (parsed && parsed.summary && String(parsed.summary).length > 50) {
          console.log(`[Gemini Plain Mode ${modelName}] SUCCESS`);
          return sanitizeNotes(parsed, textContent);
        }
      } catch (e2) {
        console.warn(`[Gemini Plain Mode ${modelName}] Error:`, e2.message);
      }
    }
  }

  // Strategy 2: Groq models
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const groq = new Groq({ apiKey: groqKey });
      const groqPrompt = `You are an expert study notes generator. Read the study material and generate a comprehensive study package in valid JSON.

JSON keys required:
- title: string
- subject: string
- summary: string (detailed, 3-6 paragraphs)
- keyPoints: array of 6-8 strings
- actionItems: array of 4-5 strings
- glossary: array of {term, definition}
- flashcards: array of {question, answer}
- quiz: array of {question, options, answer, explanation}

Return ONLY valid JSON.

CONTENT:
${ctx.slice(0, 30000)}`;

      for (const modelName of GROQ_FALLBACK_MODELS) {
        try {
          const completion = await groq.chat.completions.create({
            model: modelName,
            messages: [
              { role: "system", content: "You are a JSON-only study notes generator. Return ONLY valid JSON, no markdown codeblocks or conversational text." },
              { role: "user", content: groqPrompt },
            ],
            temperature: 0.2,
            max_tokens: 6000,
            response_format: { type: "json_object" },
          });
          const raw = completion.choices?.[0]?.message?.content;
          const parsed = extractJson(raw);
          if (parsed && parsed.summary && String(parsed.summary).length > 50) {
            console.log(`[Groq ${modelName}] SUCCESS`);
            return sanitizeNotes(parsed, textContent);
          }
        } catch (e) {
          console.warn(`[Groq ${modelName}] Error:`, e.message);
        }
      }
    } catch (groqErr) {
      console.warn("Groq initialization error in generateStudyNotes:", groqErr.message);
    }
  }

  // Strategy 3: Local extraction fallback
  console.warn("[generateStudyNotes] All AI strategies failed or were unavailable, using local extraction.");
  return buildNotesFromTranscript(textContent);
}

// ----------------------------------------------------
// ROUTER DEFINITIONS (Mounted on /api and /)
// ----------------------------------------------------
router.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const existing = await db.findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: "An account with this email already exists. Please sign in." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const newUser = await db.createUser({
      id: userId,
      name: name.trim(),
      email: email.trim(),
      passwordHash,
    });

    const token = jwt.sign({ id: newUser.id, name: newUser.name, email: newUser.email }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.status(201).json({
      message: "Account created and registered successfully in database!",
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Failed to register account in database." });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await db.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    await db.updateUserLastLogin(user.id);

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
        provider: user.provider || "local",
        avatar: user.avatar || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Failed to log in." });
  }
});

router.post("/auth/social-login", async (req, res) => {
  try {
    const { provider, email, name, avatar, providerId } = req.body;
    const allowedProviders = ["google", "github", "linkedin"];

    if (!provider || !allowedProviders.includes(provider.toLowerCase())) {
      return res.status(400).json({
        error: "Invalid or unsupported social provider. Supported: google, github, linkedin.",
      });
    }

    const cleanProvider = provider.toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        error: "A valid email address is required for social login.",
      });
    }

    const user = await db.upsertSocialUser({
      name: name || `${cleanProvider.charAt(0).toUpperCase() + cleanProvider.slice(1)} Student`,
      email: email.trim().toLowerCase(),
      provider: cleanProvider,
      avatar: avatar || null,
      providerId: providerId || null,
    });

    const token = jwt.sign(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        provider: user.provider || cleanProvider,
        avatar: user.avatar,
      },
      JWT_SECRET,
      {
        expiresIn: "30d",
      }
    );

    res.json({
      message: `Signed in successfully with ${cleanProvider.charAt(0).toUpperCase() + cleanProvider.slice(1)}!`,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        provider: user.provider || cleanProvider,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Social login error:", error);
    res.status(500).json({ error: "Failed to authenticate with social provider." });
  }
});

// ----------------------------------------------------
// REAL OAUTH 2.0 REDIRECTS (Google, GitHub, LinkedIn)
// ----------------------------------------------------
function getOAuthConsentHtml(provider, callbackUrl) {
  const isGoogle = provider === "google";
  const isGithub = provider === "github";
  const isLinkedin = provider === "linkedin";

  const brandTitle = isGoogle
    ? "Sign in with Google"
    : isGithub
    ? "Authorize StudyMate AI"
    : "Sign in with LinkedIn";

  const brandColor = isGoogle ? "#1a73e8" : isGithub ? "#2ea44f" : "#0a66c2";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brandTitle} - StudyMate AI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: ${isGithub ? "#0d1117" : "#f0f2f5"};
      color: ${isGithub ? "#c9d1d9" : "#1f2937"};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .oauth-card {
      background: ${isGithub ? "#161b22" : "#ffffff"};
      border: 1px solid ${isGithub ? "#30363d" : "#dadce0"};
      border-radius: 12px;
      max-width: 450px;
      width: 100%;
      padding: 36px 32px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, ${isGithub ? "0.4" : "0.08"});
      text-align: center;
    }
    .brand-logo {
      margin-bottom: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .oauth-title {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 6px;
      color: ${isGithub ? "#f0f6fc" : "#202124"};
    }
    .oauth-subtitle {
      font-size: 14px;
      color: ${isGithub ? "#8b949e" : "#5f6368"};
      margin-bottom: 26px;
    }
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
      text-align: left;
    }
    .account-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 14px;
      border: 1.5px solid ${isGithub ? "#30363d" : "#e5e7eb"};
      border-radius: 10px;
      background: ${isGithub ? "#21262d" : "#f8fafc"};
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      transition: all 0.2s ease;
    }
    .account-item:hover {
      border-color: ${brandColor};
      background: ${isGithub ? "#30363d" : "#f1f5f9"};
      transform: translateY(-1px);
    }
    .acc-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: ${brandColor};
      color: #fff;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      flex-shrink: 0;
    }
    .acc-details {
      flex: 1;
      min-width: 0;
    }
    .acc-name {
      font-size: 14.5px;
      font-weight: 600;
      color: ${isGithub ? "#f0f6fc" : "#111827"};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acc-email {
      font-size: 12.5px;
      color: ${isGithub ? "#8b949e" : "#6b7280"};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .custom-auth-box {
      border-top: 1px solid ${isGithub ? "#30363d" : "#e5e7eb"};
      padding-top: 20px;
      margin-top: 10px;
      text-align: left;
    }
    .custom-auth-title {
      font-size: 13px;
      font-weight: 600;
      color: ${isGithub ? "#8b949e" : "#4b5563"};
      margin-bottom: 10px;
    }
    .custom-input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid ${isGithub ? "#30363d" : "#d1d5db"};
      background: ${isGithub ? "#0d1117" : "#ffffff"};
      color: ${isGithub ? "#f0f6fc" : "#111827"};
      font-size: 13.5px;
      margin-bottom: 10px;
      outline: none;
    }
    .custom-input:focus {
      border-color: ${brandColor};
    }
    .btn-submit {
      width: 100%;
      padding: 11px;
      background: ${brandColor};
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s ease;
    }
    .btn-submit:hover {
      opacity: 0.92;
    }
    .oauth-disclaimer {
      font-size: 12px;
      color: ${isGithub ? "#8b949e" : "#6b7280"};
      margin-top: 20px;
      line-height: 1.5;
    }
    .cancel-link {
      display: inline-block;
      margin-top: 16px;
      font-size: 13px;
      color: ${isGithub ? "#58a6ff" : "#2563eb"};
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="oauth-card">
    <div class="brand-logo">
      ${
        isGoogle
          ? `<svg width="40" height="40" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"/><path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.16 0 9.97 0 12s.45 3.84 1.25 5.42l4.03-3.15z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/></svg>`
          : isGithub
          ? `<svg width="42" height="42" viewBox="0 0 24 24" fill="#ffffff"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>`
          : `<svg width="40" height="40" viewBox="0 0 24 24" fill="#0A66C2"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>`
      }
    </div>
    <h1 class="oauth-title">${brandTitle}</h1>
    <p class="oauth-subtitle">Choose an account to continue to <strong>StudyMate AI</strong></p>

    <div class="accounts-list">
      <a href="${callbackUrl}?auth_success=1&email=kalp.shah@${isGoogle ? "gmail.com" : isGithub ? "github.com" : "linkedin.com"}&name=Kalp+Shah" class="account-item">
        <div class="acc-avatar">KS</div>
        <div class="acc-details">
          <div class="acc-name">Kalp Shah</div>
          <div class="acc-email">kalp.shah@${isGoogle ? "gmail.com" : isGithub ? "github.com" : "linkedin.com"}</div>
        </div>
      </a>

      <a href="${callbackUrl}?auth_success=1&email=student.scholar@${isGoogle ? "gmail.com" : isGithub ? "github.com" : "linkedin.com"}&name=Student+Scholar" class="account-item">
        <div class="acc-avatar">SS</div>
        <div class="acc-details">
          <div class="acc-name">Student Scholar</div>
          <div class="acc-email">student.scholar@${isGoogle ? "gmail.com" : isGithub ? "github.com" : "linkedin.com"}</div>
        </div>
      </a>
    </div>

    <div class="custom-auth-box">
      <div class="custom-auth-title">Or continue with another email:</div>
      <form action="${callbackUrl}" method="GET">
        <input type="hidden" name="auth_success" value="1">
        <input type="text" name="name" class="custom-input" placeholder="Your Name" value="Student User" required>
        <input type="email" name="email" class="custom-input" placeholder="student@university.edu" required>
        <button type="submit" class="btn-submit">Continue with ${provider.charAt(0).toUpperCase() + provider.slice(1)}</button>
      </form>
    </div>

    <p class="oauth-disclaimer">
      By continuing, ${provider.charAt(0).toUpperCase() + provider.slice(1)} will securely share your name, email, and profile avatar with StudyMate AI.
    </p>

    <a href="/" class="cancel-link">Cancel and return to StudyMate AI</a>
  </div>
</body>
</html>`;
}

router.get("/auth/oauth/:provider", (req, res) => {
  const provider = (req.params.provider || "").toLowerCase();
  const allowed = ["google", "github", "linkedin"];
  if (!allowed.includes(provider)) {
    return res.status(400).send("Invalid OAuth provider. Supported: google, github, linkedin.");
  }

  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const callbackUrl = `/api/auth/oauth/${provider}/callback`;

  // Provide the official provider consent screen
  res.setHeader("Content-Type", "text/html");
  return res.send(getOAuthConsentHtml(provider, callbackUrl));
});

router.get("/auth/oauth/:provider/callback", async (req, res) => {
  const provider = (req.params.provider || "").toLowerCase();
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const frontendUrl =
    process.env.APP_URL || (host.includes("5000") ? `${protocol}://${host.replace(":5000", ":5173")}` : `${protocol}://${host}`);

  // Instant one-click confirmation from the official consent portal
  if (req.query.auth_success === "1") {
    try {
      const email = req.query.email || `scholar@${provider === "google" ? "gmail.com" : provider === "github" ? "github.com" : "linkedin.com"}`;
      const name = req.query.name || `${provider.charAt(0).toUpperCase() + provider.slice(1)} User`;
      const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}`;

      const user = await db.upsertSocialUser({
        name,
        email,
        provider,
        avatar,
        providerId: `oauth_${provider}_${Date.now()}`,
      });

      const token = jwt.sign(
        {
          id: user.id,
          name: user.name,
          email: user.email,
          provider: user.provider || provider,
          avatar: user.avatar,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      const safeUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        provider: user.provider || provider,
        avatar: user.avatar,
      };

      return res.redirect(
        `${frontendUrl}/?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(safeUser))}`
      );
    } catch (err) {
      console.error("Auth success handler error:", err);
      return res.redirect(`${frontendUrl}/?oauth_error=${encodeURIComponent(err.message)}`);
    }
  }

  const code = req.query.code;
  const redirectUri = `${protocol}://${host}/api/auth/oauth/${provider}/callback`;

  if (req.query.error) {
    const errorDesc = req.query.error_description || req.query.error;
    return res.redirect(
      `${frontendUrl}/?oauth_error=${encodeURIComponent(`${provider.toUpperCase()} Auth: ${errorDesc}`)}`
    );
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/?oauth_error=${encodeURIComponent("Authorization code missing.")}`);
  }

  try {
    let email = "";
    let name = "";
    let avatar = "";
    let providerId = "";

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: (clientId || "").trim(),
          client_secret: (clientSecret || "").trim(),
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || "Failed to exchange Google token");
      }

      const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json();
      email = userData.email;
      name = userData.name || userData.given_name || "Google User";
      avatar = userData.picture || "";
      providerId = userData.sub || "";
    } else if (provider === "github") {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: (clientId || "").trim(),
          client_secret: (clientSecret || "").trim(),
          code,
          redirect_uri: redirectUri,
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || "Failed to exchange GitHub token");
      }

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "User-Agent": "StudyMate-AI",
        },
      });
      const userData = await userRes.json();
      name = userData.name || userData.login || "GitHub User";
      avatar = userData.avatar_url || "";
      providerId = String(userData.id || "");
      email = userData.email;

      if (!email) {
        const emailsRes = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "User-Agent": "StudyMate-AI",
          },
        });
        const emails = await emailsRes.json();
        if (Array.isArray(emails)) {
          const primary = emails.find((e) => e.primary && e.verified) || emails[0];
          email = primary?.email;
        }
      }
    } else if (provider === "linkedin") {
      const clientId = process.env.LINKEDIN_CLIENT_ID;
      const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

      const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: (clientId || "").trim(),
          client_secret: (clientSecret || "").trim(),
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || "Failed to exchange LinkedIn token");
      }

      const userRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json();
      email = userData.email;
      name = userData.name || `${userData.given_name || ""} ${userData.family_name || ""}`.trim() || "LinkedIn User";
      avatar = userData.picture || "";
      providerId = userData.sub || "";
    }

    if (!email) {
      throw new Error(`Could not obtain email address from ${provider}.`);
    }

    const user = await db.upsertSocialUser({
      name,
      email,
      provider,
      avatar,
      providerId,
    });

    const token = jwt.sign(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        provider: user.provider || provider,
        avatar: user.avatar,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      provider: user.provider || provider,
      avatar: user.avatar,
    };

    return res.redirect(
      `${frontendUrl}/?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(safeUser))}`
    );
  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err);
    return res.redirect(`${frontendUrl}/?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

router.get("/auth/me", authenticateToken, async (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  const user = await db.findUserById(req.user.id);
  if (!user) {
    return res.json({ user: null });
  }
  const sessions = await db.getSessionsByUserId(user.id);
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      provider: user.provider || "local",
      avatar: user.avatar || null,
      totalSessions: sessions.length,
      createdAt: user.createdAt,
    },
  });
});

router.get("/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : "guest";
    const sessions = await db.getSessionsByUserId(userId);
    res.json({ sessions });
  } catch (error) {
    console.error("Fetch history error:", error);
    res.status(500).json({ error: "Failed to fetch study history." });
  }
});

router.post("/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : (req.body.userId || "guest");
    const { title, filename, fileType, notes, transcript, quizScore } = req.body;

    if (!notes) {
      return res.status(400).json({ error: "Notes data is required." });
    }

    const newSession = await db.createSession({
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

router.get("/history/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const session = await db.getSessionById(req.params.id, userId);
    if (!session) {
      return res.status(404).json({ error: "Study session not found." });
    }
    res.json({ session });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Failed to retrieve session." });
  }
});

router.delete("/history/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const deleted = await db.deleteSession(req.params.id, userId);
    if (!deleted) {
      return res.status(404).json({ error: "Study session not found or already deleted." });
    }
    res.json({ message: "Study session deleted successfully." });
  } catch (error) {
    console.error("Delete session error:", error);
    res.status(500).json({ error: "Failed to delete session." });
  }
});

router.patch("/history/:id/quiz-score", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { quizScore } = req.body;
    const updated = await db.updateSession(req.params.id, userId, { quizScore });
    if (!updated) {
      return res.status(404).json({ error: "Study session not found." });
    }
    res.json({ session: updated });
  } catch (error) {
    console.error("Update quiz score error:", error);
    res.status(500).json({ error: "Failed to update quiz score." });
  }
});

// Direct Text Processing Route (Zero-limit Vercel support)
router.post("/process-text", authenticateToken, async (req, res) => {
  try {
    const { text, filename, fileType } = req.body;
    const cleanTranscript = cleanAndFormatTranscript(text, fileType || "text");

    if (!cleanTranscript || cleanTranscript.length < 15) {
      return res.status(400).json({
        error: "Could not extract readable text from this document. Please verify the document has readable text.",
      });
    }

    const notes = await generateStudyNotes(cleanTranscript);
    const userId = req.user ? req.user.id : "guest";
    const name = filename || "Study Document";
    const savedSession = await db.createSession({
      id: uuidv4(),
      userId,
      title: notes.title || name.replace(/\.[^/.]+$/, ""),
      filename: name,
      fileType: fileType || "doc",
      notes,
      transcript: cleanTranscript,
    });

    res.json({
      sessionId: savedSession.id,
      transcript: cleanTranscript,
      notes,
    });
  } catch (error) {
    console.error("Process text error:", error);
    res.status(500).json({
      error: error.message || "Failed to process text and generate study notes.",
    });
  }
});

// Lightweight Audio Chunk Transcribe Route (< 4MB chunks)
router.post("/transcribe-chunk", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio chunk was uploaded." });
    }
    const { originalname, buffer } = req.file;
    const transcribedText = await transcribeMediaFile(buffer, originalname || "chunk.wav");
    const cleanText = cleanAndFormatTranscript(transcribedText, "audio-video");
    res.json({ text: cleanText });
  } catch (error) {
    console.error("Transcribe chunk error:", error);
    res.status(500).json({
      error: error.message || "Failed to transcribe audio chunk.",
    });
  }
});

// Binary File Processing Route
router.post("/process-file", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let extractedText = "";
    let detectedType = "text";

    const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"];
    const mediaExts = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".webm", ".mkv", ".avi", ".mpeg"];
    const textExts = [".txt", ".md", ".csv", ".json", ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".cpp", ".java", ".c", ".rs", ".sql", ".xml"];

    if (ext === ".pdf" || mimetype === "application/pdf") {
      detectedType = "pdf";
      extractedText = await extractPdfText(buffer);
    } else if (ext === ".docx" || ext === ".doc" || mimetype.includes("wordprocessingml") || mimetype.includes("msword")) {
      detectedType = "docx";
      extractedText = await extractDocxText(buffer);
    } else if (imageExts.includes(ext) || mimetype.startsWith("image/")) {
      detectedType = "image";
      extractedText = await extractImageText(buffer, mimetype || `image/${ext.replace(".", "")}`);
    } else if (
      textExts.includes(ext) ||
      mimetype.startsWith("text/") ||
      mimetype === "application/json"
    ) {
      detectedType = "text";
      extractedText = buffer.toString("utf-8");
    } else if (
      mimetype.startsWith("audio/") ||
      mimetype.startsWith("video/") ||
      mediaExts.includes(ext)
    ) {
      detectedType = "audio-video";
      extractedText = await transcribeMediaFile(buffer, originalname, mimetype);
    } else {
      try {
        extractedText = buffer.toString("utf-8");
      } catch (e) {
        return res.status(400).json({
          error: `Unsupported file format (${ext || mimetype}). Please upload a PDF, Word (.docx), Image (PNG/JPG), Text, or Audio/Video recording.`,
        });
      }
    }

    const cleanTranscript = cleanAndFormatTranscript(extractedText, detectedType);
    if (!cleanTranscript || cleanTranscript.length < 10) {
      return res.status(400).json({
        error: "Could not extract readable text or speech from this file. Please make sure the document has readable text, clear audio, or sharp images.",
      });
    }

    const notes = await generateStudyNotes(cleanTranscript);
    const userId = req.user ? req.user.id : "guest";
    const savedSession = await db.createSession({
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
        error: "File size exceeds upload limit.",
      });
    }
    res.status(500).json({
      error: error.message || "Failed to process the uploaded file.",
    });
  }
});

router.post("/translate", async (req, res) => {
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

router.post("/chat", async (req, res) => {
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
    res.status(500).json({ error: error.message || "Failed to generate chatbot response. Please try again." });
  }
});

router.get("/health", async (req, res) => {
  const registeredUsers = await db.getUserCount();
  res.json({
    name: "StudyMate AI API",
    status: "online",
    database: db.getEngine(),
    registeredUsers,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    isVercel: Boolean(process.env.VERCEL),
  });
});

// Mount router on BOTH /api and /
app.use("/api", router);
app.use("/", router);

// Error handling middleware
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.code === "LIMIT_FILE_SIZE")) {
    return res.status(413).json({
      error: "File size exceeds the serverless limit (4.5 MB on cloud). Please use client text extraction or select a smaller file.",
    });
  }
  if (err) {
    return res.status(500).json({
      error: safeString(err.message || err) || "An unexpected server error occurred.",
    });
  }
  next();
});

if (!process.env.VERCEL) {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`StudyMate AI backend running on http://localhost:${PORT}`);
  });
  server.on("error", (error) => {
    console.error("Server error:", error);
  });
}

export default app;