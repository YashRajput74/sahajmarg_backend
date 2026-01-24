import crypto from "crypto";
import client from "../lib/groq.js";

function chunkText(text, size = 1500) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

export async function summarizeLargeText(text) {
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

export async function generateChatTitle(text) {
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
