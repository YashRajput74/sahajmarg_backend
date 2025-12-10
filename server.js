/* import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const PORT = process.env.PORT || 5000;
const app = express();
const upload = multer({ dest: "uploads/" });
app.use(
    cors({
        origin: "*",
    })
);
app.use(express.json());

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

app.post("/summarize", upload.single("file"), async (req, res) => {
    try {
        let text = "";

        if (req.file) {
            const fileBuffer = fs.readFileSync(req.file.path);
            const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
            fs.unlinkSync(req.file.path);
            text = value;
        } else if (req.body.text) {
            text = req.body.text;
        } else {
            return res.status(400).json({ error: "No file or text provided." });
        }

        const chunkText = (str, size = 3000) => {
            const chunks = [];
            for (let i = 0; i < str.length; i += size) {
                chunks.push(str.slice(i, i + size));
            }
            return chunks;
        };

        const chunks = chunkText(text);
        const summaries = [];

        for (const [i, chunk] of chunks.entries()) {

            const response = await client.responses.create({
                model: "llama-3.1-8b-instant",
                input: `Summarize this text concisely:\n\n${chunk}`,
            });

            summaries.push(response.output_text || "");
        }

        const finalResponse = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `Combine and refine these summaries into one concise summary:\n\n${summaries.join(
                "\n\n"
            )}`,
        });

        const finalSummary = finalResponse.output_text || "No summary generated.";
        res.json({ summary: finalSummary });
    } catch (err) {
        console.error("❌ Summarization error:", err);
        res.status(500).json({ error: "Summarization failed." });
    }
});

app.post("/generate-flashcards", upload.single("file"), async (req, res) => {
    try {
        let text = "";

        if (req.file) {
            const fileBuffer = fs.readFileSync(req.file.path);
            const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
            fs.unlinkSync(req.file.path);
            text = value;
        } else if (req.body.text) {
            text = req.body.text;
        } else {
            return res.status(400).json({ error: "No file or text provided." });
        }

        const response = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                You are a study assistant.
                Create 5 useful flashcards (question-answer pairs) from the following text.
                ⚠️ Return ONLY a valid JSON array — no markdown, no explanations, no extra text.

                Example format:
                [
                  {"question": "What is X?", "answer": "X is ..."},
                  {"question": "Why does Y happen?", "answer": "Because ..."}
                ]

                Text:
                ${text}
            `,
        });

        const output = response.output_text;
        let flashcards = [];

        try {
            let cleaned = output
                .replace(/```json/i, "")
                .replace(/```/g, "")
                .replace(/^Here.*?:/i, "")
                .trim();

            const jsonMatch = cleaned.match(/\[([\s\S]*)\]/);
            if (jsonMatch) cleaned = `[${jsonMatch[1]}]`;

            flashcards = JSON.parse(cleaned);
        } catch (err) {
            console.warn("⚠️ Error parsing AI output:", err.message);
            console.log("Raw output was:", output);
        }
        console.log({ flashcards });
        res.json({ flashcards });
    } catch (err) {
        console.error("❌ Flashcard generation error:", err);
        res.status(500).json({ error: "Flashcard generation failed." });
    }
});

app.post("/generate-quiz", upload.single("file"), async (req, res) => {
    try {
        let text = "";

        if (req.file) {
            const fileBuffer = fs.readFileSync(req.file.path);
            const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
            fs.unlinkSync(req.file.path);
            text = value;
        } else if (req.body.text) {
            text = req.body.text;
        } else {
            return res.status(400).json({ error: "No file or text provided." });
        }

        const response = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                You are a helpful AI quiz maker.
                Create 5 multiple-choice quiz questions from the following text.
                Each question should have 4 options and one correct answer.

                ⚠️ Return ONLY a valid JSON array — no markdown, no commentary.

                Example format:
                [
                  {
                    "question": "What is the capital of France?",
                    "options": ["Paris", "London", "Berlin", "Madrid"],
                    "answer": "Paris"
                  },
                  {
                    "question": "Which element has the symbol H?",
                    "options": ["Helium", "Hydrogen", "Hafnium", "Holmium"],
                    "answer": "Hydrogen"
                  }
                ]

                Text:
                ${text}
            `,
        });

        const output = response.output_text;
        let quizzes = [];

        try {
            let cleaned = output
                .replace(/```json/i, "")
                .replace(/```/g, "")
                .replace(/^Here.*?:/i, "")
                .trim();

            const jsonMatch = cleaned.match(/\[([\s\S]*)\]/);
            if (jsonMatch) cleaned = `[${jsonMatch[1]}]`;

            quizzes = JSON.parse(cleaned);
        } catch (err) {
            console.warn("⚠️ Error parsing AI output:", err.message);
            console.log("Raw output was:", output);
        }

        res.json({ quizzes });
    } catch (err) {
        console.error("❌ Quiz generation error:", err);
        res.status(500).json({ error: "Quiz generation failed." });
    }
});


// ======== TOPIC-BASED SUMMARIZATION ========
app.post("/summarize-topic", async (req, res) => {
    try {
        const { topic } = req.body;
        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: "Topic name is required." });
        }

        const response = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `Provide a clear, concise, and educational summary about the topic "${topic}". 
            The summary should be informative, accurate, and easy to understand for a student.`,
        });

        const summary = response.output_text || "No summary generated.";
        res.json({ summary });
    } catch (err) {
        console.error("❌ Topic summarization error:", err);
        res.status(500).json({ error: "Failed to summarize topic." });
    }
});

app.post("/generate-flashcards-topic", async (req, res) => {
    try {
        const { topic } = req.body;
        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: "Topic name is required." });
        }

        const response = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                Create 5 helpful flashcards (question-answer pairs) about the topic "${topic}".
                ⚠️ Return ONLY a valid JSON array — no markdown or text.

                Example:
                [
                    {"question": "What is X?", "answer": "X is ..."},
                    {"question": "Why does Y happen?", "answer": "Because ..."}
                ]
            `,
        });

        let output = response.output_text;
        let flashcards = [];

        try {
            let cleaned = output
                .replace(/```json/i, "")
                .replace(/```/g, "")
                .replace(/^Here.*?:/i, "")
                .trim();

            const jsonMatch = cleaned.match(/\[([\s\S]*)\]/);
            if (jsonMatch) cleaned = `[${jsonMatch[1]}]`;

            flashcards = JSON.parse(cleaned);
        } catch (err) {
            console.warn("⚠️ JSON parse error (topic flashcards):", err.message);
            console.log("Raw output:", output);
        }

        res.json({ flashcards });
    } catch (err) {
        console.error("❌ Topic flashcards error:", err);
        res.status(500).json({ error: "Failed to generate flashcards." });
    }
});


app.post("/generate-quiz-topic", async (req, res) => {
    try {
        const { topic } = req.body;
        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: "Topic name is required." });
        }

        const response = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                Create 5 multiple-choice quiz questions about "${topic}".
                Each question should have 4 options and one correct answer.

                ⚠️ Return ONLY a valid JSON array — no markdown or commentary.

                Example:
                [
                    {
                        "question": "What is the capital of France?",
                        "options": ["Paris", "London", "Berlin", "Madrid"],
                        "answer": "Paris"
                    }
                ]
            `,
        });

        let output = response.output_text;
        let quizzes = [];

        try {
            let cleaned = output
                .replace(/```json/i, "")
                .replace(/```/g, "")
                .replace(/^Here.*?:/i, "")
                .trim();

            const jsonMatch = cleaned.match(/\[([\s\S]*)\]/);
            if (jsonMatch) cleaned = `[${jsonMatch[1]}]`;

            quizzes = JSON.parse(cleaned);
        } catch (err) {
            console.warn("⚠️ JSON parse error (topic quiz):", err.message);
            console.log("Raw output:", output);
        }

        res.json({ quizzes });
    } catch (err) {
        console.error("❌ Topic quiz error:", err);
        res.status(500).json({ error: "Failed to generate quiz." });
    }
});

app.listen(PORT, () => {
    console.log("✅ Server running on port " + PORT);
});
 */

