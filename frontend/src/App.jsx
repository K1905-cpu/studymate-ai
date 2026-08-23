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

function MainApp() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("Hindi");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);

  const MAX_FILE_SIZE_MB = 4.5;

  function handleFileChange(e) {
    const selectedFile = e.target.files[0];
    setFile(selectedFile);
    setError("");
    setNotes(null);
    setTranscript("");
    setTranslatedText("");

    if (selectedFile) {
      const fileSizeMB = selectedFile.size / (1024 * 1024);
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        setError(
          `File size is ${fileSizeMB.toFixed(1)} MB. Vercel serverless limits file uploads to 4.5 MB per file. Please select a file under 4.5 MB.`
        );
      }
    }
  }

  async function handleUpload() {
    if (!file) {
      setError("Please select a file first.");
      return;
    }

    const fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      setError(
        `File size is ${fileSizeMB.toFixed(1)} MB. Vercel serverless limits file uploads to 4.5 MB per file. Please select a file under 4.5 MB.`
      );
      return;
    }

    try {
      setLoading(true);
      setError("");

      const formData = new FormData();
      formData.append("file", file);

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
    } catch (err) {
      setError(renderSafe(err.response?.data?.error || err.message || "Something went wrong."));
    } finally {
      setLoading(false);
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

      setTranslatedText(renderSafe(response.data.translatedText));
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
            key points, flashcards, quizzes, and translated notes.
          </p>
        </div>
      </header>

      <main className="container">
        <section className="card upload-card">
          <h2>Upload Lecture File</h2>
          <p className="muted">Supported: audio, video, PDF, TXT</p>

          <input type="file" onChange={handleFileChange} />

          {file && <p className="file-name">Selected: {file.name}</p>}

          <button onClick={handleUpload} disabled={loading}>
            {loading ? "Generating Notes..." : "Generate Study Notes"}
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