import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import path from "path";
import { createRequire } from "module";
import learningLoopRoutes from "./learningLoop.routes.js";
import moodyAssistantRoutes from "./moodyAssistant.routes.js";
import conceptCanvasRoutes from "./conceptCanvas.routes.js";

dotenv.config();

const PORT = process.env.PORT || 5000;
const app = express();
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 5 * 1024 * 1024 }
});
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

app.use(cors({ origin: "*" }));

app.use(express.json({ limit: "10mb" }));

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getOrCreateChat({ userId, chatId, initialTitle }) {
    if (chatId) {
        const { data: existing } = await supabase
            .from("chats")
            .select("*")
            .eq("id", chatId)
            .single();
        if (existing) return existing;
    }

    const { data } = await supabase
        .from("chats")
        .insert({
            user_id: userId,
            title: initialTitle || "New Chat",
        })
        .select()
        .single();

    return data;
}

function safeParseJSON(text) {
    if (!text) return null;

    let out = text
        .replace(/```json/i, "")
        .replace(/```/g, "")
        .trim();

    try {
        return JSON.parse(out);
    } catch {
        return null;
    }
}

function chunkText(text, size = 1500) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

async function summarizeLargeText(text) {
    const chunks = chunkText(text).slice(0, 8);
    const summaries = [];

    for (const chunk of chunks) {
        const resp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `Summarize this part concisely:\n\n${chunk}`
        });
        summaries.push(resp.output_text || "");
    }

    const finalResp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `Combine these summaries into one concise summary:\n\n${summaries.join("\n")}`
    });

    return finalResp.output_text || "";
}

async function extractTextFromRequest(req) {
    if (req.file) {
        const buffer = fs.readFileSync(req.file.path);
        const ext = path.extname(req.file.originalname).toLowerCase();

        let text = "";

        if (ext === ".docx") {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value || "";
        }
        else if (ext === ".pdf") {
            const result = await pdfParse(buffer);
            text = (result.text || "").trim();

            if (!text || text.length < 30) {
                throw new Error("PDF_NO_TEXT");
            }
        }

        fs.unlinkSync(req.file.path);

        if (!text.trim() && req.body.text?.trim()) {
            return {
                text: req.body.text.trim(),
                displayText: `📄 ${req.file.originalname}`
            };
        }

        if (!text.trim()) {
            throw new Error("File contains no readable text");
        }

        return {
            text: text.trim(),
            displayText: `📄 ${req.file.originalname}`
        };
    }

    if (req.body.text?.trim()) {
        return {
            text: req.body.text.trim(),
            displayText: req.body.text.trim()
        };
    }

    throw new Error("No content provided");
}

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

async function generateChatTitle(text) {
    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `Generate a short, clear 4 to 6 word title for this topic:\n${text}`
    });

    return (
        resp.output_text
            ?.replace(/["\n]/g, "")
            .trim()
            .slice(0, 60)
        || "New Chat"
    );
}

async function fetchMessages(chatId) {
    const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });
    return data || [];
}

