import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // ✅ NOW THIS WORKS

const pdfPath = path.resolve("./sample.pdf");

async function testPdf() {
    try {
        console.log("📄 Reading:", pdfPath);

        const buffer = fs.readFileSync(pdfPath);
        const data = await pdfParse(buffer);

        console.log("✅ PDF parsed successfully!");
        console.log("----- TEXT START -----");
        console.log(data.text.slice(0, 1000));
        console.log("----- TEXT END -----");

    } catch (err) {
        console.error("❌ PDF parsing failed:");
        console.error(err);
    }
}

testPdf();
