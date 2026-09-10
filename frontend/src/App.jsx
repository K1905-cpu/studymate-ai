import React, { useState, useEffect, useRef, Component } from "react";
import axios from "axios";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { jsPDF } from "jspdf";
import { saveAs } from "file-saver";
import confetti from "canvas-confetti";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

// Axios interceptor for JWT token
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem("studymate_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function renderSafe(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (typeof val === "object") {
    return val.message || val.text || val.error || JSON.stringify(val);
  }
  return String(val || fallback);
}

function cleanChatText(val) {
  const safe = renderSafe(val);
  let answerPart = "";
  if (safe.includes("</think>")) {
    const thinkEnd = safe.indexOf("</think>");
    answerPart = safe.slice(thinkEnd + 8).trim();
  } else {
    answerPart = safe.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "").trim();
  }

  let cleaned = answerPart
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<reasoning>[\s\S]*/gi, "")
    .trim();

  return cleaned || safe;
}

function renderInlineFormatting(text) {
  if (typeof text !== "string") return text;
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index} className="inline-code">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function FormattedText({ content }) {
  const clean = cleanChatText(content);
  if (!clean) {
    return <p style={{ margin: "4px 0" }}>Here is your study response!</p>;
  }

  const lines = clean.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Markdown Table Check
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rowStr = lines[i].trim();
        const isSeparator = /^\|[\s:\-]+\|$/i.test(rowStr) || /^\|(?:\s*:?-+:?\s*\|)+$/i.test(rowStr);
        if (!isSeparator) {
          tableLines.push(rowStr);
        }
        i++;
      }

      if (tableLines.length > 0) {
        const headerRow = tableLines[0]
          .split("|")
          .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
          .map((c) => c.trim());

        const bodyRows = tableLines.slice(1).map((row) =>
          row
            .split("|")
            .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
            .map((c) => c.trim())
        );

        blocks.push(
          <div key={`table-${i}`} className="chat-table-wrapper">
            <table className="chat-table">
              <thead>
                <tr>
                  {headerRow.map((h, hIdx) => (
                    <th key={hIdx}>{renderInlineFormatting(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((r, rIdx) => (
                  <tr key={rIdx}>
                    {r.map((c, cIdx) => (
                      <td key={cIdx}>{renderInlineFormatting(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // List Items
    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)/) || trimmed.match(/^(\d+[\.\)])\s+(.*)/);
    if (bulletMatch) {
      const listItems = [];
      while (i < lines.length) {
        const itemTrimmed = lines[i].trim();
        const itemMatch = itemTrimmed.match(/^[-*•]\s+(.*)/) || itemTrimmed.match(/^(\d+[\.\)])\s+(.*)/);
        if (itemMatch) {
          const itemText = itemMatch[2] || itemMatch[1];
          listItems.push(<li key={`li-${i}`}>{renderInlineFormatting(itemText)}</li>);
          i++;
        } else {
          break;
        }
      }
      blocks.push(
        <ul key={`ul-${i}`} className="chat-list">
          {listItems}
        </ul>
      );
      continue;
    }

    // Headings
    if (trimmed.startsWith("###") || trimmed.startsWith("##") || trimmed.startsWith("#")) {
      const headerText = trimmed.replace(/^#+\s*/, "");
      blocks.push(
        <h4 key={`h-${i}`} className="chat-heading">
          {renderInlineFormatting(headerText)}
        </h4>
      );
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={`p-${i}`} className="chat-p">
        {renderInlineFormatting(trimmed)}
      </p>
    );
    i++;
  }

  return <div className="formatted-chat-content">{blocks}</div>;
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("UI Error caught by boundary:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-box">
          <h2>Something went wrong displaying results.</h2>
          <p className="error-text">{renderSafe(this.state.error?.message || this.state.error)}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Reload Interface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function MainApp() {
  // Auth state
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem("studymate_user");
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTab, setAuthTab] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // History state
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [historySessions, setHistorySessions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [activeSessionId, setActiveSessionId] = useState(null);

  // Document & study state
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("notes");
  const [isDragOver, setIsDragOver] = useState(false);

  // Flashcards mode state
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isCardFlipped, setIsCardFlipped] = useState(false);
  const [masteredCards, setMasteredCards] = useState(new Set());
  const [reviewCards, setReviewCards] = useState(new Set());

  // Interactive Quiz state
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [quizScore, setQuizScore] = useState(null);
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  // Translation state
  const [language, setLanguage] = useState("Hindi");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);

  // Export Modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportLanguage, setExportLanguage] = useState("Original");
  const [exportFormat, setExportFormat] = useState("pdf");
  const [exportLoading, setExportLoading] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // Toast notification
  const [toast, setToast] = useState(null);
  const chatScrollRef = useRef(null);

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  };

  const MAX_FILE_SIZE_MB = 50;
  const ALLOWED_EXTS = [
    ".pdf",
    ".docx",
    ".doc",
    ".txt",
    ".md",
    ".mp3",
    ".wav",
    ".m4a",
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
  ];

  const LANGUAGE_OPTIONS = [
    { code: "Original", name: "Original (English / Source)" },
    { code: "Hindi", name: "Hindi (हिंदी)" },
    { code: "Gujarati", name: "Gujarati (ગુજરાતી)" },
    { code: "Tamil", name: "Tamil (தமிழ்)" },
    { code: "Telugu", name: "Telugu (తెలుగు)" },
    { code: "Kannada", name: "Kannada (ಕನ್ನಡ)" },
    { code: "Malayalam", name: "Malayalam (മലയാളം)" },
    { code: "Marathi", name: "Marathi (मराठी)" },
    { code: "Bengali", name: "Bengali (বাংলা)" },
    { code: "Punjabi", name: "Punjabi (ਪੰਜਾਬੀ)" },
    { code: "Spanish", name: "Spanish (Español)" },
    { code: "French", name: "French (Français)" },
    { code: "German", name: "German (Deutsch)" },
    { code: "Japanese", name: "Japanese (日本語)" },
    { code: "Chinese", name: "Chinese (中文)" },
    { code: "Arabic", name: "Arabic (العربية)" },
    { code: "Russian", name: "Russian (Русский)" },
  ];

  useEffect(() => {
    fetchHistory();
  }, [user]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading]);

  const fetchHistory = async () => {
    try {
      setHistoryLoading(true);
      const res = await axios.get(`${API_BASE_URL}/api/history`);
      if (res.data && Array.isArray(res.data.sessions)) {
        setHistorySessions(res.data.sessions);
      }
    } catch (err) {
      console.warn("Could not fetch history:", err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAuthError("");
    setAuthLoading(true);

    try {
      const endpoint = authTab === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload =
        authTab === "register"
          ? { name: authForm.name, email: authForm.email, password: authForm.password }
          : { email: authForm.email, password: authForm.password };

      const res = await axios.post(`${API_BASE_URL}${endpoint}`, payload);

      if (res.data.token && res.data.user) {
        localStorage.setItem("studymate_token", res.data.token);
        localStorage.setItem("studymate_user", JSON.stringify(res.data.user));
        setUser(res.data.user);
        setShowAuthModal(false);
        setAuthForm({ name: "", email: "", password: "" });
        showToast(`Welcome ${res.data.user.name || "Student"}! 🎉`);
      }
    } catch (err) {
      setAuthError(renderSafe(err.response?.data?.error || err.message || "Authentication failed."));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    localStorage.removeItem("studymate_token");
    localStorage.removeItem("studymate_user");
    setUser(null);
    showToast("Signed out successfully.");
  };

  const handleFileSelection = (selectedFile) => {
    if (!selectedFile) return;

    const ext = "." + selectedFile.name.split(".").pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      setError(
        `Unsupported file type (${ext}). Please select a PDF (.pdf), Word Document (.docx), Plain Text (.txt, .md), or Audio/Video recording (.mp3, .wav, .mp4, .webm).`
      );
      setFile(null);
      return;
    }

    const fileSizeMB = selectedFile.size / (1024 * 1024);
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      setError(`File size (${fileSizeMB.toFixed(1)} MB) exceeds the 50 MB limit.`);
      setFile(null);
      return;
    }

    setFile(selectedFile);
    setError("");
  };

  const handleUpload = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!file) {
      setError("Please select a file to process.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setNotes(null);
      setTranscript("");
      setTranslatedText("");
      setChatMessages([]);
      setSelectedAnswers({});
      setQuizScore(null);
      setQuizSubmitted(false);
      setCurrentCardIndex(0);
      setIsCardFlipped(false);
      setMasteredCards(new Set());
      setReviewCards(new Set());

      const formData = new FormData();
      formData.append("file", file);

      const response = await axios.post(`${API_BASE_URL}/api/process-file`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (response.data.notes) {
        setNotes(response.data.notes);
        setTranscript(renderSafe(response.data.transcript));
        setActiveSessionId(response.data.sessionId || null);
        setActiveTab("notes");

        setChatMessages([
          {
            role: "assistant",
            content: `Hello! I have generated comprehensive study notes for **${
              response.data.notes.title || file.name
            }**. Feel free to explore the interactive flashcards, take the quiz, or ask me anything!`,
          },
        ]);

        fetchHistory();
        showToast("Study notes generated with Gemini 2.5 Flash! ⚡");
      }
    } catch (err) {
      setError(renderSafe(err.response?.data?.error || err.message || "Failed to process file."));
    } finally {
      setLoading(false);
    }
  };

  const handleLoadSession = (session) => {
    if (!session || !session.notes) return;
    setNotes(session.notes);
    setTranscript(session.transcript || "");
    setActiveSessionId(session.id);
    setSelectedAnswers({});
    setQuizScore(session.quizScore || null);
    setQuizSubmitted(session.quizScore !== null);
    setCurrentCardIndex(0);
    setIsCardFlipped(false);
    setMasteredCards(new Set());
    setReviewCards(new Set());
    setTranslatedText("");
    setActiveTab("notes");
    setShowHistoryDrawer(false);

    setChatMessages([
      {
        role: "assistant",
        content: `Loaded past session **${session.title || "Lecture Notes"}**. What would you like to study or test?`,
      },
    ]);
    showToast(`Loaded "${session.title}" 📖`);
  };

  const handleDeleteSession = async (sessionId, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!window.confirm("Are you sure you want to delete this study session?")) return;

    try {
      await axios.delete(`${API_BASE_URL}/api/history/${sessionId}`);
      setHistorySessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
      showToast("Session removed from history.");
    } catch (err) {
      showToast("Failed to delete session.");
    }
  };

  const handleSendChat = async (customMessage) => {
    const messageToSend = customMessage || chatInput;
    if (!messageToSend || !messageToSend.trim() || chatLoading) return;

    const userMsg = { role: "user", content: messageToSend.trim() };
    const updatedHistory = [...chatMessages, userMsg];
    setChatMessages(updatedHistory);
    if (!customMessage) setChatInput("");
    setChatLoading(true);

    try {
      const response = await axios.post(`${API_BASE_URL}/api/chat`, {
        message: messageToSend,
        transcript,
        notes,
        chatHistory: chatMessages,
      });

      const reply = cleanChatText(response.data.reply) || "Here is your response based on the study materials.";
      setChatMessages([...updatedHistory, { role: "assistant", content: reply }]);
    } catch (err) {
      setChatMessages([
        ...updatedHistory,
        {
          role: "assistant",
          content: cleanChatText(err.response?.data?.error || "Sorry, I encountered an issue replying. Please try again."),
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const translateContent = async (targetLang) => {
    if (!notes) return "";
    const response = await axios.post(`${API_BASE_URL}/api/translate`, {
      text: getFullNotesMarkdown(),
      language: targetLang,
    });
    return cleanChatText(response.data.translatedText);
  };

  const handleTranslate = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!notes) return;
    try {
      setTranslating(true);
      setError("");
      const text = await translateContent(language);
      setTranslatedText(text);
      showToast(`Translated notes into ${language}! 🌐`);
    } catch (err) {
      setError(renderSafe(err.response?.data?.error || err.message || "Translation failed."));
    } finally {
      setTranslating(false);
    }
  };

  // Flashcards navigation
  const flashcardsList = Array.isArray(notes?.flashcards) ? notes.flashcards : [];
  const currentCard = flashcardsList[currentCardIndex];

  const handleNextCard = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setIsCardFlipped(false);
    setCurrentCardIndex((prev) => (prev + 1) % flashcardsList.length);
  };

  const handlePrevCard = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setIsCardFlipped(false);
    setCurrentCardIndex((prev) => (prev - 1 + flashcardsList.length) % flashcardsList.length);
  };

  const markCard = (status, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (status === "mastered") {
      setMasteredCards((prev) => new Set(prev).add(currentCardIndex));
      setReviewCards((prev) => {
        const next = new Set(prev);
        next.delete(currentCardIndex);
        return next;
      });
    } else {
      setReviewCards((prev) => new Set(prev).add(currentCardIndex));
      setMasteredCards((prev) => {
        const next = new Set(prev);
        next.delete(currentCardIndex);
        return next;
      });
    }
    handleNextCard();
  };

  // Interactive Quiz handling
  const quizList = Array.isArray(notes?.quiz) ? notes.quiz : [];

  const handleSelectQuizOption = (qIdx, option) => {
    if (quizSubmitted) return;
    setSelectedAnswers((prev) => ({ ...prev, [qIdx]: option }));
  };

  const handleGradeQuiz = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (quizList.length === 0) return;
    let scoreCount = 0;
    quizList.forEach((q, idx) => {
      const selected = selectedAnswers[idx];
      if (selected && (selected === q.answer || selected.startsWith(q.answer) || q.answer.startsWith(selected))) {
        scoreCount++;
      }
    });

    const calculatedScore = {
      score: scoreCount,
      total: quizList.length,
      percentage: Math.round((scoreCount / quizList.length) * 100),
    };

    setQuizScore(calculatedScore);
    setQuizSubmitted(true);

    if (calculatedScore.percentage >= 70) {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }

    if (activeSessionId) {
      try {
        await axios.patch(`${API_BASE_URL}/api/history/${activeSessionId}/quiz-score`, {
          quizScore: calculatedScore,
        });
      } catch (err) {
        // silent sync
      }
    }
    showToast(`Quiz completed! You scored ${calculatedScore.score}/${calculatedScore.total} (${calculatedScore.percentage}%) 🎯`);
  };

  const handleResetQuiz = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setSelectedAnswers({});
    setQuizScore(null);
    setQuizSubmitted(false);
  };

  // ----------------------------------------------------
  // COMPLETE STUDY PACKAGE EXPORT ENGINE (ALL SECTIONS + ANY LANGUAGE)
  // ----------------------------------------------------
  const getFullNotesMarkdown = () => {
    if (!notes) return "";
    return `# ${renderSafe(notes.title) || "Study Notes"}
**Subject:** ${renderSafe(notes.subject || "General Academic Studies")}

---

## 📌 Executive Summary
${renderSafe(notes.summary)}

---

## 💡 Key Takeaways & Core Concepts
${
  Array.isArray(notes.keyPoints)
    ? notes.keyPoints.map((p, i) => `${i + 1}. ${renderSafe(p)}`).join("\n")
    : "No key points available."
}

---

## 📋 Actionable Revision Checklist
${
  Array.isArray(notes.actionItems)
    ? notes.actionItems.map((a, i) => `- [ ] ${renderSafe(a)}`).join("\n")
    : "No action items available."
}

---

## 📖 Key Definitions, Terms & Formulas
${
  Array.isArray(notes.glossary) && notes.glossary.length > 0
    ? notes.glossary.map((g) => `### ${renderSafe(g.term)}\n${renderSafe(g.definition)}`).join("\n\n")
    : "No glossary terms defined."
}

---

## 📇 Revision Flashcards
${
  Array.isArray(notes.flashcards) && notes.flashcards.length > 0
    ? notes.flashcards
        .map((c, i) => `**Q${i + 1}: ${renderSafe(c.question)}**\n*Answer:* ${renderSafe(c.answer)}`)
        .join("\n\n")
    : "No flashcards generated."
}

---

## 🎯 Practice Quiz & Knowledge Check
${
  Array.isArray(notes.quiz) && notes.quiz.length > 0
    ? notes.quiz
        .map((q, i) => {
          const opts = Array.isArray(q.options)
            ? q.options.map((opt) => `  - ${renderSafe(opt)}`).join("\n")
            : "";
          return `### Question ${i + 1}: ${renderSafe(q.question)}\n${opts}\n**Correct Answer:** ${renderSafe(
            q.answer
          )}\n*Explanation:* ${renderSafe(q.explanation || "Correct based on the material.")}`;
        })
        .join("\n\n")
    : "No quiz questions generated."
}
`;
  };

  const getCleanFilename = (lang = "Original", ext = "pdf") => {
    const base = (notes?.title || "studymate_notes").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const langTag = lang && lang !== "Original" ? `_${lang.toLowerCase()}` : "";
    return `${base}${langTag}.${ext}`;
  };

  const downloadTextFile = (content, filename, mimeType = "text/plain;charset=utf-8") => {
    const blob = new Blob([content], { type: mimeType });
    saveAs(blob, filename);
  };

  const downloadWordDocx = async (targetLang = "Original", e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!notes) return;
    try {
      setExportLoading(true);
      let contentText = "";

      if (targetLang !== "Original") {
        if (targetLang === language && translatedText) {
          contentText = translatedText;
        } else {
          contentText = await translateContent(targetLang);
        }
      }

      let docChildren = [];

      if (contentText) {
        docChildren = [
          new Paragraph({
            text: `${renderSafe(notes.title)} (${targetLang})`,
            heading: HeadingLevel.TITLE,
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Translated into: ${targetLang} | Generated by StudyMate AI`, italics: true }),
            ],
            spacing: { after: 300 },
          }),
          ...contentText.split("\n").map((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
              return new Paragraph({
                text: trimmed.replace(/^#+\s*/, ""),
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 240, after: 120 },
              });
            }
            if (trimmed.startsWith("### ")) {
              return new Paragraph({
                text: trimmed.replace(/^###\s*/, ""),
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 180, after: 80 },
              });
            }
            return new Paragraph({
              text: line,
              spacing: { after: 80 },
            });
          }),
        ];
      } else {
        docChildren = [
          new Paragraph({
            text: renderSafe(notes.title) || "StudyMate AI Notes",
            heading: HeadingLevel.TITLE,
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Subject: `, bold: true }),
              new TextRun({ text: `${renderSafe(notes.subject || "Academic Study")} | Generated by StudyMate AI` }),
            ],
            spacing: { after: 300 },
          }),
          new Paragraph({
            text: "1. Executive Summary",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          new Paragraph({
            text: renderSafe(notes.summary),
            spacing: { after: 240 },
          }),
          new Paragraph({
            text: "2. Key Takeaways & Core Concepts",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          ...(Array.isArray(notes.keyPoints)
            ? notes.keyPoints.map(
                (p, i) =>
                  new Paragraph({
                    text: `${i + 1}. ${renderSafe(p)}`,
                    spacing: { after: 80 },
                  })
              )
            : []),
          new Paragraph({
            text: "3. Actionable Revision Checklist",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          ...(Array.isArray(notes.actionItems)
            ? notes.actionItems.map(
                (a) =>
                  new Paragraph({
                    text: `☐ ${renderSafe(a)}`,
                    spacing: { after: 80 },
                  })
              )
            : []),
          new Paragraph({
            text: "4. Key Terms, Formulas & Glossary",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          ...(Array.isArray(notes.glossary)
            ? notes.glossary.flatMap((g) => [
                new Paragraph({
                  children: [new TextRun({ text: `• ${renderSafe(g.term)}: `, bold: true })],
                  spacing: { before: 100, after: 40 },
                }),
                new Paragraph({
                  text: renderSafe(g.definition),
                  spacing: { after: 100 },
                }),
              ])
            : []),
          new Paragraph({
            text: "5. Revision Flashcards",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          ...(Array.isArray(notes.flashcards)
            ? notes.flashcards.flatMap((c, i) => [
                new Paragraph({
                  children: [new TextRun({ text: `Card ${i + 1} Question: ${renderSafe(c.question)}`, bold: true })],
                  spacing: { before: 80, after: 40 },
                }),
                new Paragraph({
                  children: [new TextRun({ text: `Answer: ${renderSafe(c.answer)}`, italics: true })],
                  spacing: { after: 120 },
                }),
              ])
            : []),
          new Paragraph({
            text: "6. Practice Quiz & Test Questions",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          }),
          ...(Array.isArray(notes.quiz)
            ? notes.quiz.flatMap((q, i) => [
                new Paragraph({
                  children: [new TextRun({ text: `Q${i + 1}: ${renderSafe(q.question)}`, bold: true })],
                  spacing: { before: 140, after: 60 },
                }),
                ...(Array.isArray(q.options)
                  ? q.options.map(
                      (opt) =>
                        new Paragraph({
                          text: `   ${renderSafe(opt)}`,
                          spacing: { after: 40 },
                        })
                    )
                  : []),
                new Paragraph({
                  children: [new TextRun({ text: `Correct Answer: ${renderSafe(q.answer)}`, bold: true })],
                  spacing: { before: 40, after: 40 },
                }),
                new Paragraph({
                  children: [new TextRun({ text: `Explanation: ${renderSafe(q.explanation)}`, italics: true })],
                  spacing: { after: 140 },
                }),
              ])
            : []),
        ];
      }

      const doc = new Document({ sections: [{ children: docChildren }] });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, getCleanFilename(targetLang, "docx"));
      showToast(`Downloaded Word document in ${targetLang}! 📄`);
      setShowExportModal(false);
    } catch (err) {
      console.error(err);
      showToast("Failed to generate Word document.");
    } finally {
      setExportLoading(false);
    }
  };

  const downloadPdfDoc = async (targetLang = "Original", e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!notes) return;
    try {
      setExportLoading(true);
      let contentText = "";

      if (targetLang !== "Original") {
        if (targetLang === language && translatedText) {
          contentText = translatedText;
        } else {
          contentText = await translateContent(targetLang);
        }
      }

      const isIndicOrAsian = [
        "Hindi",
        "Gujarati",
        "Tamil",
        "Telugu",
        "Kannada",
        "Malayalam",
        "Marathi",
        "Bengali",
        "Punjabi",
        "Japanese",
        "Chinese",
        "Arabic",
        "Russian",
      ].includes(targetLang);

      if (isIndicOrAsian && contentText) {
        printStyledDocument(contentText, targetLang);
        showToast(`Opened print/PDF view in ${targetLang}! Save as PDF via browser print. 📑`);
        setShowExportModal(false);
        setExportLoading(false);
        return;
      }

      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 40;
      const contentWidth = pageWidth - margin * 2;
      let curY = 40;

      const checkPageBreak = (neededHeight = 30) => {
        if (curY + neededHeight > doc.internal.pageSize.getHeight() - 40) {
          doc.addPage();
          curY = 40;
        }
      };

      const addSectionHeader = (title) => {
        checkPageBreak(40);
        doc.setFillColor(238, 242, 255);
        doc.roundedRect(margin, curY, contentWidth, 24, 4, 4, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(79, 70, 229);
        doc.text(title, margin + 10, curY + 16);
        curY += 34;
      };

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.setTextColor(15, 23, 42);
      const titleLines = doc.splitTextToSize(renderSafe(notes.title) || "Study Notes", contentWidth);
      doc.text(titleLines, margin, curY);
      curY += titleLines.length * 22 + 4;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Subject: ${renderSafe(notes.subject || "Academic Study")} | StudyMate AI Package (${targetLang})`,
        margin,
        curY
      );
      curY += 24;

      if (contentText) {
        const lines = contentText.split("\n");
        lines.forEach((l) => {
          const trimmed = l.trim();
          if (!trimmed) {
            curY += 8;
            return;
          }
          if (trimmed.startsWith("#")) {
            addSectionHeader(trimmed.replace(/^#+\s*/, ""));
          } else {
            checkPageBreak(20);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.setTextColor(51, 65, 85);
            const split = doc.splitTextToSize(trimmed, contentWidth);
            doc.text(split, margin, curY);
            curY += split.length * 14 + 4;
          }
        });
      } else {
        addSectionHeader("1. Executive Summary");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(51, 65, 85);
        const sumLines = doc.splitTextToSize(renderSafe(notes.summary), contentWidth);
        doc.text(sumLines, margin, curY);
        curY += sumLines.length * 14 + 14;

        if (Array.isArray(notes.keyPoints) && notes.keyPoints.length > 0) {
          addSectionHeader("2. Key Takeaways & Core Concepts");
          notes.keyPoints.forEach((p, idx) => {
            checkPageBreak(25);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(79, 70, 229);
            doc.text(`${idx + 1}.`, margin, curY);

            doc.setFont("helvetica", "normal");
            doc.setTextColor(51, 65, 85);
            const pLines = doc.splitTextToSize(renderSafe(p), contentWidth - 20);
            doc.text(pLines, margin + 20, curY);
            curY += pLines.length * 14 + 6;
          });
          curY += 8;
        }

        if (Array.isArray(notes.actionItems) && notes.actionItems.length > 0) {
          addSectionHeader("3. Actionable Revision Checklist");
          notes.actionItems.forEach((item) => {
            checkPageBreak(20);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.setTextColor(51, 65, 85);
            const aLines = doc.splitTextToSize(`[ ] ${renderSafe(item)}`, contentWidth);
            doc.text(aLines, margin, curY);
            curY += aLines.length * 14 + 4;
          });
          curY += 8;
        }

        if (Array.isArray(notes.glossary) && notes.glossary.length > 0) {
          addSectionHeader("4. Key Concepts & Formulas Glossary");
          notes.glossary.forEach((g) => {
            checkPageBreak(32);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(15, 23, 42);
            doc.text(`• ${renderSafe(g.term)}:`, margin, curY);
            curY += 14;

            doc.setFont("helvetica", "normal");
            doc.setTextColor(71, 85, 105);
            const defLines = doc.splitTextToSize(renderSafe(g.definition), contentWidth - 14);
            doc.text(defLines, margin + 14, curY);
            curY += defLines.length * 14 + 6;
          });
          curY += 8;
        }

        if (Array.isArray(notes.flashcards) && notes.flashcards.length > 0) {
          addSectionHeader("5. Revision Flashcards");
          notes.flashcards.forEach((c, idx) => {
            checkPageBreak(36);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(15, 23, 42);
            const qLines = doc.splitTextToSize(`Card ${idx + 1}: ${renderSafe(c.question)}`, contentWidth);
            doc.text(qLines, margin, curY);
            curY += qLines.length * 14 + 2;

            doc.setFont("helvetica", "italic");
            doc.setTextColor(16, 185, 129);
            const aLines = doc.splitTextToSize(`Answer: ${renderSafe(c.answer)}`, contentWidth);
            doc.text(aLines, margin, curY);
            curY += aLines.length * 14 + 8;
          });
          curY += 8;
        }

        if (Array.isArray(notes.quiz) && notes.quiz.length > 0) {
          addSectionHeader("6. Practice Quiz & Test Questions");
          notes.quiz.forEach((q, idx) => {
            checkPageBreak(50);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(15, 23, 42);
            const qLines = doc.splitTextToSize(`Q${idx + 1}: ${renderSafe(q.question)}`, contentWidth);
            doc.text(qLines, margin, curY);
            curY += qLines.length * 14 + 4;

            if (Array.isArray(q.options)) {
              q.options.forEach((opt) => {
                checkPageBreak(16);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(71, 85, 105);
                const optLines = doc.splitTextToSize(`   ${renderSafe(opt)}`, contentWidth);
                doc.text(optLines, margin, curY);
                curY += optLines.length * 13 + 2;
              });
            }

            checkPageBreak(30);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(16, 185, 129);
            doc.text(`Correct Answer: ${renderSafe(q.answer)}`, margin + 10, curY + 6);
            curY += 18;

            if (q.explanation) {
              doc.setFont("helvetica", "italic");
              doc.setTextColor(100, 116, 139);
              const expLines = doc.splitTextToSize(`Explanation: ${renderSafe(q.explanation)}`, contentWidth - 10);
              doc.text(expLines, margin + 10, curY);
              curY += expLines.length * 13 + 8;
            }
          });
        }
      }

      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(148, 163, 184);
        doc.text(
          `Page ${p} of ${totalPages} • Generated by StudyMate AI`,
          pageWidth / 2,
          doc.internal.pageSize.getHeight() - 20,
          { align: "center" }
        );
      }

      doc.save(getCleanFilename(targetLang, "pdf"));
      showToast(`Downloaded complete PDF in ${targetLang}! 📑`);
      setShowExportModal(false);
    } catch (err) {
      console.error(err);
      showToast("Failed to generate PDF.");
    } finally {
      setExportLoading(false);
    }
  };

  const printStyledDocument = (content = "", lang = "Original") => {
    const rawMarkdown = content || getFullNotesMarkdown();
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${renderSafe(notes?.title || "StudyMate Notes")} (${lang})</title>
          <meta charset="utf-8" />
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Noto+Sans:wght@400;600;700&display=swap');
            body {
              font-family: 'Plus Jakarta Sans', 'Noto Sans', sans-serif;
              padding: 40px;
              color: #0f172a;
              line-height: 1.6;
              max-width: 860px;
              margin: 0 auto;
            }
            .header-box {
              border-bottom: 2px solid #e2e8f0;
              padding-bottom: 20px;
              margin-bottom: 30px;
            }
            h1 { font-size: 28px; color: #4f46e5; margin: 0 0 8px 0; }
            .meta { color: #64748b; font-size: 14px; font-weight: 600; }
            h2 { font-size: 20px; color: #1e1b4b; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px; margin-top: 28px; }
            h3 { font-size: 16px; color: #4338ca; margin-top: 18px; }
            p { margin: 8px 0; }
            ul { padding-left: 24px; margin: 8px 0; }
            li { margin-bottom: 6px; }
            .card-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 10px 0; }
            .answer-text { color: #10b981; font-weight: 600; }
            @media print {
              body { padding: 0; }
              @page { margin: 20mm; }
            }
          </style>
        </head>
        <body>
          <div class="header-box">
            <h1>${renderSafe(notes?.title || "Study Notes")}</h1>
            <div class="meta">Subject: ${renderSafe(notes?.subject || "General")} | Language: ${lang} | Generated by StudyMate AI</div>
          </div>
          <div id="content">
            ${rawMarkdown
              .split("\n\n")
              .map((block) => {
                const trimmed = block.trim();
                if (trimmed.startsWith("# ")) return `<h1>${trimmed.slice(2)}</h1>`;
                if (trimmed.startsWith("## ")) return `<h2>${trimmed.slice(3)}</h2>`;
                if (trimmed.startsWith("### ")) return `<h3>${trimmed.slice(4)}</h3>`;
                if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
                  return `<ul>${trimmed
                    .split("\n")
                    .map((item) => `<li>${item.replace(/^[-*•]\s*(\[\s*\])?\s*/, "")}</li>`)
                    .join("")}</ul>`;
                }
                return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
              })
              .join("")}
          </div>
          <script>
            window.onload = function() {
              window.print();
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleUniversalExport = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!notes) return;
    if (exportFormat === "pdf") {
      await downloadPdfDoc(exportLanguage);
    } else if (exportFormat === "docx") {
      await downloadWordDocx(exportLanguage);
    } else if (exportFormat === "md" || exportFormat === "txt") {
      try {
        setExportLoading(true);
        let content = "";
        if (exportLanguage !== "Original") {
          content = await translateContent(exportLanguage);
        } else {
          content = getFullNotesMarkdown();
        }
        downloadTextFile(
          content,
          getCleanFilename(exportLanguage, exportFormat),
          exportFormat === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8"
        );
        showToast(`Downloaded ${exportFormat.toUpperCase()} file in ${exportLanguage}! 📋`);
        setShowExportModal(false);
      } catch (err) {
        showToast("Failed to export text file.");
      } finally {
        setExportLoading(false);
      }
    }
  };

  const copyToClipboard = (text, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    navigator.clipboard.writeText(text);
    showToast("Copied to clipboard! 📋");
  };

  const filteredHistory = historySessions.filter((s) =>
    (s.title || "").toLowerCase().includes(historySearch.toLowerCase()) ||
    (s.filename || "").toLowerCase().includes(historySearch.toLowerCase())
  );

  return (
    <div className="app-shell">
      {/* Toast Notification */}
      {toast && <div className="toast-notification">{toast}</div>}

      {/* Navigation Bar */}
      <nav className="navbar">
        <div className="nav-container">
          <div
            className="brand"
            role="button"
            tabIndex={0}
            onClick={() => {
              window.location.href = "/";
            }}
          >
            <div className="brand-logo">🧠</div>
            <div className="brand-text">
              <span className="brand-name">StudyMate AI</span>
              <span className="brand-sub">Intelligent Study Suite</span>
            </div>
          </div>

          <div className="nav-actions">
            <button
              type="button"
              className="btn btn-secondary history-btn"
              onClick={() => setShowHistoryDrawer(true)}
            >
              📚 History ({historySessions.length})
            </button>

            {user ? (
              <div className="user-profile-menu">
                <div className="user-avatar">{user.name ? user.name[0].toUpperCase() : "S"}</div>
                <div className="user-info">
                  <span className="user-name">{user.name}</span>
                  <span className="user-badge">Student</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleSignOut}
                  title="Sign Out"
                >
                  🚪 Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary login-btn"
                onClick={() => {
                  setAuthTab("login");
                  setShowAuthModal(true);
                }}
              >
                👤 Sign In / Register
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Hero Header */}
      <header className="hero-banner">
        <div className="hero-content">
          <h1>Transform Your Lectures into Mastery</h1>
          <p>
            Upload any lecture recording, PDF, Word docx, or textbook chapter. Get instant structured
            summaries, formula glossaries, 3D interactive flashcards, practice quizzes, and an AI personal tutor.
          </p>
        </div>
      </header>

      {/* Main Container */}
      <main className="main-content">
        {/* Upload Zone */}
        <section className="card upload-box">
          <div
            className={`drop-area ${isDragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleFileSelection(e.dataTransfer.files[0]);
              }
            }}
          >
            <div className="drop-icon">📁</div>
            <h3>{file ? file.name : "Drag & Drop or Browse Study File"}</h3>
            <p className="muted-text">
              Supports: <strong>PDF</strong>, <strong>Word (.docx)</strong>, <strong>TXT/Markdown</strong>, and{" "}
              <strong>Audio/Video (.mp3, .wav, .mp4, .webm)</strong> up to <strong>50 MB</strong>.
            </p>

            <input
              type="file"
              id="file-input"
              className="file-hidden-input"
              onChange={(e) => handleFileSelection(e.target.files[0])}
              disabled={loading}
              accept=".pdf,.docx,.doc,.txt,.md,.mp3,.wav,.m4a,.mp4,.mov,.webm,.mkv"
            />

            <div className="upload-buttons-row">
              <label htmlFor="file-input" className="btn btn-secondary">
                {file ? "Choose Another File" : "Browse Files"}
              </label>

              {file && (
                <button
                  type="button"
                  className="btn btn-primary pulse-btn"
                  onClick={handleUpload}
                  disabled={loading}
                >
                  {loading ? "Generating Notes with Gemini 2.5 Flash... 🧠✨" : "Generate Study Materials 🚀"}
                </button>
              )}
            </div>

            {file && (
              <div className="file-info-chip">
                <span>📎 {file.name}</span>
                <span className="file-size">({(file.size / (1024 * 1024)).toFixed(2)} MB)</span>
              </div>
            )}
          </div>

          {error && <div className="error-alert">⚠️ {error}</div>}
        </section>

        {/* Study Suite Container */}
        {notes && (
          <section className="study-suite">
            {/* Header / Title Bar */}
            <div className="session-header-bar">
              <div>
                <span className="subject-tag">{renderSafe(notes.subject) || "Academic Study"}</span>
                <h2>{renderSafe(notes.title) || "Comprehensive Study Notes"}</h2>
              </div>
              <div className="quick-export-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowExportModal(true)}
                >
                  📥 Download in Any Language...
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => downloadWordDocx("Original")}
                >
                  📄 Word (.docx)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => downloadPdfDoc("Original")}
                >
                  📑 Full PDF
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => copyToClipboard(getFullNotesMarkdown())}
                >
                  📋 Copy Markdown
                </button>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="study-nav-tabs">
              <button
                type="button"
                className={`tab-btn ${activeTab === "notes" ? "active" : ""}`}
                onClick={() => setActiveTab("notes")}
              >
                📑 Notes & Breakdown
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "flashcards" ? "active" : ""}`}
                onClick={() => setActiveTab("flashcards")}
              >
                📇 Flashcards ({flashcardsList.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "quiz" ? "active" : ""}`}
                onClick={() => setActiveTab("quiz")}
              >
                🎯 Interactive Quiz ({quizList.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "chat" ? "active" : ""}`}
                onClick={() => setActiveTab("chat")}
              >
                💬 AI Tutor Chat
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "translate" ? "active" : ""}`}
                onClick={() => setActiveTab("translate")}
              >
                🌐 Translate & Download
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "transcript" ? "active" : ""}`}
                onClick={() => setActiveTab("transcript")}
              >
                📜 Transcript
              </button>
            </div>

            {/* TAB 1: NOTES & BREAKDOWN */}
            {activeTab === "notes" && (
              <div className="tab-pane">
                {/* Executive Summary */}
                <div className="card content-card">
                  <div className="section-title-row">
                    <h3>📌 Executive Summary</h3>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => copyToClipboard(renderSafe(notes.summary))}
                    >
                      Copy Summary
                    </button>
                  </div>
                  <div className="summary-body">
                    <FormattedText content={renderSafe(notes.summary)} />
                  </div>
                </div>

                {/* Key Points & Action Checklist Grid */}
                <div className="dual-grid">
                  <div className="card content-card">
                    <h3>💡 Key Points & Takeaways</h3>
                    <ul className="fancy-list">
                      {Array.isArray(notes.keyPoints) &&
                        notes.keyPoints.map((point, index) => (
                          <li key={index}>
                            <span className="list-num">{index + 1}</span>
                            <span>{renderSafe(point)}</span>
                          </li>
                        ))}
                    </ul>
                  </div>

                  <div className="card content-card">
                    <h3>📋 Actionable Revision Checklist</h3>
                    <ul className="checklist">
                      {Array.isArray(notes.actionItems) &&
                        notes.actionItems.map((item, index) => (
                          <li key={index} className="checklist-item">
                            <input type="checkbox" id={`action-${index}`} />
                            <label htmlFor={`action-${index}`}>{renderSafe(item)}</label>
                          </li>
                        ))}
                    </ul>
                  </div>
                </div>

                {/* Glossary & Core Definitions */}
                {Array.isArray(notes.glossary) && notes.glossary.length > 0 && (
                  <div className="card content-card">
                    <h3>📖 Key Concepts & Formulas Glossary</h3>
                    <div className="glossary-grid">
                      {notes.glossary.map((item, idx) => (
                        <div className="glossary-card" key={idx}>
                          <h4>{renderSafe(item.term)}</h4>
                          <p>{renderSafe(item.definition)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: INTERACTIVE FLASHCARDS */}
            {activeTab === "flashcards" && (
              <div className="tab-pane">
                <div className="card content-card flashcards-view">
                  <div className="flashcards-topbar">
                    <h3>📇 Active Recall Flashcards</h3>
                    <div className="flashcard-stats">
                      <span className="stat-badge green">
                        ✓ Mastered: {masteredCards.size}
                      </span>
                      <span className="stat-badge amber">
                        ⟳ Needs Review: {reviewCards.size}
                      </span>
                      <span className="stat-badge blue">
                        Total: {flashcardsList.length}
                      </span>
                    </div>
                  </div>

                  {flashcardsList.length > 0 ? (
                    <div className="flashcard-interactive-wrapper">
                      {/* 3D Flip Card */}
                      <div
                        className={`flashcard-3d ${isCardFlipped ? "flipped" : ""}`}
                        onClick={() => setIsCardFlipped(!isCardFlipped)}
                      >
                        <div className="flashcard-inner">
                          <div className="flashcard-face flashcard-front">
                            <span className="card-counter">
                              Card {currentCardIndex + 1} of {flashcardsList.length} (Click to Flip)
                            </span>
                            <div className="card-question">
                              {renderSafe(currentCard?.question)}
                            </div>
                            <span className="flip-hint">👆 Click to reveal answer</span>
                          </div>
                          <div className="flashcard-face flashcard-back">
                            <span className="card-counter">
                              Answer (Click to Flip)
                            </span>
                            <div className="card-answer">
                              {renderSafe(currentCard?.answer)}
                            </div>
                            <span className="flip-hint">👆 Click to see question</span>
                          </div>
                        </div>
                      </div>

                      {/* Flashcard Controls */}
                      <div className="flashcard-actions-bar">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={handlePrevCard}
                        >
                          ← Previous
                        </button>
                        <button
                          type="button"
                          className="btn btn-success"
                          onClick={(e) => markCard("mastered", e)}
                        >
                          ✓ Mastered
                        </button>
                        <button
                          type="button"
                          className="btn btn-warning"
                          onClick={(e) => markCard("review", e)}
                        >
                          ⟳ Review Again
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={handleNextCard}
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p>No flashcards generated for this file.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: INTERACTIVE QUIZ */}
            {activeTab === "quiz" && (
              <div className="tab-pane">
                <div className="card content-card quiz-view">
                  <div className="quiz-header">
                    <div>
                      <h3>🎯 Practice Test & Knowledge Check</h3>
                      <p className="muted-text">
                        Select an option for each question and submit to test your mastery!
                      </p>
                    </div>
                    {quizScore && (
                      <div className="quiz-score-badge">
                        <span>Score: {quizScore.score} / {quizScore.total}</span>
                        <strong>({quizScore.percentage}%)</strong>
                      </div>
                    )}
                  </div>

                  <div className="quiz-questions-list">
                    {quizList.map((q, qIdx) => {
                      const selected = selectedAnswers[qIdx];
                      const isCorrect =
                        selected &&
                        (selected === q.answer || selected.startsWith(q.answer) || q.answer.startsWith(selected));

                      return (
                        <div
                          key={qIdx}
                          className={`quiz-item-card ${
                            quizSubmitted ? (isCorrect ? "correct-q" : "incorrect-q") : ""
                          }`}
                        >
                          <div className="quiz-q-num">Question {qIdx + 1}</div>
                          <div className="quiz-q-text">{renderSafe(q.question)}</div>

                          <div className="quiz-options-grid">
                            {Array.isArray(q.options) &&
                              q.options.map((opt, optIdx) => {
                                const isOptionSelected = selected === opt;
                                const isOptionAnswer =
                                  opt === q.answer || opt.startsWith(q.answer) || q.answer.startsWith(opt);

                                let optClass = "quiz-option-btn";
                                if (isOptionSelected) optClass += " selected";
                                if (quizSubmitted) {
                                  if (isOptionAnswer) optClass += " correct-opt";
                                  else if (isOptionSelected) optClass += " wrong-opt";
                                }

                                return (
                                  <button
                                    type="button"
                                    key={optIdx}
                                    className={optClass}
                                    onClick={() => handleSelectQuizOption(qIdx, opt)}
                                    disabled={quizSubmitted}
                                  >
                                    <span className="option-letter">
                                      {String.fromCharCode(65 + optIdx)}
                                    </span>
                                    <span className="option-text">{renderSafe(opt)}</span>
                                  </button>
                                );
                              })}
                          </div>

                          {quizSubmitted && (
                            <div className="quiz-explanation-box">
                              <strong>{isCorrect ? "✅ Correct!" : "❌ Incorrect"}</strong>
                              <p>
                                <b>Correct Answer:</b> {renderSafe(q.answer)}
                              </p>
                              {q.explanation && (
                                <p className="explanation-text">
                                  <b>Explanation:</b> {renderSafe(q.explanation)}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="quiz-footer-actions">
                    {!quizSubmitted ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-lg"
                        onClick={handleGradeQuiz}
                        disabled={Object.keys(selectedAnswers).length === 0}
                      >
                        Submit Test & Calculate Score 🚀
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-lg"
                        onClick={handleResetQuiz}
                      >
                        🔄 Retake Quiz
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: AI TUTOR CHAT */}
            {activeTab === "chat" && (
              <div className="tab-pane">
                <div className="card content-card chatbot-card-modern">
                  <div className="chatbot-header">
                    <div>
                      <h3>💬 StudyMate AI Tutor</h3>
                      <span className="chat-badge-live">Live Tutor</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setChatMessages([
                          {
                            role: "assistant",
                            content: "Chat cleared! How else can I help you study?",
                          },
                        ])
                      }
                    >
                      Clear Chat
                    </button>
                  </div>

                  {/* Suggestion Chips */}
                  <div className="chip-container">
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() =>
                        handleSendChat("Generate 3 deep revision flashcards with detailed explanations.")
                      }
                      disabled={chatLoading}
                    >
                      💡 3 More Flashcards
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() =>
                        handleSendChat("Create 3 challenging exam questions with multiple-choice options.")
                      }
                      disabled={chatLoading}
                    >
                      ❓ 3 Exam Questions
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() =>
                        handleSendChat("Explain the hardest concept from this lecture in simple terms.")
                      }
                      disabled={chatLoading}
                    >
                      📝 Explain in Simple Terms
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() =>
                        handleSendChat("Provide a structured table comparing the main topics.")
                      }
                      disabled={chatLoading}
                    >
                      📊 Comparison Table
                    </button>
                  </div>

                  {/* Chat Message Stream */}
                  <div className="chat-history" ref={chatScrollRef}>
                    {chatMessages.map((msg, index) => (
                      <div key={index} className={`chat-message ${msg.role}`}>
                        <div className="message-sender">
                          {msg.role === "user" ? "You" : "StudyMate AI Tutor"}
                        </div>
                        <div className="message-bubble">
                          <FormattedText content={msg.content} />
                        </div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="chat-message assistant">
                        <div className="message-sender">StudyMate AI Tutor</div>
                        <div className="message-bubble typing-bubble">Thinking with Gemini 2.5 Flash... 🧠✨</div>
                      </div>
                    )}
                  </div>

                  {/* Chat Input */}
                  <form
                    className="chat-input-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSendChat();
                    }}
                  >
                    <input
                      type="text"
                      className="chat-input"
                      placeholder="Ask any question about this lecture or request more explanations..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      disabled={chatLoading}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={chatLoading || !chatInput.trim()}
                    >
                      {chatLoading ? "Sending..." : "Send"}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* TAB 5: MULTI-LANGUAGE TRANSLATE & DOWNLOAD */}
            {activeTab === "translate" && (
              <div className="tab-pane">
                <div className="card content-card">
                  <h3>🌐 Multi-Language Translator & Exporter</h3>
                  <p className="muted-text">
                    Translate your full study notes (Summary, Key Points, Checklist, Glossary, Flashcards, Quiz) into any language and download in your preferred format.
                  </p>

                  <div className="translate-bar">
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="select-dropdown"
                    >
                      {LANGUAGE_OPTIONS.filter((l) => l.code !== "Original").map((opt) => (
                        <option key={opt.code} value={opt.code}>
                          {opt.name}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleTranslate}
                      disabled={translating}
                    >
                      {translating ? "Translating Full Package... ⏳" : `Translate into ${language}`}
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setExportLanguage(language);
                        setShowExportModal(true);
                      }}
                    >
                      📥 Download in {language}...
                    </button>
                  </div>

                  {translatedText && (
                    <div className="translated-result-box">
                      <div className="section-title-row">
                        <h4>Translated Study Notes ({language})</h4>
                        <div className="quick-export-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => downloadWordDocx(language)}
                          >
                            📄 Word ({language})
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => downloadPdfDoc(language)}
                          >
                            📑 PDF ({language})
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() =>
                              downloadTextFile(translatedText, getCleanFilename(language, "txt"))
                            }
                          >
                            📝 Text (.txt)
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => copyToClipboard(translatedText)}
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                      <FormattedText content={translatedText} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 6: RAW TRANSCRIPT / SOURCE */}
            {activeTab === "transcript" && (
              <div className="tab-pane">
                <div className="card content-card">
                  <div className="section-title-row">
                    <h3>📜 Full Processed Transcript & Source Text</h3>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => copyToClipboard(transcript)}
                    >
                      Copy Transcript
                    </button>
                  </div>
                  <pre className="transcript-box">{transcript || "No transcript available."}</pre>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* History Slide-out Drawer */}
      {showHistoryDrawer && (
        <div className="drawer-overlay" onClick={() => setShowHistoryDrawer(false)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>📚 Student Study History</h3>
              <button
                type="button"
                className="btn-close"
                onClick={() => setShowHistoryDrawer(false)}
              >
                ✕
              </button>
            </div>

            <div className="drawer-search">
              <input
                type="text"
                placeholder="Search lectures & notes..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                className="search-input"
              />
            </div>

            <div className="drawer-sessions-list">
              {historyLoading ? (
                <p className="muted-text text-center">Loading history...</p>
              ) : filteredHistory.length === 0 ? (
                <div className="empty-history">
                  <p>No study sessions saved yet.</p>
                  <span className="muted-text">
                    Upload a lecture or document above to save your first session!
                  </span>
                </div>
              ) : (
                filteredHistory.map((s) => (
                  <div
                    key={s.id}
                    className={`history-item-card ${activeSessionId === s.id ? "active-session" : ""}`}
                    onClick={() => handleLoadSession(s)}
                  >
                    <div className="history-item-info">
                      <div className="history-item-title">{renderSafe(s.title)}</div>
                      <div className="history-item-meta">
                        <span>📁 {s.filename}</span>
                        <span>• {new Date(s.createdAt).toLocaleDateString()}</span>
                        {s.quizScore && (
                          <span className="history-score-chip">
                            Score: {s.quizScore.percentage}%
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-delete-history"
                      onClick={(e) => handleDeleteSession(s.id, e)}
                      title="Delete Session"
                    >
                      🗑️
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Universal Export Modal */}
      {showExportModal && (
        <div className="modal-overlay" onClick={() => !exportLoading && setShowExportModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📥 Download Study Package</h3>
              <button
                type="button"
                className="btn-close"
                onClick={() => setShowExportModal(false)}
                disabled={exportLoading}
              >
                ✕
              </button>
            </div>

            <p className="muted-text" style={{ marginBottom: 16 }}>
              Download all study materials (Summary, Key Points, Checklist, Glossary, Flashcards, Quiz) in your choice of language and format.
            </p>

            <div className="form-group" style={{ marginBottom: 14 }}>
              <label>Select Language</label>
              <select
                value={exportLanguage}
                onChange={(e) => setExportLanguage(e.target.value)}
                className="select-dropdown"
                style={{ width: "100%" }}
                disabled={exportLoading}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label>Select Format</label>
              <div className="format-selection-grid">
                <button
                  type="button"
                  className={`format-card-btn ${exportFormat === "pdf" ? "selected" : ""}`}
                  onClick={() => setExportFormat("pdf")}
                  disabled={exportLoading}
                >
                  <span className="format-icon">📑</span>
                  <span className="format-title">Complete PDF</span>
                  <span className="format-desc">Full multi-page document</span>
                </button>

                <button
                  type="button"
                  className={`format-card-btn ${exportFormat === "docx" ? "selected" : ""}`}
                  onClick={() => setExportFormat("docx")}
                  disabled={exportLoading}
                >
                  <span className="format-icon">📄</span>
                  <span className="format-title">Word (.docx)</span>
                  <span className="format-desc">Microsoft Word format</span>
                </button>

                <button
                  type="button"
                  className={`format-card-btn ${exportFormat === "md" ? "selected" : ""}`}
                  onClick={() => setExportFormat("md")}
                  disabled={exportLoading}
                >
                  <span className="format-icon">📝</span>
                  <span className="format-title">Markdown (.md)</span>
                  <span className="format-desc">Obsidian & Notion ready</span>
                </button>

                <button
                  type="button"
                  className={`format-card-btn ${exportFormat === "txt" ? "selected" : ""}`}
                  onClick={() => setExportFormat("txt")}
                  disabled={exportLoading}
                >
                  <span className="format-icon">📋</span>
                  <span className="format-title">Plain Text (.txt)</span>
                  <span className="format-desc">Universal UTF-8 text</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary btn-block btn-lg"
              onClick={handleUniversalExport}
              disabled={exportLoading}
            >
              {exportLoading ? "Generating File... ⏳" : `Download as ${exportFormat.toUpperCase()}`}
            </button>
          </div>
        </div>
      )}

      {/* Auth Modal (Sign In / Register) */}
      {showAuthModal && (
        <div className="modal-overlay" onClick={() => setShowAuthModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{authTab === "login" ? "Student Sign In" : "Create Student Account"}</h3>
              <button
                type="button"
                className="btn-close"
                onClick={() => setShowAuthModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="auth-tab-buttons">
              <button
                type="button"
                className={`auth-tab ${authTab === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("login");
                  setAuthError("");
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`auth-tab ${authTab === "register" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("register");
                  setAuthError("");
                }}
              >
                Create Account
              </button>
            </div>

            {authError && <div className="error-alert">{authError}</div>}

            <form onSubmit={handleAuthSubmit} className="auth-form">
              {authTab === "register" && (
                <div className="form-group">
                  <label>Full Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Alex Johnson"
                    value={authForm.name}
                    onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })}
                  />
                </div>
              )}

              <div className="form-group">
                <label>Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="student@university.edu"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={authForm.password}
                  onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={authLoading}
              >
                {authLoading
                  ? "Processing..."
                  : authTab === "login"
                  ? "Sign In to StudyMate"
                  : "Create Account"}
              </button>
            </form>

            <div className="guest-mode-note">
              <span>Want to try without an account? </span>
              <button
                type="button"
                className="btn-link"
                onClick={() => setShowAuthModal(false)}
              >
                Continue in Guest Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-container">
          <div className="footer-brand">
            <span className="footer-logo">🧠</span>
            <span className="footer-name">StudyMate AI</span>
            <span className="footer-tagline">— Intelligent Academic Study Suite</span>
          </div>
          <p className="footer-copyright">
            © {new Date().getFullYear()} StudyMate AI. All rights reserved. Built for students worldwide.
          </p>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}