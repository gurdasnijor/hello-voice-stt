/* server.ts */
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { Configuration, OpenAIApi } from 'openai';

// Load API keys from .env
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || '';

const PORT = Number(process.env.PORT || 3000);

// OpenAI setup
const openaiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openaiClient = new OpenAIApi(openaiConfig);

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stt' });

wss.on('connection', (clientWs) => {
  console.log('Client connected to /stt');

  // Replaces ?punctuate=true with the following:
  const dgUrl = "wss://api.deepgram.com/v1/listen?punctuate=true&endpointing=false";

  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgSocket.on('open', () => console.log('Deepgram websocket opened.'));
  dgSocket.on('error', (err) => console.error('Deepgram WS error:', err));
  dgSocket.on('close', () => console.log('Deepgram WS closed.'));

  // Receiving partial + final transcripts from Deepgram
  dgSocket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      if (!alt.transcript) return;

      const isFinal = msg.is_final || false;
      const transcript = alt.transcript;

      // 1) Send partial/final transcript to browser
      clientWs.send(JSON.stringify({ transcript, is_final: isFinal }));

      // 2) If final transcript => call LLM => TTS => send
      if (isFinal && transcript.trim() !== '') {
        await onFinalTranscript(transcript, clientWs);
      }
    } catch (err) {
      console.error('Deepgram parse error:', err);
    }
  });

  // Data from browser => forward to deepgram
  clientWs.on('message', (chunk) => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(chunk);
    }
  });

  clientWs.on('close', () => {
    if (dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
  });
});

// Final transcript => LLM => TTS => back to user
async function onFinalTranscript(text: string, clientWs: WebSocket) {
  console.log("Final transcript =>", text);

  // 1) Call OpenAI
  let llmText = "";
  try {
    const chatRes = await openaiClient.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a helpful home assistant. Provide short, concise answers.`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.2,
    });

    const choices = chatRes.data.choices;
    if (choices && choices[0]?.message?.content) {
      llmText = choices[0].message.content.trim();
    } else {
      llmText = "No response from LLM.";
    }
  } catch (err) {
    console.error("OpenAI error:", err);
    llmText = "Error from LLM.";
  }

  console.log("LLM text:", llmText);

  // 2) Send LLM text in JSON form so user can see
  clientWs.send(JSON.stringify({ llmResponse: llmText }));

  // 3) Convert LLM text to speech with ElevenLabs
  try {
    const ttsAudio = await generateTTSWithElevenLabs(llmText);
    // If successful, send MP3 buffer to client
    if (ttsAudio) {
      // We can just send raw binary. The client needs to interpret as MP3 arraybuffer
      clientWs.send(ttsAudio);
    }
  } catch (err) {
    console.error("ElevenLabs TTS error:", err);
  }
}

/** 
 * Calls ElevenLabs TTS to convert text -> MP3 (Buffer).
 */
async function generateTTSWithElevenLabs(text: string): Promise<Buffer | null> {
  if (!text.trim()) return null;
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const resp = await axios.post(url,
      { text },
      {
        headers: {
          'xi-api-key': ELEVEN_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer' // we want the raw MP3 data
      }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error("generateTTSWithElevenLabs error:", err);
    return null;
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
