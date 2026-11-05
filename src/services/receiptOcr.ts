import TextRecognition from '@react-native-ml-kit/text-recognition';

/** On-device OCR (Google ML Kit, runs offline; nothing is sent to a server). Returns null when unavailable or it fails. */
export async function recognizeReceiptText(imageUri: string): Promise<string | null> {
  try {
    const result = await TextRecognition.recognize(imageUri);
    const text = result?.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}
