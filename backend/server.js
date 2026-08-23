import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
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

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const uploadDir = path.join(process.cwd(), "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

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

async function extractPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(dataBuffer);
  return parsed.text || "";
}

async function transcribeFile(filePath) {
  return await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-large-v3",
    response_format: "text",
  });
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

async function generateStudyNotes(content) {
  const prompt = `
Create study notes from this content.

Return JSON only.

Use this structure:

{
  "title": "short title",
  "summary": "summary",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1"],
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

Rules:
- No markdown
- No code blocks
- No programming code examples
- No triple quotes
- Keep answers simple
- Escape all quotes properly

Content:
${content.slice(0, 15000)}
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0,
    });

    let text = completion.choices?.[0]?.message?.content || "";

    text = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .replace(/\r/g, " ")
      .replace(/\n/g, " ")
      .trim();

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1) {
      text = text.slice(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(text);
    } catch (jsonError) {
      console.log("Broken JSON detected. Using fallback.");
      return fallbackNotes(content, jsonError.message);
    }
  } catch (error) {
    console.error("Study notes error:", error.message);
    return fallbackNotes(content, error.message);
  }
}

async function translateText(text, language) {
  try {
    const prompt = `
Translate this text into ${language}.
Keep formatting clean and student-friendly.

Text:
${text}
`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
    });

    return completion.choices?.[0]?.message?.content || "Translation failed.";
  } catch (error) {
    console.error("Translation fallback used:", error.message);
    return "Translation failed. Please try again.";
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
  let filePath;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
      });
    }

    filePath = req.file.path;

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
      extractedText = await transcribeFile(filePath);
    } else if (isPdf(mimetype, filename)) {
      extractedText = await extractPdfText(filePath);
    } else if (isText(mimetype, filename)) {
      extractedText = fs.readFileSync(filePath, "utf-8");
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
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
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