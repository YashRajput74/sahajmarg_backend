import fs from "fs";
import path from "path";
import mammoth from "mammoth";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function extractTextFromRequest(req) {
    if (req.file) {
        const buffer = fs.readFileSync(req.file.path);
        const ext = path.extname(req.file.originalname).toLowerCase();

        let text = "";

        if (ext === ".docx") {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value || "";
        }
        else if (ext === ".pdf") {
            const result = await pdfParse(buffer);
            text = (result.text || "").trim();

            if (!text || text.length < 30) {
                throw new Error("PDF_NO_TEXT");
            }
        }

        fs.unlinkSync(req.file.path);

        if (!text.trim() && req.body.text?.trim()) {
            return {
                text: req.body.text.trim(),
                displayText: `📄 ${req.file.originalname}`
            };
        }

        if (!text.trim()) {
            throw new Error("File contains no readable text");
        }

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
