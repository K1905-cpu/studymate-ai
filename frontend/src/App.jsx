import { useState } from "react";
import axios from "axios";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { saveAs } from "file-saver";

const API_BASE_URL = "http://localhost:5000";

export default function App() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("Hindi");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);

  function handleFileChange(e) {
    setFile(e.target.files[0]);
    setError("");
    setNotes(null);
    setTranscript("");
    setTranslatedText("");
  }

  async function handleUpload() {
    if (!file) {
      setError("Please select a file first.");
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
      setTranscript(response.data.transcript);
    } catch (err) {
      setError(err.response?.data?.error || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function getNotesAsText() {
    if (!notes) return "";

    return `
${notes.title || "Study Notes"}

SUMMARY
${notes.summary || ""}

KEY POINTS
${notes.keyPoints?.map((p, i) => `${i + 1}. ${p}`).join("\n") || ""}

ACTION ITEMS
${notes.actionItems?.map((p, i) => `${i + 1}. ${p}`).join("\n") || ""}

FLASHCARDS
${
  notes.flashcards
    ?.map((card, i) => `${i + 1}. Q: ${card.question}\nA: ${card.answer}`)
    .join("\n\n") || ""
}

QUIZ
${
  notes.quiz
    ?.map(
      (q, i) =>
        `${i + 1}. ${q.question}\nOptions: ${q.options?.join(", ")}\nAnswer: ${
          q.answer
        }`
    )
    .join("\n\n") || ""
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

      setTranslatedText(response.data.translatedText);
    } catch (err) {
      setError("Translation failed.");
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

          {error && <p className="error">{error}</p>}
        </section>

        {notes && (
          <section className="results">
            <div className="card">
              <h2>{notes.title}</h2>

              <h3>Summary</h3>
              <p>{notes.summary}</p>
            </div>

            <div className="grid">
              <div className="card">
                <h3>Important Points</h3>
                <ul>
                  {notes.keyPoints?.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </div>

              <div className="card">
                <h3>Action Items</h3>
                <ul>
                  {notes.actionItems?.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card">
              <h3>Revision Flashcards</h3>

              <div className="flashcard-grid">
                {notes.flashcards?.map((card, index) => (
                  <div className="flashcard" key={index}>
                    <strong>Q: {card.question}</strong>
                    <p>A: {card.answer}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>Quiz Questions</h3>

              {notes.quiz?.map((q, index) => (
                <div className="quiz" key={index}>
                  <strong>
                    {index + 1}. {q.question}
                  </strong>

                  <ul>
                    {q.options?.map((option, idx) => (
                      <li key={idx}>{option}</li>
                    ))}
                  </ul>

                  <p>
                    <b>Answer:</b> {q.answer}
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

            {translatedText && (
              <div className="card">
                <h3>Translated Notes</h3>
                <pre>{translatedText}</pre>
              </div>
            )}

            <details className="card">
              <summary>View Transcript</summary>
              <pre>{transcript}</pre>
            </details>
          </section>
        )}
      </main>
    </div>
  );
}