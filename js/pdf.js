/**
 * Minimal single-page PDF writer embedding one JPEG full-page image.
 * A4 size in PDF points: 595.28 x 841.89
 */

const A4_PT = { w: 595.28, h: 841.89 };

function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * @param {Blob|Uint8Array} jpegBytes
 * @param {number} imgWidth px
 * @param {number} imgHeight px
 * @returns {Promise<Blob>}
 */
export async function jpegToA4Pdf(jpegBytes, imgWidth, imgHeight) {
  const jpeg =
    jpegBytes instanceof Uint8Array
      ? jpegBytes
      : new Uint8Array(await jpegBytes.arrayBuffer());

  const contentStream = `q\n${A4_PT.w} 0 0 ${A4_PT.h} 0 0 cm\n/Im0 Do\nQ\n`;
  const parts = [];
  const offsets = [0];
  let pos = 0;

  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? ascii(chunk) : chunk;
    parts.push(bytes);
    pos += bytes.length;
  };

  const writeObj = (num, body) => {
    offsets[num] = pos;
    push(`${num} 0 obj\n`);
    push(body);
    if (typeof body === "string" && !body.endsWith("\n")) push("\n");
    push("endobj\n");
  };

  push("%PDF-1.4\n");
  writeObj(1, "<< /Type /Catalog /Pages 2 0 R >>\n");
  writeObj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
  writeObj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PT.w} ${A4_PT.h}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\n`
  );

  offsets[4] = pos;
  push("4 0 obj\n");
  push(`<< /Length ${contentStream.length} >>\nstream\n`);
  push(contentStream);
  push("endstream\nendobj\n");

  offsets[5] = pos;
  push("5 0 obj\n");
  push(
    `<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  push(jpeg);
  push("\nendstream\nendobj\n");

  const xrefPos = pos;
  const maxObj = 5;
  push(`xref\n0 ${maxObj + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= maxObj; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  );

  return new Blob([concat(parts)], { type: "application/pdf" });
}

export { A4_PT };
