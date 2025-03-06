import axios from 'axios';

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || 'Rachel';

/**
 * Generate TTS audio as a Buffer from ElevenLabs
 * 
 * @param text The text to synthesize
 * @returns A Buffer containing the MP3 audio, or null on error
 */
export async function generateTTSWithElevenLabs(text: string): Promise<Buffer | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const resp = await axios.post(
      url,
      { text: trimmed },
      {
        headers: {
          'xi-api-key': ELEVEN_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      },
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error('generateTTSWithElevenLabs error:', err);
    return null;
  }
}
