import { isRecord, type Json } from './providers.ts';
import { sseEvent, anthropicToOpenAI, openAIToAnthropic, anthropicEventsFromOpenAI } from './wire.ts';

// Add stream_options: { include_usage: true } to OpenAI requests if streaming
export function ensureOpenAIUsage(body: Json): Json {
  if (body.stream === true && !body.stream_options) {
    return { ...body, stream_options: { include_usage: true } };
  }
  return body;
}

// ============================================================================
// OPENAI <-> ANTHROPIC WIRE
// ============================================================================

export function openAIToAnthropicRequest(body: Json, model: string): Json {
  // Translate OpenAI Chat Completions to Anthropic Messages
  // Luckily, `openAIToAnthropic` translates the *response*. 
  // We need to translate the *request*. Wait, `anthropicToOpenAI` does Anthropic -> OpenAI.
  // We need OpenAI -> Anthropic.
  const messages: Json[] = [];
  let system = '';
  
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      system += (system ? '\n' : '') + (typeof raw.content === 'string' ? raw.content : '');
      continue;
    }
    
    if (raw.role === 'user' || raw.role === 'assistant') {
      let content: Json[] | string = [];
      if (typeof raw.content === 'string') {
        content = raw.content;
      } else if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (!isRecord(part)) continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
              const mime = url.slice(5, url.indexOf(';'));
              const b64 = url.slice(url.indexOf(',') + 1);
              content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
            } else {
              content.push({ type: 'image', source: { type: 'url', url } });
            }
          }
        }
      }
      
      const message: Json = { role: raw.role, content: content || '' };
      
      if (raw.role === 'assistant' && Array.isArray(raw.tool_calls)) {
        if (typeof content === 'string' && content === '') {
          message.content = [];
        } else if (typeof content === 'string') {
          message.content = [{ type: 'text', text: content }];
        }
        for (const call of raw.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue;
          let input = {};
          try { input = JSON.parse(typeof call.function.arguments === 'string' ? call.function.arguments : '{}'); } catch {}
          (message.content as Json[]).push({
            type: 'tool_use',
            id: typeof call.id === 'string' ? call.id : '',
            name: typeof call.function.name === 'string' ? call.function.name : '',
            input
          });
        }
      }
      messages.push(message);
    } else if (raw.role === 'tool') {
      // Find the last user message to append tool_result, or create a new user message
      let lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'user') {
        lastMsg = { role: 'user', content: [] };
        messages.push(lastMsg);
      }
      if (typeof lastMsg.content === 'string') {
        lastMsg.content = [{ type: 'text', text: lastMsg.content }];
      }
      (lastMsg.content as Json[]).push({
        type: 'tool_result',
        tool_use_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
        content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content)
      });
    }
  }

  const out: Json = { model, messages };
  if (system) out.system = system;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  else out.max_tokens = 4096; // Anthropic requires max_tokens
  
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length > 0) out.stop_sequences = body.stop;
  if (body.stream === true) out.stream = true;
  
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [{
        name: raw.function.name,
        description: typeof raw.function.description === 'string' ? raw.function.description : '',
        input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} }
      }];
    });
  }
  
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required') out.tool_choice = { type: 'any' };
  else if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  
  return out;
}

export function anthropicToOpenAIResponse(body: Json, model: string): Json {
  // Translate Anthropic Messages response to OpenAI Chat Completions response
  const content = Array.isArray(body.content) ? body.content : [];
  let text = '';
  const tool_calls: Json[] = [];
  
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      tool_calls.push({
        id: typeof block.id === 'string' ? block.id : '',
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {})
        }
      });
    }
  }
  
  let finish_reason = 'stop';
  if (body.stop_reason === 'max_tokens') finish_reason = 'length';
  else if (body.stop_reason === 'tool_use') finish_reason = 'tool_calls';
  else if (body.stop_reason === 'refusal') finish_reason = 'content_filter';
  
  const usage = isRecord(body.usage) ? body.usage : {};
  const prompt_tokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const completion_tokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  
  return {
    id: typeof body.id === 'string' ? body.id.replace(/^msg_/, '') : 'chatcmpl-aggregate',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(tool_calls.length > 0 ? { tool_calls } : {})
      },
      finish_reason
    }],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
  };
}

