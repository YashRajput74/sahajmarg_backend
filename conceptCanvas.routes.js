import express from "express";
import OpenAI from "openai";

const router = express.Router();

/**
 * Groq (OpenAI-compatible) client
 */
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Generate Concept Canvas using AI
 * POST /api/revision/canvas
 */
router.post("/revision/canvas", async (req, res) => {
    const { topic } = req.body;

    if (!topic?.trim()) {
        return res.status(400).json({ error: "topic required" });
    }

    const prompt = `
You are an expert educator and curriculum designer.

Topic: "${topic}"

Your task:
Generate a Concept Revision Canvas to test understanding of the topic.

Return ONLY valid JSON.

Schema:
{
  "topic": "string",
  "title": "string",
  "activities": [
    {
      "id": "string",
      "type": "match | reorder | select | fill | checkbox",
      "title": "string",
      "question": "string",

      // match
      "items"?: [{ "label": "string", "correct": "string" }],
      "options"?: ["string"],

      // reorder
      "correctOrder"?: ["string"],

      // select / checkbox
      "correct"?: ["string"] | "string"
    }
  ]
}

Rules:
- Generate EXACTLY 5 activities
- Use each type at most once
- Difficulty: exam-oriented, not trivial
- Options must include plausible distractors
- Fill activity must have exactly 2 blanks
- Use short, clear wording
- No markdown
- No explanation text outside JSON
- Do NOT repeat items
- Do NOT invent extra fields
- Always use "correct" for answers
- For reorder, all items must be unique
- For match activities, include an "options" array with all possible matches
- For checkbox activities, "correct" MUST be an array of strings
- Avoid ambiguous or trick statements

`;

    let resp;
    try {
        resp = await client.responses.create({
            model: "llama-3.1-8b-instant",
            input: prompt,
        });
    } catch (err) {
        return res.status(500).json({ error: "AI request failed" });
    }

    let parsed;
    try {
        parsed = JSON.parse(
            resp.output_text
                ?.replace(/```json/i, "")
                .replace(/```/g, "")
                .trim()
        );
    } catch {
        return res.status(422).json({
            error: "Invalid AI output",
            raw: resp.output_text,
        });
    }

    // Minimal structural validation (MVP-safe)
    if (
        !parsed.topic ||
        !parsed.title ||
        !Array.isArray(parsed.activities)
    ) {
        return res.status(422).json({
            error: "Incomplete canvas structure",
            parsed,
        });
    }

    res.json(parsed);
});

export default router;
