// server.ts
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import axios from 'axios';

import { handleUserMessage } from './agent';

// Pull from env
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP || '192.168.1.100';
const HUE_USERNAME = process.env.HUE_USERNAME || 'test-user';

// Minimal Express
const app = express();
app.use(express.static('public')); // serve index.html
const server = http.createServer(app);

// Create a WSS at /stt
const wss = new WebSocketServer({ server, path: '/stt' });

wss.on('connection', (clientWs) => {
  console.log('Client connected to /stt');

  // 1) Open streaming WS to Deepgram
  // auto-detect webm/opus, use "?punctuate=true" only
  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true';
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
  });

  dgSocket.on('open', () => {
    console.log('Deepgram websocket opened.');
  });

  dgSocket.on('message', async (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
  
      // console.log("Deepgram message =>", msg);
      // console.log("Deepgram alt =>", alt);
  
      // partial
      if (alt.transcript && !msg.is_final) {
        clientWs.send(JSON.stringify({ transcript: alt.transcript, is_final: false }));
      }
  
      // final
      if (alt.transcript && msg.is_final) {
        clientWs.send(JSON.stringify({ transcript: alt.transcript, is_final: true }));
        onFinalTranscript(alt.transcript);
      }
    } catch (err) {
      console.error('Deepgram parse error:', err);
    }
  });
  

  dgSocket.on('close', () => console.log('Deepgram WS closed.'));
  dgSocket.on('error', (err) => console.error('DG WS error:', err));

  // 2) Inbound audio from browser => forward to Deepgram
  clientWs.on('message', (chunk) => {
    // chunk is an ArrayBuffer with ~webm/opus
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(chunk);
    }
  });

  clientWs.on('close', () => {
    if (dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

/** When we get a final transcript, call the LLM agent. */
async function onFinalTranscript(txt: string) {
  console.log("Final transcript =>", txt);
  const result = await handleUserMessage(txt);

  if (result.type === "text") {
    console.log("LLM text:", result.content);
    // If you want, TTS it or do something else
  }
  else if (result.type === "function_call") {
    console.log("LLM wants function:", result.name, result.arguments);
    if (result.name === "setHueLights") {
      setHueLights(result.arguments);
    }
    // else if we had more functions
  }
}

/** Demo function: setHueLights */
async function setHueLights(args: { room: string; on: boolean; color?: string }) {
  console.log("setHueLights called with =>", args);
  // We'll do a naive approach: if room= 'living' => light ID=1, etc.
  const lightId = pickLightId(args.room);
  const hueState: any = { on: args.on };

  // If color is specified, set a hue + full brightness
  if (args.on && args.color) {
    hueState.hue = colorToHue(args.color);
    hueState.bri = 254;
  }

  try {
    const url = `http://${HUE_BRIDGE_IP}/api/${HUE_USERNAME}/lights/${lightId}/state`;
    const resp = await axios.put(url, hueState);
    console.log("Hue response =>", resp.data);
  } catch (err) {
    console.error("Hue set error:", err);
  }
}

// naive mapping from room => ID
function pickLightId(room: string) {
  if (room.includes('living')) return 1;
  if (room.includes('bed')) return 2;
  return 3;
}

// map color => hue param
function colorToHue(color: string) {
  const c = color.toLowerCase();
  if (c.includes('red')) return 0;
  if (c.includes('blue')) return 46920;
  if (c.includes('purple')) return 56100;
  return 8402; // default warm
}
