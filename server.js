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

async function getOrCreateChat(userId, chatId, initialTitle) {
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
        .insert({ user_id: userId, title: initialTitle || "New Chat" })
        .select()
        .single();
    return data;
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
        const { userId, chatId, text } = req.body;
        if (!userId) return res.status(401).json({ error: "userId required" });
        if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

        const chat = await getOrCreateChat(userId, chatId, text.slice(0, 50));

        const userMessage = await insertMessage({
            chat_id: chat.id,
            role: "user",
            input_text: text
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
        Create 5 useful flashcards (question-answer pairs) from the following text.
        ⚠️ Return ONLY a valid JSON array — no markdown, no explanations, no extra text.

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
        } catch (e) {
            console.warn("Flashcards parse error", e);
        }

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

        const assistantMessage = await insertMessage({
            chat_id: chat.id,
            role: "assistant",
            input_text: null,
            summary,
            flashcards,
            quiz
        });

        if (!chatId) {
            const newTitle = text.length > 50 ? text.slice(0, 50) + "..." : text;
            await supabase
                .from("chats")
                .update({
                    title: newTitle,
                    updated_at: new Date().toISOString()
                })
                .eq("id", chat.id);
        } else {
            await supabase
                .from("chats")
                .update({
                    updated_at: new Date().toISOString()
                })
                .eq("id", chat.id);
        }

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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
