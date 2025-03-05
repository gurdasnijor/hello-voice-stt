/* server.ts */
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Configuration, OpenAIApi } from 'openai';

// 1) Load API keys + config from env
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PORT = Number(process.env.PORT || 3000);

// Basic config for OpenAI
const openaiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openaiClient = new OpenAIApi(openaiConfig);

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stt' });

wss.on('connection', (clientWs) => {
  console.log('Client connected to /stt');

  // Connect to Deepgram STT
  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true';
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgSocket.on('open', () => {
    console.log('Deepgram websocket opened.');
  });

  dgSocket.on('error', (err) => {
    console.error('Deepgram WS error:', err);
  });

  dgSocket.on('close', () => {
    console.log('Deepgram WS closed.');
  });

  // Forward partial + final transcripts from deepgram => browser => LLM
  dgSocket.on('message', async (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      // top-level 'is_final' property indicates final or partial
      const isFinal = msg.is_final || false;

      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript = alt.transcript;

      // Send partial/final transcript to browser
      clientWs.send(
        JSON.stringify({
          transcript,
          is_final: isFinal,
        })
      );

      // If final transcript, call openAI
      if (isFinal && transcript.trim() !== '') {
        await onFinalTranscript(transcript, clientWs);
      }
    } catch (err) {
      console.error('Deepgram parse error:', err);
    }
  });

  // Data from browser => send to deepgram
  clientWs.on('message', (chunk) => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(chunk);
    }
  });

  clientWs.on('close', () => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.close();
    }
  });
});

// Minimal “LLM agent” once we get final text
async function onFinalTranscript(text: string, clientWs: WebSocket) {
  console.log("Final transcript =>", text);

  let llmText = "";
  try {
    const chatRes = await openaiClient.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `
You are a helpful home assistant. 
You can chat about anything. 
If user wants to control lights, you'd do a function call, otherwise just reply with text.
        `,
        },
        { role: "user", content: text },
      ],
      temperature: 0.2,
    });

    // Parse response
    const choices = chatRes.data.choices || [];
    if (choices.length === 0 || !choices[0].message) {
      llmText = "No response from LLM.";
    } else {
      const content = choices[0].message.content || "";
      llmText = content.trim() || "LLM gave an empty response.";
    }
  } catch (err) {
    console.error("OpenAI error:", err);
    llmText = "Error from LLM.";
  }

  console.log("LLM text:", llmText);

  // Send LLM text back to client
  clientWs.send(JSON.stringify({ llmResponse: llmText }));
}

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