export async function* openAIEventsFromAnthropic(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  let id = 'chatcmpl-stream';
  let toolIndex = 0;
  let prompt_tokens = 0;
  let completion_tokens = 0;
  
  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    let eventName = '';
    let dataPayload = '';
    
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataPayload = line.slice(6).trim();
    }
    
    if (!dataPayload) return out;
    let data: Json;
    try { data = JSON.parse(dataPayload); } catch { return out; }
    
    if (eventName === 'message_start' && isRecord(data.message)) {
      id = typeof data.message.id === 'string' ? data.message.id.replace(/^msg_/, '') : id;
      if (isRecord(data.message.usage) && typeof data.message.usage.input_tokens === 'number') {
        prompt_tokens = data.message.usage.input_tokens;
      }
      out.push(sseEvent(null, {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
      }));
    } else if (eventName === 'content_block_start' && isRecord(data.content_block)) {
      const block = data.content_block;
      if (block.type === 'tool_use') {
        out.push(sseEvent(null, {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }]
        }));
      }
    } else if (eventName === 'content_block_delta' && isRecord(data.delta)) {
      if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
        out.push(sseEvent(null, {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }]
        }));
      } else if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
        out.push(sseEvent(null, {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: data.delta.partial_json } }] }, finish_reason: null }]
        }));
      }
    } else if (eventName === 'content_block_stop') {
      toolIndex++;
    } else if (eventName === 'message_delta' && isRecord(data.delta)) {
      let finish_reason = 'stop';
      if (data.delta.stop_reason === 'max_tokens') finish_reason = 'length';
      else if (data.delta.stop_reason === 'tool_use') finish_reason = 'tool_calls';
      else if (data.delta.stop_reason === 'refusal') finish_reason = 'content_filter';
      
      if (isRecord(data.usage) && typeof data.usage.output_tokens === 'number') {
        completion_tokens = data.usage.output_tokens;
      }
      
      out.push(sseEvent(null, {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason }]
      }));
      // OpenAI usage chunk
      out.push(sseEvent(null, {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [], usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
      }));
    }
    
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const event of eventsOfFrame(frame)) yield event;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally {
    reader.releaseLock();
  }
  yield 'data: [DONE]\n\n';
}

// ============================================================================
// OPENAI <-> GEMINI WIRE
// ============================================================================

export function openAIToGeminiRequest(body: Json, model: string): Json {
  const contents: Json[] = [];
  let system_instruction: Json | undefined;
  
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      system_instruction = { parts: [{ text: typeof raw.content === 'string' ? raw.content : '' }] };
      continue;
    }
    
    let role = raw.role === 'assistant' ? 'model' : 'user';
    const parts: Json[] = [];
    
    if (typeof raw.content === 'string') {
      parts.push({ text: raw.content });
    } else if (Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const url = part.image_url.url;
          if (url.startsWith('data:')) {
            const mime = url.slice(5, url.indexOf(';'));
            const b64 = url.slice(url.indexOf(',') + 1);
            parts.push({ inlineData: { mimeType: mime, data: b64 } });
          } else {
            // Gemini doesn't support generic URLs easily in this API format without file API, but we'll try inlineData if possible or just ignore.
          }
        }
      }
    }
    
    if (raw.role === 'assistant' && Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        let args = {};
        try { args = JSON.parse(typeof call.function.arguments === 'string' ? call.function.arguments : '{}'); } catch {}
        parts.push({ functionCall: { name: typeof call.function.name === 'string' ? call.function.name : '', args } });
      }
    }
    
    if (raw.role === 'tool') {
      role = 'user'; // tool responses go as user in Gemini
      let response = {};
      try { response = JSON.parse(typeof raw.content === 'string' ? raw.content : '{}'); } catch { response = { text: raw.content }; }
      parts.push({ functionResponse: { name: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '', response } });
    }
    
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  const out: Json = { contents };
  if (system_instruction) out.systemInstruction = system_instruction;
  
  const generationConfig: Json = {};
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop;
  if (isRecord(body.response_format) && body.response_format.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;
  
  if (Array.isArray(body.tools)) {
    const functionDeclarations = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [{
        name: raw.function.name,
        description: typeof raw.function.description === 'string' ? raw.function.description : '',
        parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'OBJECT', properties: {} }
      }];
    });
    if (functionDeclarations.length > 0) out.tools = [{ functionDeclarations }];
  }
  
  // No strict tool_choice mapping for Gemini here, fallback to auto
  return out;
}

