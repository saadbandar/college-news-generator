import { AlignmentType, Document, ImageRun, Packer, Paragraph, TextRun } from "docx";

const TEAL_DARK = "3C7974";
const GRAY = "898B8E";

function run(text, lang, opts = {}) {
  return new TextRun({ text, font: "Cairo", rightToLeft: lang === "ar", ...opts });
}

function para(lang, children, opts = {}) {
  return new Paragraph({
    bidirectional: lang === "ar",
    alignment: lang === "ar" ? AlignmentType.RIGHT : AlignmentType.LEFT,
    ...opts,
    children,
  });
}

function bodyParagraphs(text, lang) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((p) =>
      para(lang, [run(p, lang, { size: 24, color: "222222" })], {
        alignment: AlignmentType.BOTH,
        spacing: { after: 200, line: 400 },
      }),
    );
}

export async function buildNewsDocx({ lang, title, body, altText, image }) {
  const isAr = lang === "ar";
  const children = [
    para(lang, [run(title, lang, { bold: true, size: 36, color: TEAL_DARK })], { spacing: { after: 320 } }),
    ...bodyParagraphs(body, lang),
  ];

  if (image?.data) {
    const w = image.width || 800;
    const h = image.height || 600;
    const scale = Math.min(1, 560 / w);
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 80 },
        children: [
          new ImageRun({
            type: image.type === "image/png" ? "png" : "jpg",
            data: Buffer.from(image.data, "base64"),
            transformation: { width: Math.round(w * scale), height: Math.round(h * scale) },
            altText: { title: "", description: altText || "", name: "news-image" },
          }),
        ],
      }),
    );
    if (altText) {
      children.push(
        para(lang, [run(altText, lang, { size: 20, color: GRAY, italics: true })], {
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }),
      );
    }
  }

  const doc = new Document({
    title,
    styles: { default: { document: { run: { font: "Cairo", size: 24, rightToLeft: isAr } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