// at top of server.js (after other imports)
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const PORT = process.env.PORT || 5000;
const app = express();
const upload = multer({ dest: "uploads/" });
app.use(
    cors({
        origin: "*",
    })
);
app.use(express.json());

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// helper: create or get chat
async function getOrCreateChat(userId, chatId, initialTitle) {
    if (chatId) {
        const { data: existing } = await supabase
            .from("chats")
            .select("*")
            .eq("id", chatId)
            .single();
        if (existing) return existing;
    }

    // create a new chat
    const { data } = await supabase
        .from("chats")
        .insert({ user_id: userId, title: initialTitle || "New Chat" })
        .select()
        .single();
    return data;
}

// helper: insert message
async function insertMessage({ chat_id, role, input_text, summary = null, flashcards = null, quiz = null }) {
    const { data } = await supabase
        .from("messages")
        .insert({
            chat_id,
            role,
            input_text,
            summary,
            flashcards,
            quiz
        })
        .select()
        .single();

    return data;
}

// helper: fetch messages for a chat
async function fetchMessages(chatId) {
    const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });
    return data || [];
}

app.post("/message", async (req, res) => {
    try {
        // YOU MUST authenticate the user on backend - here we assume frontend sends userId (or use supabase jwt)
        // Better: pass supabase auth token from frontend and verify; for now assume req.body.userId is present.
        const { userId, chatId, text } = req.body;
        if (!userId) return res.status(401).json({ error: "userId required" });
        if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

        // 1) ensure chat exists
        const chat = await getOrCreateChat(userId, chatId, text.slice(0, 50));

        // 2) save user message
        const userMessage = await insertMessage({
            chat_id: chat.id,
            role: "user",
            input_text: text
        });

        // optionally: return an ephemeral loading response immediately (if you want streaming)
        // For simplicity, we'll do synchronous AI calls and return the assistant result.

        // 3) call your existing AI summarizer/flashcards/quiz functions
        // reuse your existing logic: call the same client.responses.create with appropriate prompts.
        // I'll make minimal helper functions that use the same llama-3.1-8b-instant model

        // SUMMARY
        const summaryResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `Summarize this text concisely:\n\n${text}`,
        });
        const summary = summaryResp.output_text || "";

        // FLASHCARDS
        const flashResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
        You are a study assistant.
        Create 5 useful flashcards (question-answer pairs) from the following text.
        ⚠️ Return ONLY a valid JSON array — no markdown, no explanations, no extra text.

        Text:
        ${text}
      `
        });
        // parse flashcards safely (apply same cleaning you used)
        let flashcards = [];
        try {
            let out = (flashResp.output_text || "").replace(/```json/i, "").replace(/```/g, "").trim();
            const jsonMatch = out.match(/\[([\s\S]*)\]/);
            if (jsonMatch) out = `[${jsonMatch[1]}]`;
            flashcards = JSON.parse(out);
        } catch (e) {
            console.warn("Flashcards parse error", e);
        }

        // QUIZ
        const quizResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
        Create 5 multiple-choice quiz questions from the following text.
        Return ONLY a JSON array.

        Text:
        ${text}
      `
        });
        let quiz = [];
        try {
            let out = (quizResp.output_text || "").replace(/```json/i, "").replace(/```/g, "").trim();
            const jsonMatch = out.match(/\[([\s\S]*)\]/);
            if (jsonMatch) out = `[${jsonMatch[1]}]`;
            quiz = JSON.parse(out);
        } catch (e) {
            console.warn("Quiz parse error", e);
        }

        // 4) Save assistant message as ONE DB row
        const assistantMessage = await insertMessage({
            chat_id: chat.id,
            role: "assistant",
            input_text: null,
            summary,
            flashcards,
            quiz
        });

        // 5) Update chat title if it was "New Chat" or empty
        const newTitle = text.split(" ").slice(0, 7).join(" ");
        await supabase
            .from("chats")
            .update({ title: newTitle, updated_at: new Date().toISOString() })
            .eq("id", chat.id);

        // 6) Return the assistant message + chat id
        res.json({
            chatId: chat.id,
            assistant: assistantMessage,
            userMessage,
        });

    } catch (err) {
        console.error("❌ /message error:", err);
        res.status(500).json({ error: "Failed to process message" });
    }
});
