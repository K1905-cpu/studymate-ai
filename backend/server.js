import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import Groq from "groq-sdk";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const LIMITS_MB = {
  audioVideo: 4.5,
  pdf: 4.5,
  txt: 2,
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const GROQ_MODELS = [
  "groq/compound-mini",
  "groq/compound",
  "qwen/qwen3.6-27b"
];

async function callGroqCompletion(messages, temperature = 0.1) {
  let lastError = null;
  for (const model of GROQ_MODELS) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages,
        temperature,
      });
      const content = completion.choices?.[0]?.message?.content;
      if (content) return content;
    } catch (err) {
      console.warn(`Model ${model} failed:`, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error("All Groq models failed");
}

app.use(cors());
app.use(express.json({ limit: "4.5mb" }));
app.use(express.urlencoded({ limit: "4.5mb", extended: true }));

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 4.5 * 1024 * 1024,
  },
});

function isPdf(mimetype, filename = "") {
  return mimetype === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

function isText(mimetype, filename = "") {
  return mimetype === "text/plain" || filename.toLowerCase().endsWith(".txt");
}

function isAudioOrVideo(mimetype, filename = "") {
  const name = filename.toLowerCase();

  return (
    mimetype.startsWith("audio/") ||
    mimetype.startsWith("video/") ||
    name.endsWith(".mp3") ||
    name.endsWith(".wav") ||
    name.endsWith(".m4a") ||
    name.endsWith(".mp4") ||
    name.endsWith(".mov") ||
    name.endsWith(".webm") ||
    name.endsWith(".mkv")
  );
}

function checkFileSize(mimetype, filename, fileSizeMB) {
  if (isAudioOrVideo(mimetype, filename) && fileSizeMB > LIMITS_MB.audioVideo) {
    return `Audio/video file is too large (${fileSizeMB.toFixed(1)} MB). Vercel serverless limit is 4.5 MB. Please select a file under 4.5 MB.`;
  }

  if (isPdf(mimetype, filename) && fileSizeMB > LIMITS_MB.pdf) {
    return `PDF file is too large (${fileSizeMB.toFixed(1)} MB). Vercel serverless limit is 4.5 MB. Please select a file under 4.5 MB.`;
  }

  if (isText(mimetype, filename) && fileSizeMB > LIMITS_MB.txt) {
    return `TXT file too large (${fileSizeMB.toFixed(1)} MB). Allowed size: 0 MB to ${LIMITS_MB.txt} MB.`;
  }

  return null;
}

async function extractPdfText(buffer) {
  const parsed = await pdfParse(buffer);
  return parsed.text || "";
}

async function transcribeFile(buffer, filename) {
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${filename}`);
  try {
    fs.writeFileSync(tempPath, buffer);
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-large-v3",
      response_format: "text",
    });
    if (typeof transcription === "string") {
      return transcription;
    }
    if (transcription && typeof transcription.text === "string") {
      return transcription.text;
    }
    return String(transcription?.message || JSON.stringify(transcription) || "");
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

function safeString(val, fallback = "") {
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null) {
    return val.message || val.text || JSON.stringify(val);
  }
  return String(val || fallback);
}

function sanitizeNotes(notes, fallbackContent = "") {
  if (!notes || typeof notes !== "object") {
    return fallbackNotes(fallbackContent, "Invalid notes structure");
  }

  const safeArray = (arr, itemSanitizer) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(itemSanitizer).filter(Boolean);
  };

  return {
    title: safeString(notes.title, "Study Notes"),
    summary: safeString(notes.summary, "Summary could not be generated."),
    keyPoints: safeArray(notes.keyPoints, (p) => safeString(p)),
    actionItems: safeArray(notes.actionItems, (a) => safeString(a)),
    flashcards: safeArray(notes.flashcards, (card) => ({
      question: safeString(card?.question, "Question"),
      answer: safeString(card?.answer, "Answer"),
    })),
    quiz: safeArray(notes.quiz, (q) => ({
      question: safeString(q?.question, "Question"),
      options: safeArray(q?.options, (opt) => safeString(opt)),
      answer: safeString(q?.answer, "Answer"),
    })),
  };
}

function fallbackNotes(content, reason = "AI formatting issue") {
  const reasonStr = safeString(reason, "AI formatting issue");
  const contentStr = typeof content === "string" ? content : safeString(content);

  return {
    title: "Study Notes",
    summary: contentStr.slice(0, 1000) || "Summary could not be generated.",
    keyPoints: [
      "The file was processed successfully.",
      `Note formatting info: ${reasonStr}`,
      "You can review the transcript below.",
    ],
    actionItems: [
      "Review the transcript.",
      "Try again with a smaller or cleaner file.",
    ],
    flashcards: [
      {
        question: "Was the file processed?",
        answer: "Yes.",
      },
    ],
    quiz: [
      {
        question: "Was the upload successful?",
        options: ["Yes", "No", "Maybe", "Unknown"],
        answer: "Yes",
      },
    ],
    reason: reasonStr,
  };
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
      const sanitized = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
      return JSON.parse(sanitized);
    } catch (e2) {
      console.error("JSON extraction error:", e2.message);
      return null;
    }
  }
}

async function generateStudyNotes(content) {
  const textContent = typeof content === "string" ? content : safeString(content);

  const prompt = `
Create comprehensive study notes from this content.

Return JSON ONLY. Do NOT include markdown blocks, intro, or extra text.

Use this JSON structure:
{
  "title": "short clear title",
  "summary": "detailed summary of content",
  "keyPoints": ["point 1", "point 2", "point 3"],
  "actionItems": ["action 1", "action 2"],
  "flashcards": [
    {
      "question": "question",
      "answer": "answer"
    }
  ],
  "quiz": [
    {
      "question": "question",
      "options": ["A", "B", "C", "D"],
      "answer": "correct answer"
    }
  ]
}

Content:
${textContent.slice(0, 15000)}
`;

  try {
    const rawText = await callGroqCompletion([
      { role: "user", content: prompt }
    ], 0.1);

    const parsedNotes = extractJson(rawText);

    if (parsedNotes && (parsedNotes.summary || parsedNotes.title)) {
      return sanitizeNotes(parsedNotes, textContent);
    }

    console.log("JSON extraction returned incomplete data. Using fallback.");
    return fallbackNotes(textContent, "JSON parsing issue");
  } catch (error) {
    console.error("Study notes error:", error.message);
    return fallbackNotes(textContent, error.message);
  }
}

async function translateText(text, language) {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is missing in environment variables.");
      return "GROQ_API_KEY is missing in Vercel Environment Variables. Please add GROQ_API_KEY in Vercel Settings -> Environment Variables.";
    }

    const safeText = typeof text === "string" ? text.slice(0, 8000) : safeString(text).slice(0, 8000);

    const prompt = `
Translate this text into ${language}.
Keep formatting clean and student-friendly. Return ONLY the translated text.

Text:
${safeText}
`;

    let raw = await callGroqCompletion([
      { role: "user", content: prompt }
    ], 0.2);

    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return safeString(raw);
  } catch (error) {
    console.error("Translation error details:", error);
    return `Translation failed: ${error.message || "Unknown error"}`;
  }
}

app.get("/", function (req, res) {
  res.json({
    message: "StudyMate AI backend is running",
    supportedFiles: {
      audioVideo: `0 MB to ${LIMITS_MB.audioVideo} MB`,
      pdf: `0 MB to ${LIMITS_MB.pdf} MB`,
      txt: `0 MB to ${LIMITS_MB.txt} MB`,
    },
  });
});

app.post("/api/process-file", upload.single("file"), async function (req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
      });
    }

    const mimetype = req.file.mimetype;
    const filename = req.file.originalname;
    const fileSizeMB = req.file.size / (1024 * 1024);

    const sizeError = checkFileSize(mimetype, filename, fileSizeMB);

    if (sizeError) {
      return res.status(400).json({
        error: sizeError,
      });
    }

    let extractedText = "";

    if (isAudioOrVideo(mimetype, filename)) {
      extractedText = await transcribeFile(req.file.buffer, filename);
    } else if (isPdf(mimetype, filename)) {
      extractedText = await extractPdfText(req.file.buffer);
    } else if (isText(mimetype, filename)) {
      extractedText = req.file.buffer.toString("utf-8");
    } else {
      return res.status(400).json({
        error:
          "Unsupported file type. Upload audio/video, PDF, or TXT. Allowed sizes: audio/video 0-4.5 MB, PDF 0-4.5 MB, TXT 0-2 MB.",
      });
    }

    const transcriptString = safeString(extractedText);

    if (!transcriptString || transcriptString.trim().length < 10) {
      return res.status(400).json({
        error: "Could not extract enough text from this file.",
      });
    }

    const notes = await generateStudyNotes(transcriptString);

    res.json({
      transcript: transcriptString,
      notes: sanitizeNotes(notes, transcriptString),
    });
  } catch (error) {
    console.error("Process file error:", error);

    const errorMsg = typeof error === "object" ? (error.message || JSON.stringify(error)) : String(error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error:
          "File size exceeds the 4.5 MB Vercel upload limit. Please select a smaller file under 4.5 MB.",
      });
    }

    res.status(500).json({
      error: errorMsg || "Failed to process file.",
    });
  }
});

app.post("/api/translate", async function (req, res) {
  try {
    const { text, language } = req.body;

    if (!text || !language) {
      return res.status(400).json({
        error: "Text and language are required.",
      });
    }

    const translatedText = await translateText(text, language);

    res.json({
      translatedText: safeString(translatedText),
    });
  } catch (error) {
    console.error("Translation error:", error);

    const errorMsg = typeof error === "object" ? (error.message || JSON.stringify(error)) : String(error);

    res.status(500).json({
      error: errorMsg || "Translation failed.",
    });
  }
});

app.use(function (err, req, res, next) {
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.code === "LIMIT_FILE_SIZE")) {
    return res.status(400).json({
      error: "File size exceeds the 4.5 MB Vercel upload limit. Please select a smaller audio or PDF file under 4.5 MB.",
    });
  }
  if (err) {
    return res.status(500).json({
      error: safeString(err.message || err) || "An unexpected server error occurred.",
    });
  }
  next();
});

const server = app.listen(PORT, "0.0.0.0", function () {
  console.log(`StudyMate AI backend running on port ${PORT}`);
});

server.on("error", function (error) {
  console.error("Server error:", error);
});

export default app;