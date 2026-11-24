import { forwardRef, useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { qrMatrix, qrPath } from '../services/upiQr';

/** A QR code drawn locally from `text` (black on white, with the quiet zone scanners need). `ref` lets the caller export it as a PNG. */
export const UpiQr = forwardRef<Svg, { text: string; size?: number }>(function UpiQr({ text, size = 220 }, ref) {
  const { d, units } = useMemo(() => { const m = qrMatrix(text); return { d: qrPath(m, 4), units: m.size + 8 }; }, [text]);
  return <Svg ref={ref} width={size} height={size} viewBox={`0 0 ${units} ${units}`} accessibilityLabel="Payment QR code">
    <Rect x={0} y={0} width={units} height={units} fill="#FFFFFF" />
    <Path d={d} fill="#000000" />
  </Svg>;
});

/** The QR as PNG base64 (no prefix), rendered at a size that scans well from another phone's screen. */
export function qrToPngBase64(svg: Svg): Promise<string> {
  return new Promise((resolve, reject) => {
    try { (svg as unknown as { toDataURL(cb: (b64: string) => void, o?: { width: number; height: number }): void }).toDataURL((b64) => resolve(b64), { width: 720, height: 720 }); }
    catch (e) { reject(e); }
  });
}
