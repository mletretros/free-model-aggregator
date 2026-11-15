import { openAIToAnthropicRequest, anthropicToOpenAIResponse, openAIToGeminiRequest, geminiToOpenAIResponse, openAIEventsFromAnthropic } from './lib/wire-extras.ts';
import { openAIToAnthropic, anthropicToOpenAI, anthropicEventsFromOpenAI } from './lib/wire.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function check(message: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${message}`);
  } catch (err) {
    console.error(`FAIL: ${message} - ${(err as Error).message}`);
    process.exit(1);
  }
}

async function run() {
  check("OpenAI request to Anthropic request and back to OpenAI response", () => {
    const openaiReq = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100
    };
    
    // openAIToAnthropicRequest
    const anthropicReq = openAIToAnthropicRequest(openaiReq, "test-model");
    assert(anthropicReq.model === "test-model", "Anthropic request model matches");
    assert(Array.isArray(anthropicReq.messages) && anthropicReq.messages.length === 1, "Anthropic messages array populated");
    
    // anthropicToOpenAIResponse
    const anthropicRes = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    const openaiRes = anthropicToOpenAIResponse(anthropicRes, "test-model");
    
    assert(openaiRes.object === "chat.completion", "Response is chat.completion");
    assert((openaiRes as any).choices[0].message.content === "Hi there", "Content matches");
    assert((openaiRes as any).usage.prompt_tokens === 10, "Usage prompt tokens match");
    assert((openaiRes as any).usage.completion_tokens === 5, "Usage completion tokens match");
    assert((openaiRes as any).usage.total_tokens === 15, "Usage total tokens match");
  });

  check("OpenAI request to Gemini request and back to OpenAI response", () => {
    const openaiReq = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello Gemini" }],
    };
    
    // openAIToGeminiRequest
    const geminiReq = openAIToGeminiRequest(openaiReq, "test-model");
    assert(Array.isArray((geminiReq as any).contents) && (geminiReq as any).contents.length === 1, "Gemini contents populated");
    assert((geminiReq as any).contents[0].parts[0].text === "Hello Gemini", "Gemini text populated");
    
    // geminiToOpenAIResponse
    const geminiRes = {
      candidates: [{
        content: { parts: [{ text: "Hello from Gemini" }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 }
    };
    const openaiRes = geminiToOpenAIResponse(geminiRes, "test-model");
    
    assert(openaiRes.object === "chat.completion", "Response is chat.completion");
    assert((openaiRes as any).choices[0].message.content === "Hello from Gemini", "Content matches");
    assert((openaiRes as any).usage.prompt_tokens === 12, "Usage prompt tokens match");
    assert((openaiRes as any).usage.completion_tokens === 8, "Usage completion tokens match");
    assert((openaiRes as any).usage.total_tokens === 20, "Usage total tokens match");
  });

  await checkStreaming();
}

async function checkStreaming() {
  let passed = true;
  try {
    // We mock an upstream anthropic stream using a ReadableStream
    const anthropicChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","usage":{"input_tokens":25}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streaming"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ];
    
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of anthropicChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    });

    const generator = openAIEventsFromAnthropic(stream, "test-model");
    const events: string[] = [];
    for await (const event of generator) {
      events.push(event);
    }
    
    assert(events.length > 0, "Generated SSE events");
    assert(events.some(e => e.includes('Streaming')), "Contains streaming text");
    assert(events.some(e => e.includes('"prompt_tokens":25')), "Contains input usage");
    assert(events.some(e => e.includes('"completion_tokens":10')), "Contains output usage");
    assert(events[events.length - 1] === 'data: [DONE]\n\n', "Ends with [DONE]");
    console.log(`PASS: Streaming chunk translation produces well-formed SSE lines`);
  } catch (err) {
    console.error(`FAIL: Streaming chunk translation produces well-formed SSE lines - ${(err as Error).message}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
