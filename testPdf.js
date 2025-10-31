const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js"); // ✅ works in Node

(async () => {
  try {
    const data = new Uint8Array(fs.readFileSync("sample.pdf"));
    const pdf = await pdfjsLib.getDocument({ data }).promise;

    let text = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      text += pageText + "\n";
    }

    fs.writeFileSync("output.txt", text);
    console.log("✅ Text saved to output.txt");
  } catch (err) {
    console.error("❌ PDF parsing failed:", err);
  }
})();