app.post("/message", upload.single("file"), async (req, res) => {
    try {
        const { userId, chatId } = req.body;
        if (!userId) {
            return res.status(401).json({ error: "userId required" });
        }

        let extracted;
        try {
            extracted = await extractTextFromRequest(req);
        } catch (err) {
            if (err.message === "PDF_NO_TEXT") {
                return res.status(400).json({
                    error: "This PDF appears to be image-only or has no readable text. Please upload a text-based PDF or DOCX file."
                });
            }

            return res.status(400).json({ error: "No content provided" });
        }

        const { text, displayText } = extracted;

        const summary = text.length > 2000
            ? await summarizeLargeText(text)
            : (await client.responses.create({
                model: "llama-3.1-8b-instant",
                input: `Summarize this text concisely:\n\n${text}`,
            })).output_text || "";

        const title = chatId ? undefined : await generateChatTitle(summary);

        console.log("FILE:", req.file);
        console.log("BODY:", req.body);

        const chat = await getOrCreateChat({
            userId,
            chatId,
            initialTitle: title,
        });

        const userMessage = await insertMessage({
            chat_id: chat.id,
            role: "user",
            input_text: displayText
        });

        const flashResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                You are a study assistant.

                Generate EXACTLY 5 flashcards from the following text.
                Return a *pure JSON array* with NO markdown and NO extra text.

                Each flashcard MUST be an object with ONLY these keys:
                {
                "question": "string",
                "answer": "string"
                }

                Text:
                ${summary}
            `
        });
        let flashcards = [];
        try {
            let out = (flashResp.output_text || "").replace(/```json/i, "").replace(/```/g, "").trim();
            const jsonMatch = out.match(/\[([\s\S]*)\]/);
            if (jsonMatch) out = `[${jsonMatch[1]}]`;
            flashcards = JSON.parse(out);
            flashcards = flashcards.map(card => ({
                id: crypto.randomUUID(),
                question: card.question,
                answer: card.answer
            }));
        } catch (e) {
            console.warn("Flashcards parse error", e);
        }

        const quizResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
            Create EXACTLY 5 multiple-choice questions from the following text.

            Return ONLY a JSON array.

            Each quiz object MUST have this EXACT shape:
            {
            "question": "string",
            "options": ["option A", "option B", "option C", "option D"],
            "answer": "option A"
            }

            Rules:
            - "answer" must be the FULL correct option text.
            - "options" must contain exactly 4 strings.
            - Do NOT use keys A/B/C/D. Only use the "options" array.
            - The "answer" MUST exactly match one option from the array.

            Text:
            ${summary}
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

        const assistantMessage = await insertMessage({
            chat_id: chat.id,
            role: "assistant",
            input_text: "Generated quiz and flashcards",
            summary,
            flashcards,
            quiz
        });

        if (chatId) {
            await supabase
                .from("chats")
                .update({
                    updated_at: new Date().toISOString()
                })
                .eq("id", chat.id);
        }
        else {
            await supabase
                .from("chats")
                .update({
                    updated_at: new Date().toISOString()
                })
                .eq("id", chat.id);
        }

        res.json({
            chatId: chat.id,
            title: chat.title,
            assistant: assistantMessage,
            userMessage,
        });

    } catch (err) {
        console.error("❌ /message error:", err);
        res.status(500).json({ error: "Failed to process message" });
    }
});

app.post("/message/guest", async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ error: "text required" });
        }

        const summaryResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `Summarize this text concisely:\n\n${text}`,
        });
        const summary = summaryResp.output_text || "";

        const flashResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
                You are a study assistant.

                Generate EXACTLY 5 flashcards from the following text.
                Return a *pure JSON array* with NO markdown and NO extra text.

                Each flashcard MUST be an object with ONLY these keys:
                {
                "question": "string",
                "answer": "string"
                }

                Text:
                ${text}
            `
        });
        let flashcards = [];
        try {
            let out = (flashResp.output_text || "").replace(/```json/i, "").replace(/```/g, "").trim();
            const jsonMatch = out.match(/\[([\s\S]*)\]/);
            if (jsonMatch) out = `[${jsonMatch[1]}]`;
            flashcards = JSON.parse(out);
            flashcards = flashcards.map(card => ({
                id: crypto.randomUUID(),
                question: card.question,
                answer: card.answer
            }));
        } catch (e) {
            console.warn("Flashcards parse error", e);
        }

        const quizResp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
            Create EXACTLY 5 multiple-choice questions from the following text.

            Return ONLY a JSON array.

            Each quiz object MUST have this EXACT shape:
            {
            "question": "string",
            "options": ["option A", "option B", "option C", "option D"],
            "answer": "option A"
            }

            Rules:
            - "answer" must be the FULL correct option text.
            - "options" must contain exactly 4 strings.
            - Do NOT use keys A/B/C/D. Only use the "options" array.
            - The "answer" MUST exactly match one option from the array.

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

        const title = await generateChatTitle(text);

        res.json({
            title,
            assistant: {
                summary,
                flashcards,
                quiz
            }
        });

    } catch (err) {
        console.error("❌ guest message error:", err);
        res.status(500).json({ error: "Guest message failed" });
    }
});

app.post("/claim-guest-chats", async (req, res) => {
    const { userId, guestChats } = req.body;

    if (!userId || !Array.isArray(guestChats)) {
        return res.status(400).json({ error: "invalid payload" });
    }

    for (const chat of guestChats) {
        const { data: newChat } = await supabase
            .from("chats")
            .insert({
                user_id: userId,
                title: chat.title || "New Chat"
            })
            .select()
            .single();

        for (const msg of chat.messages) {
            await supabase.from("messages").insert({
                chat_id: newChat.id,
                role: msg.role,
                input_text:
                    msg.input_text ??
                    msg.text ??
                    "Generated study materials",
                summary: msg.summary ?? null,
                flashcards: msg.flashcards ?? null,
                quiz: msg.quiz ?? null
            });
        }
    }

    res.json({ success: true });
});