export function geminiToOpenAIResponse(body: Json, model: string): Json {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  
  let text = '';
  const tool_calls: Json[] = [];
  
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') {
      text += part.text;
    } else if (isRecord(part.functionCall)) {
      const call = part.functionCall;
      tool_calls.push({
        id: `call_${Math.random().toString(36).substring(2, 9)}`,
        type: 'function',
        function: {
          name: typeof call.name === 'string' ? call.name : '',
          arguments: JSON.stringify(isRecord(call.args) ? call.args : {})
        }
      });
    }
  }
  
  let finish_reason = 'stop';
  const reason = candidate.finishReason;
  if (reason === 'MAX_TOKENS') finish_reason = 'length';
  else if (reason === 'SAFETY') finish_reason = 'content_filter';
  if (tool_calls.length > 0) finish_reason = 'tool_calls';
  
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  const prompt_tokens = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
  const completion_tokens = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
  
  return {
    id: `chatcmpl-${Math.random().toString(36).substring(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(tool_calls.length > 0 ? { tool_calls } : {})
      },
      finish_reason
    }],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
  };
}

export async function* openAIEventsFromGemini(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  // Gemini streaming response is usually an array of JSON objects (not SSE)
  // `[{...}, {...}]` or sent chunk by chunk. Actually it's `data: {...}` sometimes.
  // Assuming standard SSE stream format for Gemini streamGenerateContent: "data: {...}"
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const id = `chatcmpl-${Math.random().toString(36).substring(2, 9)}`;
  let prompt_tokens = 0;
  let completion_tokens = 0;
  
  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    if (!frame.startsWith('data: ')) return out;
    const payload = frame.slice(6).trim();
    if (!payload || payload === '[DONE]') return out;
    
    let chunk: Json;
    try { chunk = JSON.parse(payload); } catch { return out; }
    
    if (isRecord(chunk.usageMetadata)) {
      prompt_tokens = typeof chunk.usageMetadata.promptTokenCount === 'number' ? chunk.usageMetadata.promptTokenCount : prompt_tokens;
      completion_tokens = typeof chunk.usageMetadata.candidatesTokenCount === 'number' ? chunk.usageMetadata.candidatesTokenCount : completion_tokens;
    }
    
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    const candidate = isRecord(candidates[0]) ? candidates[0] : null;
    if (!candidate) return out;
    
    const content = isRecord(candidate.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string') {
        out.push(sseEvent(null, {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }]
        }));
      } else if (isRecord(part.functionCall)) {
        const call = part.functionCall;
        out.push(sseEvent(null, {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).substring(2, 9)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }]
        }));
      }
    }
    
    if (candidate.finishReason) {
      let finish_reason = 'stop';
      if (candidate.finishReason === 'MAX_TOKENS') finish_reason = 'length';
      else if (candidate.finishReason === 'SAFETY') finish_reason = 'content_filter';
      out.push(sseEvent(null, {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason }]
      }));
      out.push(sseEvent(null, {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [], usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
      }));
    }
    
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const event of eventsOfFrame(frame)) yield event;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally {
    reader.releaseLock();
  }
  yield 'data: [DONE]\n\n';
}