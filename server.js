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

async function extractTextFromRequest(req) {
    if (req.file) {
        const buffer = fs.readFileSync(req.file.path);
        const ext = path.extname(req.file.originalname).toLowerCase();

        let text = "";

        if (ext === ".docx") {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        }
        else if (ext === ".pdf") {
            const result = await pdfParse(buffer);
            text = result.text;
        }
        else {
            fs.unlinkSync(req.file.path);
            throw new Error("Unsupported file type");
        }

        fs.unlinkSync(req.file.path);

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
        } catch {
            return res.status(400).json({ error: "No content provided" });
        }

        const { text, displayText } = extracted;

        const title = chatId ? undefined : await generateChatTitle(text);
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
