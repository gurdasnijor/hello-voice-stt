import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';
import { handleSttWebSocket } from './ws/sttHandler';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/stt' });
wss.on('connection', (browserWs) => {
  handleSttWebSocket(browserWs);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Use WS => /stt for local mic => Deepgram => TTS (ElevenLabs) flow`);
});
