import { useState, Component } from "react";
import axios from "axios";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { saveAs } from "file-saver";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

function renderSafe(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (typeof val === "object") {
    return val.message || val.text || val.error || JSON.stringify(val);
  }
  return String(val);
}

function cleanChatText(val) {
  const safe = renderSafe(val);
  let cleaned = safe
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<reasoning>[\s\S]*/gi, "")
    .trim();
  return cleaned;
}

function renderInlineFormatting(text) {
  if (typeof text !== "string") return text;
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function FormattedText({ content }) {
  const clean = cleanChatText(content);
  if (!clean) return null;

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

    // Check for Markdown Table (lines starting with |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rowStr = lines[i].trim();
        // Ignore table separator row |---|---|
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
          .map((cell) => cell.trim());

        const bodyRows = tableLines.slice(1).map((row) =>
          row
            .split("|")
            .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
            .map((cell) => cell.trim())
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

    // Check for Bullet / List Item
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
        <ul key={`ul-${i}`} style={{ margin: "8px 0", paddingLeft: "20px" }}>
          {listItems}
        </ul>
      );
      continue;
    }

    // Headers (# or **Header:**)
    if (trimmed.startsWith("###") || trimmed.startsWith("##") || trimmed.startsWith("#")) {
      const headerText = trimmed.replace(/^#+\s*/, "");
      blocks.push(
        <h4 key={`h-${i}`} style={{ margin: "12px 0 6px 0", color: "#1e293b", fontSize: "15px", fontWeight: "700" }}>
          {renderInlineFormatting(headerText)}
        </h4>
      );
      i++;
      continue;
    }

    // Regular Paragraph
    blocks.push(
      <p key={`p-${i}`} style={{ margin: "4px 0 8px 0", lineHeight: "1.5" }}>
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
    console.error("Uncaught UI Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: "center", fontFamily: "sans-serif" }}>
          <h2>Something went wrong displaying results.</h2>
          <p style={{ color: "red" }}>{renderSafe(this.state.error?.message || this.state.error)}</p>
          <button
            style={{ padding: "10px 20px", marginTop: 20, cursor: "pointer" }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function encodeFastWav(audioBuffer, maxSizeBytes = 4.1 * 1024 * 1024) {
  const targetSampleRate = 8000;
  const numChannels = 1;

  let inputData = audioBuffer.getChannelData(0);
  if (audioBuffer.numberOfChannels > 1) {
    const channel2 = audioBuffer.getChannelData(1);
    const len = audioBuffer.length;
    const mix = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      mix[i] = (inputData[i] + channel2[i]) * 0.5;
    }
    inputData = mix;
  }

  const step = Math.max(1, Math.floor(audioBuffer.sampleRate / targetSampleRate));
  let newLength = Math.floor(inputData.length / step);

  const maxSamples = Math.floor(maxSizeBytes - 44);
  if (newLength > maxSamples) {
    newLength = maxSamples;
  }

  const wavBuffer = new ArrayBuffer(44 + newLength);
  const view = new DataView(wavBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + newLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, newLength, true);

  const pcmBytes = new Uint8Array(wavBuffer, 44);
  for (let i = 0; i < newLength; i++) {
    const sample = inputData[i * step];
    const normalized = sample < -1 ? -1 : (sample > 1 ? 1 : sample);
    pcmBytes[i] = (normalized + 1) * 127.5 | 0;
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function MainApp() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [notes, setNotes] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("Hindi");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);

  // Chatbot State
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const MAX_FILE_SIZE_MB = 4.4;
  const ALLOWED_EXT = [".pdf", ".txt", ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm", ".mkv"];

  function isVideoFile(f) {
    if (!f) return false;
    const name = f.name.toLowerCase();
    const type = f.type.toLowerCase();
    return (
      type.startsWith("video/") ||
      name.endsWith(".mp4") ||
      name.endsWith(".mov") ||
      name.endsWith(".webm") ||
      name.endsWith(".mkv")
    );
  }

  function handleFileChange(e) {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    const ext = "." + selectedFile.name.split(".").pop().toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setError(`Unsupported file type (${ext}). Please select an Audio file (.mp3, .wav, .m4a), Video file (.mp4, .mov, .webm), PDF (.pdf), or Text (.txt) file.`);
      setFile(null);
      setNotes(null);
      setTranscript("");
      setTranslatedText("");
      setChatMessages([]);
      return;
    }

    setLoading(false);
    setCompressing(false);
    setFile(selectedFile);
    setError("");
    setNotes(null);
    setTranscript("");
    setTranslatedText("");
    setChatMessages([]);
  }

  async function compressVideoFile(originalFile) {
    if (!isVideoFile(originalFile) && originalFile.size <= MAX_FILE_SIZE_MB * 1024 * 1024) {
      return originalFile;
    }

    try {
      setCompressing(true);
      const arrayBuffer = await originalFile.arrayBuffer();
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const wavBlob = encodeFastWav(audioBuffer, 4.1 * 1024 * 1024);
      
      const newName = originalFile.name.replace(/\.[^/.]+$/, "") + "-compressed.wav";
      const compressedFile = new File([wavBlob], newName, { type: "audio/wav" });
      audioContext.close();
      return compressedFile;
    } catch (err) {
      console.warn("Fast audio extraction failed, using original file:", err);
      return originalFile;
    } finally {
      setCompressing(false);
    }
  }

  async function handleUpload() {
    if (!file) {
      setError("Please select a valid file first.");
      return;
    }

    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setError(`Unsupported file type (${ext}). Please upload an Audio (.mp3, .wav, .m4a), Video (.mp4, .mov, .webm), PDF (.pdf), or Text (.txt) file.`);
      return;
    }

    try {
      setLoading(true);
      setError("");

      let fileToUpload = file;
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024 || isVideoFile(file)) {
        fileToUpload = await compressVideoFile(file);
      }

      const fileSizeMB = fileToUpload.size / (1024 * 1024);
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        setError(
          `File size (${fileSizeMB.toFixed(1)} MB) is too large. Please select a shorter clip under 15 minutes.`
        );
        setLoading(false);
        return;
      }

      const formData = new FormData();
      formData.append("file", fileToUpload);

      const response = await axios.post(
        `${API_BASE_URL}/api/process-file`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );

      setNotes(response.data.notes);
      setTranscript(renderSafe(response.data.transcript));
      setChatMessages([
        {
          role: "assistant",
          content: "Hi! I am your StudyMate AI Tutor. Ask me any question about your lecture notes, or click a suggestion chip below to generate more flashcards, quizzes, or key points!",
        },
      ]);
    } catch (err) {
      setError(renderSafe(err.response?.data?.error || err.message || "Something went wrong."));
    } finally {
      setLoading(false);
    }
  }

  async function handleSendChat(customMessage) {
    const textToSend = customMessage || chatInput;
    if (!textToSend || !textToSend.trim() || chatLoading) return;

    const userMsg = { role: "user", content: textToSend.trim() };
    const updatedHistory = [...chatMessages, userMsg];
    setChatMessages(updatedHistory);
    if (!customMessage) setChatInput("");
    setChatLoading(true);

    try {
      const response = await axios.post(`${API_BASE_URL}/api/chat`, {
        message: textToSend,
        transcript,
        notes,
        chatHistory: updatedHistory,
      });

      const assistantMsg = {
        role: "assistant",
        content: cleanChatText(response.data.reply),
      };
      setChatMessages([...updatedHistory, assistantMsg]);
    } catch (err) {
      const errorMsg = {
        role: "assistant",
        content: cleanChatText(err.response?.data?.error || "Failed to get chatbot response. Please try again."),
      };
      setChatMessages([...updatedHistory, errorMsg]);
    } finally {
      setChatLoading(false);
    }
  }

  function getNotesAsText() {
    if (!notes) return "";

    return `
${renderSafe(notes.title) || "Study Notes"}

SUMMARY
${renderSafe(notes.summary)}

KEY POINTS
${Array.isArray(notes.keyPoints) ? notes.keyPoints.map((p, i) => `${i + 1}. ${renderSafe(p)}`).join("\n") : ""}

ACTION ITEMS
${Array.isArray(notes.actionItems) ? notes.actionItems.map((p, i) => `${i + 1}. ${renderSafe(p)}`).join("\n") : ""}

FLASHCARDS
${
  Array.isArray(notes.flashcards)
    ? notes.flashcards
        .map((card, i) => `${i + 1}. Q: ${renderSafe(card?.question)}\nA: ${renderSafe(card?.answer)}`)
        .join("\n\n")
    : ""
}

QUIZ
${
  Array.isArray(notes.quiz)
    ? notes.quiz
        .map(
          (q, i) =>
            `${i + 1}. ${renderSafe(q?.question)}\nOptions: ${
              Array.isArray(q?.options) ? q.options.map(renderSafe).join(", ") : ""
            }\nAnswer: ${renderSafe(q?.answer)}`
        )
        .join("\n\n")
    : ""
}
`;
  }

  async function handleTranslate() {
    if (!notes) return;

    try {
      setTranslating(true);
      setError("");

      const response = await axios.post(`${API_BASE_URL}/api/translate`, {
        text: getNotesAsText(),
        language,
      });

      setTranslatedText(cleanChatText(response.data.translatedText));
    } catch (err) {
      setError(renderSafe(err.response?.data?.error || err.message || "Translation failed."));
    } finally {
      setTranslating(false);
    }
  }

  async function downloadWord() {
    if (!notes) return;

    const text = translatedText || getNotesAsText();

    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: "StudyMate AI Notes",
                  bold: true,
                  size: 32,
                }),
              ],
            }),

            new Paragraph(""),

            ...text.split("\n").map(
              (line) =>
                new Paragraph({
                  children: [
                    new TextRun({
                      text: line,
                      size: 24,
                    }),
                  ],
                })
            ),
          ],
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, "studymate-notes.docx");
  }

  const displayTranscript = renderSafe(transcript);
  const displayTranslation = renderSafe(translatedText);

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="badge">AI Study Assistant</p>
          <h1>StudyMate AI</h1>
          <p>
            Upload lecture audio, video, PDF, or text and get instant summaries,
            key points, flashcards, quizzes, interactive AI chat, and translated notes.
          </p>
        </div>
      </header>

      <main className="container">
        <section className="card upload-card">
          <h2>Upload Lecture File</h2>
          <p className="muted">Supported: audio, video, PDF, TXT (Auto-compresses large files)</p>

          <input
            type="file"
            onChange={handleFileChange}
            disabled={loading || compressing}
          />

          {file && (
            <p className="file-name">
              Selected: {file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)
            </p>
          )}

          <button onClick={handleUpload} disabled={loading || compressing || !file}>
            {compressing
              ? "Compressing Audio... 🎵"
              : loading
              ? "Generating Notes... 🧠"
              : "Generate Study Notes"}
          </button>

          {error && <p className="error">{renderSafe(error)}</p>}
        </section>

        {notes && (
          <section className="results">
            <div className="card">
              <h2>{renderSafe(notes.title) || "Study Notes"}</h2>

              <h3>Summary</h3>
              <p>{renderSafe(notes.summary)}</p>
            </div>

            <div className="grid">
              <div className="card">
                <h3>Important Points</h3>
                <ul>
                  {Array.isArray(notes.keyPoints) &&
                    notes.keyPoints.map((point, index) => (
                      <li key={index}>{renderSafe(point)}</li>
                    ))}
                </ul>
              </div>

              <div className="card">
                <h3>Action Items</h3>
                <ul>
                  {Array.isArray(notes.actionItems) &&
                    notes.actionItems.map((item, index) => (
                      <li key={index}>{renderSafe(item)}</li>
                    ))}
                </ul>
              </div>
            </div>

            <div className="card">
              <h3>Revision Flashcards</h3>

              <div className="flashcard-grid">
                {Array.isArray(notes.flashcards) &&
                  notes.flashcards.map((card, index) => (
                    <div className="flashcard" key={index}>
                      <strong>Q: {renderSafe(card?.question)}</strong>
                      <p>A: {renderSafe(card?.answer)}</p>
                    </div>
                  ))}
              </div>
            </div>

            <div className="card">
              <h3>Quiz Questions</h3>

              {Array.isArray(notes.quiz) &&
                notes.quiz.map((q, index) => (
                  <div className="quiz" key={index}>
                    <strong>
                      {index + 1}. {renderSafe(q?.question)}
                    </strong>

                    <ul>
                      {Array.isArray(q?.options) &&
                        q.options.map((option, idx) => (
                          <li key={idx}>{renderSafe(option)}</li>
                        ))}
                    </ul>

                    <p>
                      <b>Answer:</b> {renderSafe(q?.answer)}
                    </p>
                  </div>
                ))}
            </div>

            {/* AI Study Chatbot Component */}
            <div className="card chatbot-card">
              <div className="chatbot-header">
                <h3>💬 StudyMate AI Chatbot</h3>
                <span className="chat-badge">Live Tutor</span>
              </div>
              <p className="muted" style={{ marginBottom: 12 }}>
                Ask questions about this lecture or click a chip below to generate more study materials!
              </p>

              <div className="chip-container">
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => handleSendChat("Generate 3 more Flashcards")}
                  disabled={chatLoading}
                >
                  💡 Generate 3 more Flashcards
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => handleSendChat("Create 5 extra Quiz Questions with answer options")}
                  disabled={chatLoading}
                >
                  ❓ Create 5 extra Quiz Questions
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => handleSendChat("Summarize key formulas, definitions, and core concepts")}
                  disabled={chatLoading}
                >
                  📌 Key Formulas & Definitions
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => handleSendChat("Explain the main topic in simple terms for beginners")}
                  disabled={chatLoading}
                >
                  📝 Explain Simply
                </button>
              </div>

              <div className="chat-history">
                {chatMessages.map((msg, index) => (
                  <div key={index} className={`chat-message ${msg.role}`}>
                    <div className="message-sender">
                      {msg.role === "user" ? "You" : "StudyMate AI"}
                    </div>
                    <div className="message-bubble">
                      <FormattedText content={msg.content} />
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-message assistant">
                    <div className="message-sender">StudyMate AI</div>
                    <div className="message-bubble">Thinking... 🧠✨</div>
                  </div>
                )}
              </div>

              <form
                className="chat-input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendChat();
                }}
              >
                <input
                  type="text"
                  className="chat-input"
                  placeholder="Ask a question or request more study notes..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatLoading}
                />
                <button type="submit" disabled={chatLoading || !chatInput.trim()}>
                  {chatLoading ? "Sending..." : "Send"}
                </button>
              </form>
            </div>

            <div className="card actions">
              <h3>Translate / Download</h3>

              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="Hindi">Hindi</option>
                <option value="Gujarati">Gujarati</option>
                <option value="Tamil">Tamil</option>
                <option value="Telugu">Telugu</option>
                <option value="Kannada">Kannada</option>
                <option value="Malayalam">Malayalam</option>
                <option value="Marathi">Marathi</option>
                <option value="Bengali">Bengali</option>
                <option value="Spanish">Spanish</option>
                <option value="French">French</option>
              </select>

              <button onClick={handleTranslate} disabled={translating}>
                {translating ? "Translating..." : "Translate Notes"}
              </button>

              <button onClick={downloadWord}>Download Word</button>
            </div>

            {displayTranslation && (
              <div className="card">
                <h3>Translated Notes</h3>
                <pre>{displayTranslation}</pre>
              </div>
            )}

            <details className="card">
              <summary>View Transcript</summary>
              <pre>{displayTranscript}</pre>
            </details>
          </section>
        )}
      </main>
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