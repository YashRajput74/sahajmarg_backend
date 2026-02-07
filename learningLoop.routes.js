import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const router = express.Router();

const sessions = new Map();

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

router.post("/session", (req, res) => {
    const { topic } = req.body;

    if (!topic) {
        return res.status(400).json({ error: "topic required" });
    }

    const sessionId = crypto.randomUUID();

    sessions.set(sessionId, {
        sessionId,
        topic,
        teacherExplanation: "",
        userExplanation: "",
        studentFeedback: "",
        studentQuestion: "",
        status: "ON_TRACK"
    });

    res.json({ sessionId, topic });
});

router.post("/teacher/explain", async (req, res) => {
    const { sessionId, intent = "EXPLAIN", reason = "" } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    let systemPrompt = `
You are an expert teacher helping a student prepare for exams.

Topic: ${session.topic}
`;

    if (intent === "RE_EXPLAIN" && session.teacherExplanation) {
        systemPrompt += `
Previous explanation:
"${session.teacherExplanation}"

The student did NOT understand it.
Explain again using a simpler mental model.
Avoid repeating the same wording.
`;
    }

    if (intent === "REDIRECT") {
        systemPrompt += `
The student went off-topic.
Gently redirect them back to the core concept.
`;
    }

    if (reason) {
        systemPrompt += `
Reason for explanation:
${reason}
`;
    }

    systemPrompt += `
Rules:
- 3–5 sentences
- Exam-oriented
- Clear cause → effect
- No fluff
`;

    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: systemPrompt,
    });

    const explanation = resp.output_text || "Explanation unavailable.";

    session.teacherExplanation = explanation;

    res.json({ explanation });
});

router.post("/student/respond", (req, res) => {
    const { sessionId, explanation } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    session.userExplanation = explanation;

    res.json({ received: true });
});

router.post("/student/evaluate", async (req, res) => {
    const { sessionId } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `
You are a fellow student evaluating another student's explanation.

Topic: ${session.topic}

Teacher's explanation:
"${session.teacherExplanation}"

Student's explanation:
"${session.userExplanation}"

Evaluate and return ONLY valid JSON.

Schema:
{
  "status": "ON_TRACK | CONFUSED | OFF_TOPIC",
  "feedback": "string",
  "isOnTopic": boolean
}

Rules:
- CONFUSED if partially correct or missing key idea
- OFF_TOPIC if discussing unrelated concept
- Feedback should be encouraging and corrective
- One or two sentences only
- No markdown
    `,
    });

    let parsed;
    try {
        parsed = JSON.parse(
            resp.output_text
                ?.replace(/```json/i, "")
                .replace(/```/g, "")
                .trim()
        );
    } catch {
        return res.status(422).json({ error: "Invalid AI evaluation output" });
    }

    session.status = parsed.status;
    session.studentFeedback = parsed.feedback;

    res.json(parsed);
});

router.post("/teacher/feedback", (req, res) => {
    const { sessionId } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    let nextAction = "CONTINUE";

    if (session.status === "CONFUSED") {
        nextAction = "RE_EXPLAIN_SIMPLER";
    }

    if (session.status === "OFF_TOPIC") {
        nextAction = "REDIRECT_TO_CORE_CONCEPT";
    }

    res.json({
        nextAction,
        reason: session.studentFeedback,
    });
});

router.post("/student/question", async (req, res) => {
    const { sessionId } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "invalid session" });
    }

    const resp = await client.responses.create({
        model: "llama-3.1-8b-instant",
        input: `
You are a curious but helpful co-student.

Topic: ${session.topic}

Teacher's explanation:
"${session.teacherExplanation}"

Your task:
- Ask ONE clear question to test understanding
- The question should target a key concept
- Phrase it like a student, not a teacher
- No hints, no explanation

Return ONLY JSON.

Schema:
{
  "question": "string",
  "focus": "string"
}

Rules:
- Question must be answerable in 2–3 sentences
- Focus should be a short phrase like "mechanism", "reason", "comparison"
- No markdown
    `
    });

    let parsed;
    try {
        parsed = JSON.parse(
            resp.output_text
                ?.replace(/```json/i, "")
                .replace(/```/g, "")
                .trim()
        );
    } catch {
        return res.status(422).json({ error: "Invalid AI question output" });
    }

    session.studentQuestion = parsed.question;

    res.json(parsed);
});

export default router;
