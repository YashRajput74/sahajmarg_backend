import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors({ origin: "http://localhost:5173" }));
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
            console.log(`⚙️ Summarizing chunk ${i + 1}/${chunks.length}...`);

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

        console.log({flashcards});
        res.json({ flashcards });
    } catch (err) {
        console.error("❌ Flashcard generation error:", err);
        res.status(500).json({ error: "Flashcard generation failed." });
    }
});


app.listen(5000, () =>
    console.log("✅ Backend running at http://localhost:5000")
);
