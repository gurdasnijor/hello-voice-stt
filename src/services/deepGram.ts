import { createClient } from '@deepgram/sdk';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
export const deepgram = createClient(DEEPGRAM_API_KEY);
