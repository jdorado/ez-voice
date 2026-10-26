// Tools the live model may use on a phone call. GPT-Live has no direct function calling: tools live on its backend
// (Responses delegation), which calls one and waits for the plugin's output. Each tool runs here and returns a plain
// object. Add a tool by adding an entry; nothing else in the bridge changes.
export const DEFAULT_TOOL_MODEL = 'gpt-6.1-sol';
export const DEFAULT_TOOL_EFFORT = 'low';

export const BACKEND_INSTRUCTIONS = 'You are the backend of an audio-only phone call. Your only tool is end_call: call it when the conversation is over or you are asked to hang up. For anything else answer in one short sentence that no backend, tools, private information or actions are connected.';

export const PHONE_TOOLS = {
  end_call: {
    description: 'Hang up the phone call. Use it when the conversation is finished, or once a voicemail message has been left.',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    run: call => call.endSoon(),
  },
};

export const toolDefinitions = () => Object.entries(PHONE_TOOLS).map(([name, {description, parameters}]) => ({type: 'function', name, description, parameters}));