app.post("/flashcards/save", async (req, res) => {
    try {
        const { userId, chatId, messageId, cardId } = req.body;

        if (!userId || !messageId || !cardId) {
            return res.status(400).json({ error: "Missing fields" });
        }

        const { error } = await supabase
            .from("saved_flashcard_cards")
            .insert({
                user_id: userId,
                chat_id: chatId,
                message_id: messageId,
                card_id: cardId
            });

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ error: "Card already saved" });
            }
            throw error;
        }

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Save flashcard error:", err);
        res.status(500).json({ error: "Failed to save flashcard" });
    }
});

app.post("/flowchart/nodes", async (req, res) => {
    try {
        const { topic, level = "beginner" } = req.body;

        if (!topic?.trim()) {
            return res.status(400).json({ error: "topic required" });
        }

        const resp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
You are a JSON generator.

Generate a flowchart structure for the topic:
"${topic}"

Return ONLY valid JSON.
NO markdown. NO explanations.

Schema:
{
  "root": {
    "id": "string",
    "title": "string",
    "label": "Root Concept"
  },
  "columns": [
    {
      "id": "string",
      "title": "string",
      "subtitle": "string",
      "nodes": [
        {
          "id": "string",
          "label": "string",
          "subtitle": "string"
        }
      ]
    }
  ]
}

This is a visual map, NOT a lesson.

Return ONLY valid JSON.
NO markdown. NO explanations.

Rules:
- Labels: short concept names (1–3 words)
- Subtitles: scope/category hints, NOT explanations
- Subtitles must NOT define the label
- IDs must be stable, lowercase
- Level: ${level}
Subtitles:
- Describe the category or scope
- NOT definitions
- NOT explanations
- 3–6 words
- No verbs like "explains", "handles", "manages"

If you cannot comply, return:
{ "error": "schema_violation" }
            `
        });

        const json = safeParseJSON(resp.output_text);

        if (!json || json.error) {
            return res.status(422).json({ error: "Invalid AI output" });
        }

        res.json(json);

    } catch (err) {
        console.error("❌ /flowchart/nodes error:", err);
        res.status(500).json({ error: "Failed to generate nodes" });
    }
});

app.post("/flowchart/tooltips", async (req, res) => {
    try {
        const { topic, nodes } = req.body;

        if (
            !topic ||
            !Array.isArray(nodes) ||
            nodes.length === 0 ||
            nodes.some(n => !n.id || !n.label)
        ) {
            return res.status(400).json({ error: "invalid payload" });
        }

        const resp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
You are a JSON generator.

Generate tooltips for the topic:
"${topic}"

Each tooltip corresponds to a node.

Purpose of tooltip:
- Add context
- NOT definitions
- NOT restating subtitle

Nodes:
${JSON.stringify(nodes, null, 2)}

Return ONLY valid JSON.
NO markdown. NO explanations.

Schema:
{
  "nodeId": {
    "heading": "string",
    "data": "string"
  }
}

IMPORTANT:
- The response MUST be a JSON OBJECT, not an array
- Do NOT use numeric keys
- Do NOT return a list
- Keys MUST be the provided node.id values
- Example of INVALID output:
  [
    { "heading": "...", "data": "..." }
  ]

Rules:
- Response MUST be a JSON OBJECT (not an array)
- Keys MUST exactly match the provided node.id values
- Do NOT use numeric keys like "0", "1", "2"
- One tooltip per node
- Short, beginner-friendly explanations
- No extra or missing keys
- Do NOT repeat label or subtitle wording
- Explain usage, importance, or intuition
- One short sentence per tooltip
            `
        });

        let parsed = safeParseJSON(resp.output_text);

        if (!parsed) {
            return res.status(422).json({ error: "Invalid AI output" });
        }

        if (Array.isArray(parsed)) {
            const fixed = {};
            nodes.forEach((node, index) => {
                if (parsed[index]) {
                    fixed[node.id] = parsed[index];
                }
            });
            parsed = fixed;
        }

        const ids = nodes.map(n => n.id);
        const missing = ids.filter(id => !parsed[id]);
        const extra = Object.keys(parsed).filter(id => !ids.includes(id));

        if (missing.length || extra.length) {
            return res.status(422).json({
                error: "tooltip_id_mismatch",
                missing,
                extra
            });
        }

        res.json(parsed);

    } catch (err) {
        console.error("❌ /flowchart/tooltips error:", err);
        res.status(500).json({ error: "Failed to generate tooltips" });
    }
});

