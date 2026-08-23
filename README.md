# StudyMate AI 🎓✨

StudyMate AI is an intelligent AI-powered study assistant designed to summarize study materials, parse documents, and provide instant Q&A using generative AI models.

## 🚀 Features

- **Document Parsing**: Upload PDFs and study notes for quick analysis.
- **AI Summary & Q&A**: Powered by Google Gemini AI & Groq APIs.
- **Modern Full-Stack Architecture**: React (Vite) frontend with Express Node.js backend.

## 🛠️ Project Structure

```
studymate-ai/
├── backend/    # Express server, API routes, PDF parser & AI integrations
└── frontend/   # React + Vite application interface
```

## ⚙️ Getting Started

### Prerequisites
- Node.js (v18+)
- npm or yarn

### 1. Backend Setup
```bash
cd backend
npm install
# Create a .env file with your API keys:
# GEMINI_API_KEY=your_key
# GROQ_API_KEY=your_key
# PORT=5000
npm run dev
```

### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

## 📝 License
ISC
