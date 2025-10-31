const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.post("/summarize", upload.single("file"), async (req, res) => {
    try {
        const fileBuffer = fs.readFileSync(req.file.path);
        const { value: text } = await mammoth.extractRawText({ buffer: fileBuffer });
        fs.unlinkSync(req.file.path); // cleanup

        // Helper to chunk text
        const chunkText = (str, size = 3000) => {
            const chunks = [];
            for (let i = 0; i < str.length; i += size) {
                chunks.push(str.slice(i, i + size));
            }
            return chunks;
        };

        const chunks = chunkText(text);
        console.log(`📄 Splitting into ${chunks.length} chunks for summarization.`);

        const summaries = [];

        // Summarize each chunk sequentially
        for (const [index, chunk] of chunks.entries()) {
            console.log(`⚙️ Summarizing chunk ${index + 1}/${chunks.length}`);
            const response = await axios.post(
                "https://api.x.ai/v1/summarize",
                { prompt: `Summarize this part of a document:\n\n${chunk}` },
                { headers: { Authorization: `Bearer ${process.env.GROK_API_KEY}` } }
            );
            summaries.push(response.data.summary || "");
        }

        // Now combine partial summaries into one final summary
        const finalPrompt = `Combine and condense these section summaries into one cohesive, concise summary:\n\n${summaries.join(
            "\n\n"
        )}`;

        const finalResponse = await axios.post(
            "https://api.x.ai/v1/summarize",
            { prompt: finalPrompt },
            { headers: { Authorization: `Bearer ${process.env.GROK_API_KEY}` } }
        );

        res.json({
            summary: finalResponse.data.summary || "No summary generated.",
        });
    } catch (error) {
        console.error("❌ Summarization error:", error.message);
        res.status(500).json({ error: "Failed to summarize the document." });
    }
});

app.listen(5000, () => console.log("✅ Backend running at http://localhost:5000"));
