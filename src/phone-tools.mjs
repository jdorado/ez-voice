// Tools the live model may use on a phone call. With GPT-Live there is no direct function calling: tools live on its backend
// (Responses delegation), which calls one and waits for the plugin's output. Each tool runs here and returns a plain
// object. Add a tool by adding an entry; nothing else in the bridge changes.
export const DEFAULT_TOOL_MODEL = 'gpt-6.1-sol';
export const DEFAULT_TOOL_EFFORT = 'low';

export const BACKEND_INSTRUCTIONS = 'You are the backend of an audio-only phone call. Your only tool is end_call: call it when the conversation is over or you are asked to hang up. For anything else answer in one short sentence that no backend, tools, private information or actions are connected.';
export const LOOKUP_BACKEND_INSTRUCTIONS = 'You are the backend of an audio-only phone call. Your tools are end_call (call it when the conversation is over or you are asked to hang up) and find_case (call it with the property address a caller names, to learn whether a conversation with them is on record). For anything else answer in one short sentence that no backend, other tools, private information or actions are connected.';
export const backendInstructions = config => config.lookup ? LOOKUP_BACKEND_INSTRUCTIONS : BACKEND_INSTRUCTIONS;

export const PHONE_TOOLS = {
  // `final`: the call ends after this tool, so a provider that calls tools natively need not ask the model to keep talking
  // (a live call showed a second goodbye three seconds after the first when it was asked to).
  end_call: {
    final: true,
    description: 'Hang up the phone call. Use it when the conversation is finished, or once a voicemail message has been left.',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    run: call => call.endSoon(),
  },
  // Only on an inbound call whose caller's number was not recognised (a caller who says they ring from another number): the
  // property address they name, looked up in the prepared contexts. It answers with the little a stranger may be told.
  find_case: {
    lookup: true,
    description: 'Find out whether we have a conversation on record about the property address the caller names. Pass the address as the caller said it (house number and street). Use it at most a few times.',
    parameters: {type: 'object', properties: {query: {type: 'string', description: 'the property address the caller named, with the house number'}}, required: ['query'], additionalProperties: false},
    run: (call, args) => call.lookup(args?.query),
  },
};

// A call declares find_case only when it can look cases up (`config.lookup`).
export const toolDefinitions = (config = {}) => Object.entries(PHONE_TOOLS).filter(([, tool]) => !tool.lookup || config.lookup)
  .map(([name, {description, parameters}]) => ({type: 'function', name, description, parameters}));
