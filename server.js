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

// Initialize Groq API client
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

app.post("/summarize", upload.single("file"), async (req, res) => {
    try {
        let text = "";

        // 1️⃣ Get text from DOCX or plain text
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

        // 2️⃣ Split large text into chunks
        const chunkText = (str, size = 3000) => {
            const chunks = [];
            for (let i = 0; i < str.length; i += size) {
                chunks.push(str.slice(i, i + size));
            }
            return chunks;
        };

        const chunks = chunkText(text);
        const summaries = [];

        // 3️⃣ Summarize each chunk using Groq API
        for (const [i, chunk] of chunks.entries()) {
            console.log(`⚙️ Summarizing chunk ${i + 1}/${chunks.length}...`);

            const response = await client.responses.create({
                model: "llama-3.1-8b-instant", // you can change to another model if needed
                input: `Summarize this text concisely:\n\n${chunk}`,
            });

            summaries.push(response.output_text || "");
        }

        // 4️⃣ Combine all summaries into a final one
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

app.listen(5000, () =>
    console.log("✅ Backend running at http://localhost:5000")
);
