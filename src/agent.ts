// agent.ts
import { Configuration, OpenAIApi, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum } from 'openai';

const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);

// We define a single function "setHueLights" for demonstration
// You could add more (fetchWeather, setThermostat, etc.)
const HOME_FUNCTIONS = [
  {
    name: "setHueLights",
    description: "Turn on/off or set color of a certain room's lights",
    parameters: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Which room, e.g. 'living', 'bedroom', 'kitchen'"
        },
        on: {
          type: "boolean",
          description: "true to turn lights on, false to turn lights off"
        },
        color: {
          type: "string",
          description: "Optional color name (e.g. 'red', 'blue', 'white'). Defaults to white"
        }
      },
      required: ["room","on"]
    }
  }
];

/**
 * High-level call to OpenAI with function calling.
 */
export async function handleUserMessage(userText: string) {
  // Our chat context: system prompt, user
  const messages: ChatCompletionRequestMessage[] = [
    {
      role: ChatCompletionRequestMessageRoleEnum.System,
      content: `
You are a helpful home assistant. 
You can call the function setHueLights when a user wants to control lights. 
If they only want info or a chat, reply in text.
`
    },
    {
      role: ChatCompletionRequestMessageRoleEnum.User,
      content: userText
    }
  ];

  try {
    const resp = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",  // or "gpt-4-0613"
      messages,
      functions: HOME_FUNCTIONS,
      function_call: "auto",
      temperature: 0.2
    });

    const choice = resp.data.choices?.[0];
    if (!choice) {
      return { type: "text", content: "No response from LLM." };
    }

    const msg = choice.message;
    if (!msg) {
      return { type: "text", content: "Empty LLM response." };
    }

    // If LLM calls a function
    if (msg.function_call) {
      return {
        type: "function_call",
        name: msg.function_call.name,
        // parse arguments
        arguments: safeJsonParse(msg.function_call.arguments || "{}")
      };
    }

    // Otherwise normal text
    return { type: "text", content: msg.content || "" };

  } catch (err) {
    console.error("OpenAI error:", err);
    return { type: "text", content: "Error from LLM." };
  }
}

function safeJsonParse(jsonString: string) {
  try {
    return JSON.parse(jsonString);
  } catch(e) {
    console.error("JSON parse error:", e);
    return {};
  }
}
