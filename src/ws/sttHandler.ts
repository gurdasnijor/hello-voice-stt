// ws/sttHandler.ts
import { WebSocket } from 'ws';
import { ListenLiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';

import { deepgram } from '../services/deepGram';
import { generateTTSWithElevenLabs } from '../services/eleven';

export async function handleSttWebSocket(browserWs: WebSocket) {
  console.log('Browser connected on /stt');

  let dgConnection: ListenLiveClient;
  try {
    dgConnection = await deepgram.listen.live({
      model: 'nova',
      punctuate: true,
      endpointing: false,
      interim_results: true,
    });
  } catch (err) {
    console.error('Error creating Deepgram connection:', err);
    browserWs.close(1011, 'Deepgram init failed');
    return;
  }

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram streaming connection opened.');
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('Deepgram streaming error:', err);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log('Deepgram streaming closed.');
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (dgData) => {
    try {
      const alt = dgData.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript = alt.transcript;
      const isFinal = dgData.is_final || false;

      // Send partial/final transcript as JSON
      browserWs.send(JSON.stringify({ transcript, is_final: isFinal }));

      // On final => TTS
      if (isFinal && transcript.trim()) {
        console.log('Final transcript =>', transcript);

        try {
          const ttsData = await generateTTSWithElevenLabs(transcript);
          if (ttsData && browserWs.readyState === browserWs.OPEN) {
            browserWs.send(ttsData);
          }
        } catch (ttsErr) {
          console.error('ElevenLabs TTS error:', ttsErr);
        }
      }
    } catch (err) {
      console.error('Deepgram parse error:', err);
    }
  });

  // Forward browser mic audio to Deepgram
  browserWs.on('message', (audioChunk) => {
    const buffer = Buffer.from(audioChunk as ArrayBuffer);
    dgConnection.send(buffer);
  });

  browserWs.on('close', () => {
    console.log('Browser /stt closed');
    dgConnection.requestClose();
  });
}
