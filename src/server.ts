import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import * as path from 'path';
import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

const PORT = process.env.PORT || 3000;
const app = express();

// Serve static files from 'public'
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stt' });

wss.on('connection', (clientWs) => {
  console.log('Client connected to /stt WebSocket');

  // 1) Open a streaming WS to Deepgram
  // The query params can set the sample_rate, encoding, etc.
  // const dgWsUrl = `wss://api.deepgram.com/v1/listen?encoding=opus&punctuate=true`;
  const dgWsUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true';

  const dgSocket = new WebSocket(dgWsUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  // Handle messages from Deepgram => forward partial transcripts to the client
  dgSocket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const channel = msg.channel;
      if (!channel) return;
      const alt = channel.alternatives?.[0];
      if (!alt) return;

      // For partial transcripts: alt.transcript & !alt.is_final
      // For final transcripts: alt.transcript & alt.is_final
      if (alt.transcript) {
        // Example: forward the entire JSON or just the text
        const transcriptData = {
          transcript: alt.transcript,
          is_final: alt.is_final || false,
        };
        clientWs.send(JSON.stringify(transcriptData));
      }
    } catch (err) {
      console.error('Error parsing Deepgram msg:', err);
    }
  });

  dgSocket.on('error', (err) => {
    console.error('Deepgram WS error:', err);
  });
  dgSocket.on('close', () => {
    console.log('Deepgram connection closed');
  });

  // 2) For inbound audio from the client => forward to Deepgram
  clientWs.on('message', (chunkData) => {
    // chunkData is an ArrayBuffer/Buffer with OPUS frames from the MediaRecorder
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(chunkData);
    }
  });

  // Clean up if client disconnects
  clientWs.on('close', () => {
    console.log('Client disconnected');
    if (dgSocket.readyState === WebSocket.OPEN || dgSocket.readyState === WebSocket.CONNECTING) {
      dgSocket.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
