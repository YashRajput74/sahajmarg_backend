import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const router = express.Router();

/**
 * In-memory session store (MVP / demo)
 * sessionId -> { topic, mood }
 */
const sessions = new Map();

/**
 * Groq (OpenAI-compatible) client
 */
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

router.post("/misconception/session", (req, res) => {
    const { topic } = req.body;

    if (!topic?.trim()) {
        return res.status(400).json({ error: "topic required" });
    }

    const sessionId = crypto.randomUUID();

    sessions.set(sessionId, {
        sessionId,
        topic,
        mood: "NEUTRAL",
    });

    res.json({ sessionId, topic });
});

router.post("/misconception/list", async (req, res) => {
    const { topic, count = 6 } = req.body;

    if (!topic?.trim()) {
        return res.status(400).json({ error: "topic required" });
    }

    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `
You are an expert educator.

Topic: "${topic}"

Generate ${count} common misconceptions students have about this topic.

Return ONLY valid JSON.

Schema:
[
  {
    "id": "string",
    "statement": "string",
    "correctAnswer": "True | False",
    "explanation": "string"
  }
]

Rules:
- Statements must sound plausible to students
- Avoid trivial or silly misconceptions
- Explanation should be 1–2 sentences
- No markdown
- No extra text
    `,
    });

    let parsed;
    try {
        parsed = JSON.parse(
            resp.output_text.replace(/```json|```/g, "").trim()
        );
    } catch {
        return res.status(422).json({ error: "Invalid AI output" });
    }

    const myths = parsed.map((m, i) => ({
        id: m.id || `myth_${i + 1}`,
        ...m,
    }));

    res.json({ topic, myths });
});


router.post("/misconception/evaluate", async (req, res) => {
    const {
        sessionId,
        myth,
        userAnswer,
        explanation = "",
        didExplain = false,
    } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    if (!myth?.statement || !myth?.correctAnswer) {
        return res.status(400).json({ error: "invalid myth payload" });
    }

    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `
You are a patient, emotionally expressive tutor.

Topic: ${session.topic}

Misconception:
"${myth.statement}"

Correct answer:
"${myth.correctAnswer}"

User selected:
"${userAnswer}"

Did the user explain their choice?
${didExplain ? "Yes" : "No"}

User explanation:
"${explanation}"

Evaluate and return ONLY valid JSON.

Schema:
{
  "isCorrect": boolean,
  "explanationQuality": "NONE | WEAK | GOOD",
  "mood": "IMPRESSED | HAPPY | SAD | GRUMPY",
  "response": "string"
}

Rules:
- If correct AND didExplain AND explanation GOOD → IMPRESSED
- If correct AND didExplain BUT explanation WEAK → HAPPY
- If correct AND NOT didExplain → HAPPY
- If incorrect AND didExplain → SAD
- If incorrect AND NOT didExplain → GRUMPY
- Response tone must match mood
- Be kind, never sarcastic
- 2–3 sentences max
- No markdown
    `,
    });

    let parsed;
    try {
        parsed = JSON.parse(
            resp.output_text.replace(/```json|```/g, "").trim()
        );
    } catch {
        return res.status(422).json({ error: "Invalid AI output" });
    }

    if (!parsed.mood || !parsed.response) {
        return res.status(422).json({ error: "Incomplete AI output" });
    }

    session.mood = parsed.mood;

    res.json(parsed);
});

export default router;