app.post("/flowchart/overlay", async (req, res) => {
    try {
        const { topic, node, level = "beginner" } = req.body;

        if (
            !topic ||
            !node ||
            !node.id ||
            !node.label
        ) {
            return res.status(400).json({ error: "invalid payload" });
        }

        const resp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: `
You are a JSON generator.

Generate detailed overlay content.

Topic:
"${topic}"

Node:
Label: "${node.label}"
Subtitle: "${node.subtitle || ""}"

Level: ${level}

Return ONLY valid JSON.
NO markdown. NO explanations.

Schema:
{
  "meta": {
    "title": "string",
    "badge": "string",
    "topic": "string"
  },
  "sections": [
    {
      "type": "text",
      "heading": "string",
      "content": "string"
    },
    {
      "type": "notes",
      "heading": "My Reflections",
      "placeholder": "string"
    }
  ]
}

Teaching rules:
- Assume user already knows basics
- Go one level deeper than typical tutorials
- Use mental models or real-world analogies
- Avoid generic definitions
- Be precise, not verbose

Sections:
1. What it is (clear but not shallow)
2. Why it matters (real-world impact)
3. Example or mental model (concrete)
4. Notes section at end

Return ONLY valid JSON.
            `
        });

        const json = safeParseJSON(resp.output_text);

        if (!json) {
            return res.status(422).json({ error: "Invalid AI output" });
        }

        res.json(json);

    } catch (err) {
        console.error("❌ /flowchart/overlay error:", err);
        res.status(500).json({ error: "Failed to generate overlay" });
    }
});

app.get("/flashcards/saved/:userId", async (req, res) => {
    const { userId } = req.params;

    const { data, error } = await supabase
        .from("saved_flashcard_cards")
        .select(`
            card_id,
            chat_id,
            message_id,
            created_at,
            messages (
                flashcards,
                chat_id
            ),
            chats (
                title
            )
        `)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

    if (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to fetch saved cards" });
    }

    const cards = data.flatMap(row => {
        const cards = row.messages?.flashcards || [];
        const card = cards.find(c => c.id === row.card_id);
        if (!card) return [];
        return [{
            ...card,
            chatId: row.chat_id,
            chatTitle: row.chats?.title,
            savedAt: row.created_at
        }];
    });

    res.json(cards);
});

app.get("/chats/:userId", async (req, res) => {
    const { userId } = req.params;

    const { data, error } = await supabase
        .from("chats")
        .select("id, title, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

    if (error) return res.status(500).json({ error });

    res.json(data);
});

app.get("/messages/:chatId", async (req, res) => {
    const { chatId } = req.params;

    const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ error });

    res.json(data);
});

app.use("/learning-loop", learningLoopRoutes);

app.use("/learning", moodyAssistantRoutes);

app.use("/api", conceptCanvasRoutes);

app.delete("/chat/:chatId", async (req, res) => {
    const { chatId } = req.params;
    await supabase.from("messages").delete().eq("chat_id", chatId);
    await supabase.from("chats").delete().eq("id", chatId);

    res.json({ success: true });
});

app.delete("/flashcards/saved", async (req, res) => {
    try {
        const { userId, cardId, messageId } = req.body;

        if (!userId || !cardId || !messageId) {
            return res.status(400).json({ error: "Missing fields" });
        }

        const { error } = await supabase
            .from("saved_flashcard_cards")
            .delete()
            .eq("user_id", userId)
            .eq("card_id", cardId)
            .eq("message_id", messageId);

        if (error) throw error;

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Delete flashcard error:", err);
        res.status(500).json({ error: "Failed to delete flashcard" });
    }
});

app.delete("/flashcards/saved/chat/:chatId", async (req, res) => {
    try {
        const { chatId } = req.params;
        const { userId } = req.body;

        if (!userId || !chatId) {
            return res.status(400).json({ error: "Missing fields" });
        }

        const { error } = await supabase
            .from("saved_flashcard_cards")
            .delete()
            .eq("user_id", userId)
            .eq("chat_id", chatId);

        if (error) throw error;

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Delete chat flashcards error:", err);
        res.status(500).json({ error: "Failed to delete chat flashcards" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
