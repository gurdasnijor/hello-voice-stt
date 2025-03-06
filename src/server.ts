/* server.ts */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { Configuration, OpenAIApi } from 'openai';

import bodyParser from 'body-parser';
import twilio, { twiml } from 'twilio';

/************************************************************
 * 1) ENV & Setup
 ************************************************************/
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const ELEVEN_API_KEY   = process.env.ELEVEN_API_KEY   || '';
const ELEVEN_VOICE_ID  = process.env.ELEVEN_VOICE_ID  || '';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || '';

const PUBLIC_HOST = process.env.PUBLIC_HOST || 'example-ngrok.ngrok-free.app';
const PORT = Number(process.env.PORT || 3000);

// OpenAI
const openaiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openaiClient = new OpenAIApi(openaiConfig);

/************************************************************
 * 2) Express + HTTP Server
 ************************************************************/
const app = express();

// Twilio webhooks, e.g. /outbound-voice
app.use(bodyParser.urlencoded({ extended: false }));

// Serve static from 'public' (for local mic example)
app.use(express.static('public'));

const server = http.createServer(app);

/************************************************************
 * 3) LOCAL MIC WSS at /stt (OK to use path in constructor)
 ************************************************************/
const wssBrowser = new WebSocketServer({ server, path: '/stt' });

wssBrowser.on('connection', (clientWs) => {
  console.log('Browser connected on /stt');

  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true&endpointing=false';
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgSocket.on('open',  () => console.log('Deepgram WS (local mic) opened'));
  dgSocket.on('error', (err) => console.error('Deepgram WS error (local mic):', err));
  dgSocket.on('close', () => console.log('Deepgram WS (local mic) closed'));

  dgSocket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript = alt.transcript;
      const isFinal    = msg.is_final || false;

      // Send partial/final to browser
      clientWs.send(JSON.stringify({ transcript, is_final: isFinal }));

      // If final => LLM => TTS => back to browser
      if (isFinal && transcript.trim()) {
        await onFinalTranscript(transcript, clientWs);
      }
    } catch (err) {
      console.error('Deepgram parse error (local mic):', err);
    }
  });

  // Browser mic data => forward to Deepgram
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

/************************************************************
 * 4) onFinalTranscript => LLM => TTS
 *    (Used by local mic, partially for Twilio)
 ************************************************************/
async function onFinalTranscript(text: string, clientWs: WebSocket) {
  console.log('Final transcript =>', text);

  // 1) LLM
  let llmText = '';
  try {
    const chatRes = await openaiClient.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful home assistant. Provide short, concise answers.'
        },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
    });
    const choice = chatRes.data.choices?.[0]?.message?.content;
    llmText = choice ? choice.trim() : 'No response from LLM.';
  } catch (err) {
    console.error('OpenAI error:', err);
    llmText = 'Error from LLM.';
  }

  console.log('LLM text:', llmText);

  // 2) Send LLM text so the client can display
  clientWs.send(JSON.stringify({ llmResponse: llmText }));

  // 3) TTS => raw MP3 => client
  try {
    const ttsAudio = await generateTTSWithElevenLabs(llmText);
    if (ttsAudio) {
      // For local mic usage, we can send binary
      clientWs.send(ttsAudio);
    }
  } catch (err) {
    console.error('ElevenLabs TTS error:', err);
  }
}

async function generateTTSWithElevenLabs(text: string): Promise<Buffer | null> {
  if (!text.trim()) return null;
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const resp = await axios.post(
      url,
      { text },
      {
        headers: {
          'xi-api-key': ELEVEN_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error('generateTTSWithElevenLabs error:', err);
    return null;
  }
}

/************************************************************
 * 5) TWILIO Outbound => /call => /outbound-voice => <Connect><Stream>
 ************************************************************/
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/** GET /call?to=+15550123456 => place call, Twilio calls /outbound-voice */
app.get('/call', async (req: Request, res: Response) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_CALLER_ID) {
    res.status(500).send('Missing Twilio credentials');
    return;
  }

  const { to } = req.query;
  if (!to) {
    res.status(400).send('Must provide ?to=+E164Number');
    return;
  }

  try {
    const call = await twilioClient.calls.create({
      to: String(to),
      from: TWILIO_CALLER_ID,
      url: `https://${PUBLIC_HOST}/outbound-voice`,
    });
    console.log(`Dialing ${to} => Call SID: ${call.sid}`);
    res.send(`Dialing ${to}, Call SID: ${call.sid}`);
  } catch (err) {
    console.error('Error placing call:', err);
    res.status(500).send('Failed to dial.');
  }
});

