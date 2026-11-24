/** The QR matrix for a payment link, computed on the device (qrcode, pure JS). Nothing is sent anywhere. */
import QRCode from 'qrcode';

export interface QrMatrix { size: number; /** modules[row][col] is true for a dark module */ modules: boolean[][] }

export function qrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const modules: boolean[][] = [];
  for (let r = 0; r < size; r++) { const row: boolean[] = []; for (let c = 0; c < size; c++) row.push(!!qr.modules.get(r, c)); modules.push(row); }
  return { size, modules };
}

/** One SVG path for all dark modules, in module units (each module is 1x1) and shifted by the quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.modules[r][c]) { c++; continue; }
      let end = c; while (end < m.size && m.modules[r][end]) end++;
      parts.push(`M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  }
  return parts.join('');
}
