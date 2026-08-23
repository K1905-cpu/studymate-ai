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
  audioVideo: 20,
  pdf: 10,
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
app.use(express.json({ limit: "20mb" }));

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,
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
    return `Audio/video file too large. Allowed size: 0 MB to ${LIMITS_MB.audioVideo} MB. Your file: ${fileSizeMB.toFixed(2)} MB.`;
  }

  if (isPdf(mimetype, filename) && fileSizeMB > LIMITS_MB.pdf) {
    return `PDF file too large. Allowed size: 0 MB to ${LIMITS_MB.pdf} MB. Your file: ${fileSizeMB.toFixed(2)} MB.`;
  }

  if (isText(mimetype, filename) && fileSizeMB > LIMITS_MB.txt) {
    return `TXT file too large. Allowed size: 0 MB to ${LIMITS_MB.txt} MB. Your file: ${fileSizeMB.toFixed(2)} MB.`;
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
    return transcription;
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

function fallbackNotes(content, reason = "AI formatting issue") {
  return {
    title: "Study Notes",
    summary: content.slice(0, 1000) || "Summary could not be generated.",
    keyPoints: [
      "The file was processed successfully.",
      "AI note formatting had an issue.",
      "You can still review the transcript below.",
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
    reason,
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
${content.slice(0, 15000)}
`;

  try {
    const rawText = await callGroqCompletion([
      { role: "user", content: prompt }
    ], 0.1);

    const parsedNotes = extractJson(rawText);

    if (parsedNotes && parsedNotes.summary) {
      return parsedNotes;
    }

    console.log("JSON extraction returned incomplete data. Using fallback.");
    return fallbackNotes(content, "JSON parsing issue");
  } catch (error) {
    console.error("Study notes error:", error.message);
    return fallbackNotes(content, error.message);
  }
}

async function translateText(text, language) {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is missing in environment variables.");
      return "GROQ_API_KEY is missing in Vercel Environment Variables. Please add GROQ_API_KEY in Vercel Settings -> Environment Variables.";
    }

    const safeText = text ? text.slice(0, 8000) : "";

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
    return raw;
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
          "Unsupported file type. Upload audio/video, PDF, or TXT. Allowed sizes: audio/video 0-20 MB, PDF 0-10 MB, TXT 0-2 MB.",
      });
    }

    if (!extractedText || extractedText.trim().length < 20) {
      return res.status(400).json({
        error: "Could not extract enough text from this file.",
      });
    }

    const notes = await generateStudyNotes(extractedText);

    res.json({
      transcript: extractedText,
      notes,
    });
  } catch (error) {
    console.error("Process file error:", error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error:
          "File too large. Allowed sizes: audio/video 0-20 MB, PDF 0-10 MB, TXT 0-2 MB.",
      });
    }

    res.status(500).json({
      error: error.message || "Failed to process file.",
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
      translatedText,
    });
  } catch (error) {
    console.error("Translation error:", error);

    res.status(500).json({
      error: "Translation failed.",
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", function () {
  console.log(`StudyMate AI backend running on port ${PORT}`);
});

server.on("error", function (error) {
  console.error("Server error:", error);
});

export default app;