/** Twilio fetches /outbound-voice => we return <Connect><Stream track="inbound_track"> */
app.post('/outbound-voice', (req, res) => {
  const response = new twiml.VoiceResponse();
  const connect  = response.connect({});

  // "inbound_track" is the only track your Twilio environment allows
  connect.stream({
    url: `wss://${PUBLIC_HOST}/twilio-audio`,
    track: 'inbound_track',
  });

  res.type('text/xml');
  res.send(response.toString());
});

/************************************************************
 * 6) TWILIO WSS: "noServer" + Manual Upgrade on /twilio-audio
 ************************************************************/

// We'll store call sessions in an object keyed by callSid
interface CallSession {
  dgSocket: WebSocket;
  callSid: string;
}
const callSessions: Record<string, CallSession> = {};

const wssTwilio = new WebSocketServer({ noServer: true });

wssTwilio.on('connection', (ws, request) => {
  console.log('Twilio connected to /twilio-audio via manual upgrade');

  // Start a new Deepgram STT connection
  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true&interim_results=true';
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  let callSid: string | null = null;

  dgSocket.on('open',  () => console.log('Deepgram STT (Twilio) opened'));
  dgSocket.on('error', (err) => console.error('Deepgram (Twilio) error:', err));
  dgSocket.on('close', () => console.log('Deepgram STT (Twilio) closed'));

  // Receiving transcripts from Deepgram
  dgSocket.on('message', async (raw) => {
    try {
      const dgMsg = JSON.parse(raw.toString());
      const alt = dgMsg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript = alt.transcript;
      const isFinal    = dgMsg.is_final || false;

      if (transcript) {
        console.log(`[Twilio:${callSid}] =>`, transcript, isFinal ? '(final)' : '');
      }

      // If final => LLM => TTS => "fake" playback
      if (isFinal && transcript.trim()) {
        const fakeWs = {
          send: (data: any) => {
            if (typeof data === 'string') {
              console.log('FAKE WS SEND =>', data);
            } else {
              console.log(`FAKE WS SEND => [binary len=${data?.length}]`);
            }
          },
        } as unknown as WebSocket;

        await onFinalTranscript(transcript, fakeWs);
      }
    } catch (err) {
      console.error('Deepgram parse error (Twilio):', err);
    }
  });

  // Twilio => This server => Deepgram
  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        if (callSid) {
          callSessions[callSid] = { dgSocket, callSid };
          console.log(`Twilio call started, SID=${callSid}`);
        }
      } else if (msg.event === 'media') {
        if (dgSocket.readyState === WebSocket.OPEN) {
          const b64Audio = msg.media.payload;
          const audioBuff = Buffer.from(b64Audio, 'base64');
          dgSocket.send(audioBuff);
        }
      } else if (msg.event === 'stop') {
        console.log(`Twilio call stopped, SID=${callSid}`);
        if (callSid && callSessions[callSid]) {
          delete callSessions[callSid];
        }
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.close();
        }
      }
    } catch (err) {
      console.error('Invalid JSON from Twilio MediaStream:', err);
    }
  });

  ws.on('close', () => {
    console.log('Twilio /twilio-audio WS closed');
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.close();
    }
  });
});

/************************************************************
 * 7) The critical "upgrade" event => if (req.url?.startsWith('/twilio-audio'))
 ************************************************************/
server.on('upgrade', (req, socket, head) => {
  console.log('UPGRADE EVENT =>', req.url);

  // Twilio or wscat might do /twilio-audio?TrackId=XYZ 
  if (req.url?.startsWith('/twilio-audio')) {
    wssTwilio.handleUpgrade(req, socket, head, (ws) => {
      wssTwilio.emit('connection', ws, req);
    });
  } else {
    // For any other upgrade request, we send 400
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  }
});

/************************************************************
 * 8) Start the Server
 ************************************************************/
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
