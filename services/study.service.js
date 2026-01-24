import { extractTextFromRequest } from "../utils/extractText.js";
import { summarizeLargeText, generateChatTitle } from "./ai.service.js";
import { insertMessage } from "../repositories/message.repo.js";
import { getOrCreateChat } from "../repositories/chat.repo.js";

export async function handleMessage(req, res) {
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
                    error: "This PDF appears to be image-only or has no readable text."
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
        console.error("❌ handleMessage error:", err);
        res.status(500).json({ error: "Failed to process message" });
    }
}
